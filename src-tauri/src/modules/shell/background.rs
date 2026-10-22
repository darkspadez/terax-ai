use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const RING_CAP: usize = 4 * 1024 * 1024;
const THREAD_STACK: usize = 128 * 1024;

fn spawn_thread(name: &str, work: impl FnOnce() + Send + 'static) -> Result<(), String> {
    thread::Builder::new()
        .name(name.into())
        .stack_size(THREAD_STACK)
        .spawn(work)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn pump(mut pipe: impl Read, proc: &BackgroundProc) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => proc.buffer.lock().unwrap().push(&buf[..n]),
        }
    }
}

pub struct BackgroundProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Arc<SharedChild>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
    /// Holds the process tree: closing it kills everything still inside.
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = self.buffer.lock().unwrap().read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }

    /// Stops the process with everything it started: a dev server's shell
    /// alone would leave the server running and holding its port. On Unix the
    /// process leads its own group, which gets SIGTERM and, after
    /// `TERM_GRACE`, SIGKILL; on Windows its job is closed.
    pub fn kill(&self) {
        // Once reaped, the leader's id may name another process's group.
        #[cfg(unix)]
        if !self.exited.load(Ordering::Acquire) {
            use crate::modules::proc::capture::TERM_GRACE;
            let group = self.child.id() as libc::pid_t;
            // SAFETY: plain syscalls on the group this process leads; the
            // leader is not reaped before the wait below returns, and a group
            // id is not reused while any member lives.
            unsafe { libc::killpg(group, libc::SIGTERM) };
            let child = self.child.clone();
            let escalate = move || {
                let _ = child.wait_timeout(TERM_GRACE);
                unsafe { libc::killpg(group, libc::SIGKILL) };
            };
            if spawn_thread("terax-bg-kill", escalate).is_err() {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
            return;
        }
        #[cfg(windows)]
        drop(self.job.lock().unwrap().take());
        let _ = self.child.kill();
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !resolve_path(dir, &workspace).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let mut cmd = super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(ref dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(shared.id()) {
        Ok(job) => Some(job),
        Err(e) => {
            log::warn!("background job-object setup failed: {e}");
            None
        }
    };
    let kill_on_fail = || {
        let _ = shared.kill();
    };
    let stdout_pipe = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr_pipe = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;
    let child = shared;

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        #[cfg(windows)]
        job: Mutex::new(job),
    });

    let fail = |error: String| {
        proc.kill();
        error
    };
    for (name, pipe) in [
        (
            "terax-bg-out",
            Box::new(stdout_pipe) as Box<dyn Read + Send>,
        ),
        (
            "terax-bg-err",
            Box::new(stderr_pipe) as Box<dyn Read + Send>,
        ),
    ] {
        let proc_ref = proc.clone();
        spawn_thread(name, move || pump(pipe, &proc_ref)).map_err(fail)?;
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        spawn_thread("terax-bg-wait", move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
        })
        .map_err(fail)?;
    }

    Ok(proc)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait_for_exit(proc: &BackgroundProc) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !proc.exited.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "the process outlived kill");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_takes_what_the_process_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let script = format!(
            "(trap '' TERM; sleep 1; touch '{}') & wait",
            marker.display()
        );
        let proc = spawn(script, None, WorkspaceEnv::Local).unwrap();
        thread::sleep(Duration::from_millis(200));
        proc.kill();
        wait_for_exit(&proc);
        thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a grandchild outlived kill");
    }

    #[test]
    fn kill_gives_the_process_a_chance_to_clean_up() {
        let proc = spawn(
            "trap 'printf cleaned; exit 1' TERM; sleep 30 & wait".into(),
            None,
            WorkspaceEnv::Local,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
        proc.kill();
        wait_for_exit(&proc);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !proc.read_logs(0).bytes.contains("cleaned") {
            assert!(Instant::now() < deadline, "no output from the TERM trap");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_after_exit_is_harmless() {
        let proc = spawn("exit 0".into(), None, WorkspaceEnv::Local).unwrap();
        wait_for_exit(&proc);
        proc.kill();
        assert_eq!(proc.read_logs(0).exit_code, Some(0));
    }
}
