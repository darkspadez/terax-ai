//! A local MCP server: one child process speaking newline-delimited JSON-RPC
//! on stdin and stdout, stderr into its log. Modelled on the LSP host
//! (`lsp/session.rs`): the backend is a pipe and a process owner, the
//! protocol lives in the page.
//!
//! Unix: the server leads its own process group and the group is signalled,
//! so what it started (`npx` -> `node`, `uvx` -> `python`) stops with it.
//! Windows: a `ProcessJob` (kill on close) holds the tree.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use shared_child::SharedChild;

use super::framing::{Line, LineDecoder};
use super::logs::{clean_line, LineSplitter, LogStore, Stream};

const READ_BUF: usize = 64 * 1024;
const THREAD_STACK: usize = 256 * 1024;
const STDERR_TAIL_LINES: usize = 8;
/// After stdin closes, how long a server gets to exit on its own before it is
/// asked to terminate (SIGTERM), and then before it is killed.
const EOF_GRACE: Duration = Duration::from_secs(1);
const TERM_GRACE: Duration = Duration::from_secs(2);
/// The environment capture marks its shell with this; a server must not
/// inherit it, or shells it starts would skip the user's setup.
const RESOLVING_MARKER: &str = "OARLOCK_RESOLVING_ENVIRONMENT";

fn spawn_thread(
    name: String,
    work: impl FnOnce() + Send + 'static,
) -> Result<thread::JoinHandle<()>, String> {
    thread::Builder::new()
        .name(name)
        .stack_size(THREAD_STACK)
        .spawn(work)
        .map_err(|e| e.to_string())
}

/// The folder a server starts in. A relative command is looked up only in a
/// folder that was set, never in one the server just defaults to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkingFolder {
    /// Set in the server's settings, or a project server's project.
    Set(PathBuf),
    /// None is set: the home folder.
    Home(PathBuf),
}

impl WorkingFolder {
    pub fn path(&self) -> &Path {
        match self {
            Self::Set(path) | Self::Home(path) => path,
        }
    }
}

/// The folder a server starts in: the one configured (absolute, existing),
/// else the home folder. Servers run outside the workspace authorization
/// registry: they are programs the user chose, with the user's rights.
pub fn resolve_cwd(cwd: Option<&str>) -> Result<WorkingFolder, String> {
    match cwd.map(str::trim).filter(|c| !c.is_empty()) {
        None => dirs::home_dir()
            .map(WorkingFolder::Home)
            .ok_or_else(|| "mcp: no home folder".to_string()),
        Some(raw) => {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(format!(
                    "mcp: the working folder must be an absolute path: {raw}"
                ));
            }
            if !path.is_dir() {
                return Err(format!("mcp: the working folder does not exist: {raw}"));
            }
            Ok(WorkingFolder::Set(path))
        }
    }
}

/// The child's environment as an ordered list of changes over Oarlock's own:
/// the user's shell environment, then the overrides every child gets
/// (`workspace::child_env_overrides`), then what the server's settings set,
/// secrets last. `None` removes a variable.
pub fn environment(
    shell: &HashMap<String, String>,
    overrides: Vec<(&'static str, Option<OsString>)>,
    configured: &[(String, String)],
) -> Vec<(OsString, Option<OsString>)> {
    let mut out: Vec<(OsString, Option<OsString>)> = shell
        .iter()
        .filter(|(k, _)| k.as_str() != RESOLVING_MARKER)
        .map(|(k, v)| (OsString::from(k), Some(OsString::from(v))))
        .collect();
    out.push((OsString::from(RESOLVING_MARKER), None));
    out.extend(overrides.into_iter().map(|(k, v)| (OsString::from(k), v)));
    out.extend(
        configured
            .iter()
            .map(|(k, v)| (OsString::from(k), Some(OsString::from(v)))),
    );
    out
}

pub struct SpawnSpec {
    pub server_id: String,
    pub owner: String,
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(OsString, Option<OsString>)>,
    pub max_message: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StdioExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// Why Oarlock stopped it, when it did (a message over the size limit).
    pub reason: Option<String>,
    pub stderr_tail: String,
}

/// Receives each message; an error (the page is gone) stops the server.
pub type OnMessage = Box<dyn FnMut(Vec<u8>) -> Result<(), String> + Send>;
pub type OnExit = Box<dyn FnOnce(StdioExit) + Send>;

pub struct StdioSession {
    pub owner: String,
    child: Arc<SharedChild>,
    stdin: Mutex<Option<ChildStdin>>,
    exited: Arc<AtomicBool>,
    stopping: AtomicBool,
    reason: Arc<Mutex<Option<String>>>,
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
}

impl StdioSession {
    pub fn write(&self, framed: &[u8]) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().ok_or("mcp: the server's input is closed")?;
        stdin
            .write_all(framed)
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("mcp: write failed: {e}"))
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn close_stdin(&self) {
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Asks the server to stop as the MCP stdio transport describes: close its
    /// input, then terminate, then kill the whole group. Returns at once.
    pub fn stop(self: &Arc<Self>) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        self.close_stdin();
        let session = self.clone();
        let spawned = spawn_thread(format!("oarlock-mcp-stop-{}", self.child.id()), move || {
            if !session.wait_exit(EOF_GRACE) {
                session.terminate();
                session.wait_exit(TERM_GRACE);
            }
            // Also takes down what the server left running after it exited.
            session.kill_now();
        });
        if spawned.is_err() {
            self.kill_now();
        }
    }

    fn wait_exit(&self, grace: Duration) -> bool {
        matches!(
            self.child.wait_deadline(Instant::now() + grace),
            Ok(Some(_))
        )
    }

    /// SIGTERM to the group (Unix); the first half of a bounded shutdown.
    pub fn terminate(&self) {
        self.close_stdin();
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGTERM);
        }
    }

    pub fn kill_now(&self) {
        self.close_stdin();
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        drop(self.job.lock().unwrap_or_else(|e| e.into_inner()).take());
        let _ = self.child.kill();
    }

    fn kill_with_reason(&self, reason: String) {
        self.reason
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert(reason);
        self.kill_now();
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        self.kill_now();
    }
}

pub fn spawn(
    spec: SpawnSpec,
    logs: Arc<LogStore>,
    mut on_message: OnMessage,
    on_exit: OnExit,
) -> Result<Arc<StdioSession>, String> {
    let SpawnSpec {
        server_id,
        owner,
        binary,
        args,
        cwd,
        env,
        max_message,
    } = spec;
    let mut cmd = Command::new(&binary);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        };
    }
    crate::modules::proc::hide_console(&mut cmd);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

    let child = Arc::new(
        SharedChild::spawn(&mut cmd)
            .map_err(|e| format!("mcp: could not start {}: {e}", binary.display()))?,
    );
    let pipes = (child.take_stdin(), child.take_stdout(), child.take_stderr());
    let (Some(stdin), Some(mut stdout), Some(mut stderr)) = pipes else {
        let _ = child.kill();
        return Err("mcp: the server has no stdio pipes".into());
    };

    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => Some(job),
        Err(e) => {
            log::warn!("mcp job-object setup failed for pid={}: {e}", child.id());
            None
        }
    };

    let pid = child.id();
    let exited = Arc::new(AtomicBool::new(false));
    let reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let session = Arc::new(StdioSession {
        owner,
        child: child.clone(),
        stdin: Mutex::new(Some(stdin)),
        exited: exited.clone(),
        stopping: AtomicBool::new(false),
        reason: reason.clone(),
        #[cfg(windows)]
        job: Mutex::new(job),
    });
    logs.push(
        &server_id,
        Stream::Oarlock,
        format!("Started {} (process {pid})", binary.display()),
    );

    // Threads hold the session weakly: dropping the last strong reference
    // (the state map) kills the server, as with the LSP host.
    let reader_session = Arc::downgrade(&session);
    let reader_logs = logs.clone();
    let reader_id = server_id.clone();
    let reader = spawn_thread(format!("oarlock-mcp-out-{pid}"), move || {
        let mut decoder = LineDecoder::with_limit(max_message);
        let mut buf = vec![0u8; READ_BUF];
        let mut deliver = |line: Line| -> bool {
            match line {
                Line::Message(bytes) => on_message(bytes).is_ok(),
                Line::Noise(bytes) => {
                    reader_logs.push(&reader_id, Stream::Stdout, clean_line(&bytes));
                    true
                }
            }
        };
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => match decoder.push(&buf[..n]) {
                    Ok(lines) => {
                        for line in lines {
                            if !deliver(line) {
                                if let Some(s) = reader_session.upgrade() {
                                    s.kill_now();
                                }
                                return;
                            }
                        }
                    }
                    Err(oversize) => {
                        let text = format!("Stopped: the server {oversize}");
                        reader_logs.push(&reader_id, Stream::Oarlock, text.clone());
                        if let Some(s) = reader_session.upgrade() {
                            s.kill_with_reason(text);
                        }
                        return;
                    }
                },
            }
        }
        if let Some(line) = decoder.finish() {
            deliver(line);
        }
    });
    let reader = match reader {
        Ok(handle) => handle,
        Err(e) => {
            session.kill_now();
            return Err(e);
        }
    };

    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_tail = tail.clone();
    let stderr_logs = logs.clone();
    let stderr_id = server_id.clone();
    let stderr_thread = spawn_thread(format!("oarlock-mcp-err-{pid}"), move || {
        let mut splitter = LineSplitter::default();
        let mut buf = [0u8; 4096];
        let mut emit = |raw: &[u8]| {
            let text = clean_line(raw);
            if text.trim().is_empty() {
                return;
            }
            let mut tail = stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(text.clone());
            drop(tail);
            stderr_logs.push(&stderr_id, Stream::Stderr, text);
        };
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            splitter.push(&buf[..n], &mut emit);
        }
        splitter.flush(&mut emit);
    });
    let stderr_thread = match stderr_thread {
        Ok(handle) => handle,
        Err(e) => {
            session.kill_now();
            return Err(e);
        }
    };

    let waited = spawn_thread(format!("oarlock-mcp-wait-{pid}"), move || {
        let status = child.wait();
        exited.store(true, Ordering::Release);
        // Bounded, not joined: a grandchild that inherited the pipes keeps
        // them open past the server's exit. Waiting for the reader lets the
        // last messages arrive before the exit does.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline && !(reader.is_finished() && stderr_thread.is_finished()) {
            thread::sleep(Duration::from_millis(10));
        }
        let (code, signal) = match &status {
            Ok(status) => (status.code(), exit_signal(status)),
            Err(_) => (None, None),
        };
        let note = match (code, signal) {
            (Some(code), _) => format!("Exited with code {code}"),
            (None, Some(signal)) => format!("Ended by signal {signal}"),
            (None, None) => "Exited".to_string(),
        };
        logs.push(&server_id, Stream::Oarlock, note);
        let stderr_tail = tail
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        on_exit(StdioExit {
            code,
            signal,
            reason: reason.lock().unwrap_or_else(|e| e.into_inner()).take(),
            stderr_tail,
        });
    });
    if let Err(e) = waited {
        session.kill_now();
        return Err(e);
    }
    Ok(session)
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Ends every session within a bounded time at app exit: each group is asked
/// to terminate, given a moment, then killed.
pub fn shut_down(sessions: Vec<Arc<StdioSession>>) {
    if sessions.is_empty() {
        return;
    }
    for session in &sessions {
        session.terminate();
    }
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline && !sessions.iter().all(|s| s.has_exited()) {
        thread::sleep(Duration::from_millis(10));
    }
    for session in &sessions {
        session.kill_now();
    }
}

/// The program to run: an absolute path as is, a relative path (`./serve.sh`,
/// `bin/serve`) inside the server's working folder, which must be set for
/// it, a bare name through the PATH of the user's shell environment
/// (`lsp::env::resolve_binary`).
pub fn resolve_program(
    command: &str,
    env: &HashMap<String, String>,
    folder: &WorkingFolder,
) -> Result<PathBuf, String> {
    use crate::modules::lsp::env::{is_relative_path, resolve_binary};
    let command = command.trim();
    if command.is_empty() {
        return Err("mcp: no command".into());
    }
    let relative = is_relative_path(command);
    if relative && matches!(folder, WorkingFolder::Home(_)) {
        return Err(format!(
            "mcp: {command} is a relative path, and this server has no working folder \
             to find it in; set its working folder in Settings, MCP, or give the full path"
        ));
    }
    resolve_binary(command, env, folder.path()).ok_or_else(|| {
        if Path::new(command).is_absolute() {
            format!("mcp: {command} is not an executable file")
        } else if relative {
            format!(
                "mcp: {command} is not an executable file in the working folder {}",
                folder.path().display()
            )
        } else {
            format!("mcp: command not found: {command}")
        }
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Run {
        session: Arc<StdioSession>,
        messages: mpsc::Receiver<Vec<u8>>,
        exit: mpsc::Receiver<StdioExit>,
        logs: Arc<LogStore>,
    }

    fn run_script(script: &str, max_message: usize, accept: bool) -> Run {
        let logs = Arc::new(LogStore::default());
        let (message_tx, messages) = mpsc::channel();
        let (exit_tx, exit) = mpsc::channel();
        let session = spawn(
            SpawnSpec {
                server_id: "test".into(),
                owner: "main".into(),
                binary: PathBuf::from("/bin/sh"),
                args: vec!["-c".into(), script.into()],
                cwd: std::env::temp_dir(),
                env: Vec::new(),
                max_message,
            },
            logs.clone(),
            Box::new(move |bytes| {
                let _ = message_tx.send(bytes);
                if accept {
                    Ok(())
                } else {
                    Err("closed".into())
                }
            }),
            Box::new(move |info| {
                let _ = exit_tx.send(info);
            }),
        )
        .expect("spawn");
        Run {
            session,
            messages,
            exit,
            logs,
        }
    }

    const WAIT: Duration = Duration::from_secs(5);

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn exchanges_newline_delimited_messages() {
        let run = run_script(
            r#"while IFS= read -r line; do printf '%s\n' "$line"; done"#,
            1024,
            true,
        );
        run.session
            .write(&super::super::framing::encode(r#"{"jsonrpc":"2.0","id":1}"#).unwrap())
            .unwrap();
        assert_eq!(
            text(run.messages.recv_timeout(WAIT).unwrap()),
            r#"{"jsonrpc":"2.0","id":1}"#
        );
        run.session.stop();
        let exit = run.exit.recv_timeout(WAIT).unwrap();
        assert_eq!(exit.code, Some(0), "it exits on its own when stdin closes");
    }

    #[test]
    fn logs_stderr_and_stray_stdout_and_reports_the_exit() {
        let run = run_script(
            r#"echo banner; echo '{"id":7}'; echo 'boom' >&2; exit 3"#,
            1024,
            true,
        );
        assert_eq!(
            text(run.messages.recv_timeout(WAIT).unwrap()),
            r#"{"id":7}"#
        );
        let exit = run.exit.recv_timeout(WAIT).unwrap();
        assert_eq!(exit.code, Some(3));
        assert_eq!(exit.stderr_tail, "boom");
        assert_eq!(exit.reason, None);
        let lines = run.logs.read("test", 0).lines;
        let has =
            |stream: Stream, text: &str| lines.iter().any(|l| l.stream == stream && l.text == text);
        assert!(has(Stream::Stdout, "banner"));
        assert!(has(Stream::Stderr, "boom"));
        assert!(has(Stream::Oarlock, "Exited with code 3"));
    }

    #[test]
    fn a_message_over_the_limit_stops_the_server_with_a_reason() {
        let run = run_script(r#"printf '{"x":"%0200d"}\n' 0; sleep 30"#, 64, true);
        let exit = run.exit.recv_timeout(WAIT).unwrap();
        assert!(
            exit.reason.as_deref().unwrap_or("").contains("limit"),
            "{exit:?}"
        );
        assert!(run.messages.try_recv().is_err());
    }

    #[test]
    fn a_closed_page_channel_stops_the_server() {
        let run = run_script(r#"echo '{"id":1}'; sleep 30"#, 1024, false);
        run.messages.recv_timeout(WAIT).unwrap();
        let exit = run.exit.recv_timeout(WAIT).unwrap();
        assert_eq!(exit.signal, Some(libc::SIGKILL));
    }

    #[test]
    fn stopping_takes_down_the_whole_process_group() {
        // Ignores EOF and SIGTERM, so only the group kill ends it.
        let run = run_script(
            r#"trap '' TERM; sleep 30 & printf '{"pid":%s}\n' $!; while :; do sleep 1; done"#,
            1024,
            true,
        );
        let first = text(run.messages.recv_timeout(WAIT).unwrap());
        let grandchild: i32 = first
            .trim_start_matches("{\"pid\":")
            .trim_end_matches('}')
            .parse()
            .unwrap();
        run.session.stop();
        let exit = run
            .exit
            .recv_timeout(EOF_GRACE + TERM_GRACE + WAIT)
            .unwrap();
        assert_eq!(exit.signal, Some(libc::SIGKILL));
        let deadline = Instant::now() + WAIT;
        while unsafe { libc::kill(grandchild, 0) } == 0 {
            assert!(Instant::now() < deadline, "grandchild survived");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn shut_down_ends_every_session_quickly() {
        let a = run_script("trap '' TERM; while :; do sleep 1; done", 1024, true);
        let b = run_script("while :; do sleep 1; done", 1024, true);
        let started = Instant::now();
        shut_down(vec![a.session.clone(), b.session.clone()]);
        assert!(started.elapsed() < Duration::from_secs(1));
        a.exit.recv_timeout(WAIT).unwrap();
        b.exit.recv_timeout(WAIT).unwrap();
    }

    #[test]
    fn writes_fail_once_stopped() {
        let run = run_script("cat > /dev/null", 1024, true);
        run.session.stop();
        assert!(run.session.write(b"{}\n").is_err());
        run.exit.recv_timeout(WAIT).unwrap();
    }

    #[test]
    fn the_environment_layers_the_shell_overrides_and_settings_in_order() {
        let shell = HashMap::from([
            ("PATH".to_string(), "/shell/bin".to_string()),
            (RESOLVING_MARKER.to_string(), "1".to_string()),
            ("TOKEN".to_string(), "from-shell".to_string()),
        ]);
        let env = environment(
            &shell,
            vec![("__NV_DISABLE_EXPLICIT_SYNC", None)],
            &[("TOKEN".to_string(), "configured".to_string())],
        );
        // What a child sees: Oarlock's environment with the changes applied in order.
        let mut resolved: HashMap<OsString, OsString> = HashMap::from([(
            OsString::from("__NV_DISABLE_EXPLICIT_SYNC"),
            OsString::from("1"),
        )]);
        for (k, v) in env {
            match v {
                Some(v) => resolved.insert(k, v),
                None => resolved.remove(&k),
            };
        }
        assert_eq!(resolved[&OsString::from("TOKEN")], "configured");
        assert_eq!(resolved[&OsString::from("PATH")], "/shell/bin");
        assert!(!resolved.contains_key(&OsString::from(RESOLVING_MARKER)));
        assert!(!resolved.contains_key(&OsString::from("__NV_DISABLE_EXPLICIT_SYNC")));
    }

    #[test]
    fn the_working_folder_is_absolute_and_exists_or_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = WorkingFolder::Home(dirs::home_dir().unwrap());
        assert_eq!(
            resolve_cwd(Some(dir.path().to_str().unwrap())).unwrap(),
            WorkingFolder::Set(dir.path().to_owned())
        );
        assert_eq!(resolve_cwd(None).unwrap(), home);
        assert_eq!(resolve_cwd(Some("  ")).unwrap(), home);
        assert!(resolve_cwd(Some("relative/dir")).is_err());
        assert!(resolve_cwd(Some(dir.path().join("missing").to_str().unwrap())).is_err());
    }

    #[test]
    fn programs_resolve_through_the_given_path() {
        let home = WorkingFolder::Home(dirs::home_dir().unwrap());
        assert!(resolve_program("sh", &HashMap::new(), &home).is_ok());
        let missing = resolve_program("oarlock-no-such-mcp-server", &HashMap::new(), &home);
        assert!(missing.unwrap_err().contains("command not found"));
        assert!(resolve_program(" ", &HashMap::new(), &home).is_err());
    }

    #[test]
    fn a_relative_command_is_the_working_folders() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir(folder.path().join("bin")).unwrap();
        let serve = folder.path().join("bin/serve");
        std::fs::write(&serve, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&serve, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = HashMap::new();
        let set = WorkingFolder::Set(folder.path().to_owned());
        for command in ["./bin/serve", "bin/serve"] {
            assert_eq!(resolve_program(command, &env, &set), Ok(serve.clone()));
        }

        let other = WorkingFolder::Set(elsewhere.path().to_owned());
        let error = resolve_program("./bin/serve", &env, &other).unwrap_err();
        assert!(
            error.contains(&elsewhere.path().display().to_string()),
            "{error}"
        );

        // Never the home folder a server without one runs in, nor Oarlock's own.
        let unset = WorkingFolder::Home(folder.path().to_owned());
        let error = resolve_program("./bin/serve", &env, &unset).unwrap_err();
        assert!(error.contains("no working folder"), "{error}");

        // A bare name comes from PATH, even where a file of that name sits.
        std::fs::copy(&serve, folder.path().join("oarlock-no-such-mcp-server")).unwrap();
        let error = resolve_program("oarlock-no-such-mcp-server", &env, &set).unwrap_err();
        assert!(error.contains("command not found"), "{error}");
    }
}
