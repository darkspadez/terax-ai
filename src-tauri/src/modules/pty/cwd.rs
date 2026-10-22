//! Which folder a terminal's reported working directory (OSC 7) may authorize.
//!
//! OSC 7 is terminal output: `cat` of a crafted file can print one naming any folder, even `/`.
//! On Linux and macOS a report authorizes its folder only when the OS says the shell, or the
//! leader of the job in front of it (a nested local shell such as `bash` started from zsh), is
//! working there. The report follows the `cd`, so the shell is already there; when a second
//! `cd` has moved it on before the check, the report authorizes nothing and the next one does.
//! Windows cannot read another process's folder cheaply, so there a report is authorized as it
//! was before.

use std::path::Path;
#[cfg(any(unix, test))]
use std::path::PathBuf;

use crate::modules::workspace::WorkspaceRegistry;

/// The folder a report may authorize: the reported folder as it really is (links followed,
/// `..` resolved), when it is exactly one of the folders the OS reports for the terminal's
/// processes (`real`, canonical, `None` where one could not be read). A folder above or below
/// them is not enough, and a report that does not resolve authorizes nothing.
#[cfg(any(unix, test))]
pub(super) fn verified_cwd(reported: Option<PathBuf>, real: &[Option<PathBuf>]) -> Option<PathBuf> {
    let reported = reported?;
    real.iter()
        .flatten()
        .any(|folder| *folder == reported)
        .then_some(reported)
}

/// The processes whose folder a report may name: the shell, and the leader of the terminal's
/// foreground process group when that is another process. A pid of 0 is unknown.
#[cfg(unix)]
pub(super) fn reporting_processes(shell_pid: u32, foreground: Option<libc::pid_t>) -> Vec<u32> {
    let mut pids = Vec::with_capacity(2);
    if shell_pid != 0 {
        pids.push(shell_pid);
    }
    if let Some(leader) = foreground.and_then(|pid| u32::try_from(pid).ok()) {
        if leader != 0 && leader != shell_pid {
            pids.push(leader);
        }
    }
    pids
}

/// Authorizes `reported`, a terminal's folder, if one of `processes` is working there. Touches
/// the disk: run it on the blocking pool. True when it was authorized.
#[cfg(unix)]
pub(super) fn authorize_reported(
    registry: &WorkspaceRegistry,
    reported: &Path,
    processes: &[u32],
) -> bool {
    let real: Vec<Option<PathBuf>> = processes.iter().map(|&pid| process_cwd(pid)).collect();
    let Some(folder) = verified_cwd(std::fs::canonicalize(reported).ok(), &real) else {
        log::debug!(
            "terminal folder {} is not where its shell is; not authorized",
            reported.display()
        );
        return false;
    };
    registry.authorize(folder).is_ok()
}

/// Windows: the report is authorized as it was before the check existed, and the page takes it.
#[cfg(windows)]
pub(super) fn authorize_reported(registry: &WorkspaceRegistry, reported: &Path) -> bool {
    if let Err(error) = registry.authorize(reported) {
        log::debug!(
            "terminal folder {} not authorized: {error}",
            reported.display()
        );
    }
    true
}

/// The folder process `pid` works in, canonical; `None` when it cannot be read (the process is
/// gone or not ours, or its folder was deleted).
#[cfg(target_os = "linux")]
pub(super) fn process_cwd(pid: u32) -> Option<PathBuf> {
    let link = PathBuf::from(format!("/proc/{pid}/cwd"));
    let named = std::fs::canonicalize(std::fs::read_link(&link).ok()?).ok()?;
    // A deleted folder reads as "<path> (deleted)", and a process in another mount namespace
    // names a folder of its own tree: the name must lead to the folder the process is in, which
    // the link itself reaches.
    let (actual, at_name) = (
        std::fs::metadata(&link).ok()?,
        std::fs::metadata(&named).ok()?,
    );
    same_folder(&actual, &at_name).then_some(named)
}

/// The folder process `pid` works in, canonical; `None` when it cannot be read (the process is
/// gone or not ours, or its folder was deleted).
#[cfg(target_os = "macos")]
pub(super) fn process_cwd(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let pid = libc::c_int::try_from(pid).ok()?;
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>();
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            libc::c_int::try_from(size).ok()?,
        )
    };
    if usize::try_from(written).ok()? != size {
        return None;
    }
    // Zeroed, then filled by the kernel: every field is initialized.
    let info = unsafe { info.assume_init() };
    let cwd = &info.pvi_cdir;
    let path = cwd.vip_path.as_flattened();
    let len = path.iter().position(|&c| c == 0)?;
    if len == 0 {
        return None;
    }
    let bytes: Vec<u8> = path[..len].iter().map(|&c| c as u8).collect();
    let named = std::fs::canonicalize(std::ffi::OsStr::from_bytes(&bytes)).ok()?;
    // The name must still lead to the folder the process is in (not a folder made at the path
    // of a deleted one). `st_dev` is a signed 32-bit value; compare its bits.
    let at_name = std::fs::metadata(&named).ok()?;
    let stat = &cwd.vip_vi.vi_stat;
    (at_name.ino() == stat.vst_ino && at_name.dev() as u32 == stat.vst_dev).then_some(named)
}

/// Other Unix systems: no cheap way to read another process's folder, so nothing is verified.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(super) fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "linux")]
fn same_folder(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.is_dir() && a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(path: &str) -> Option<PathBuf> {
        Some(PathBuf::from(path))
    }

    #[test]
    fn a_report_authorizes_only_the_folder_a_process_is_in() {
        let real = [some("/home/me/project"), some("/home/me")];
        assert_eq!(
            verified_cwd(some("/home/me/project"), &real),
            some("/home/me/project")
        );
        // The foreground job's folder counts as much as the shell's.
        assert_eq!(verified_cwd(some("/home/me"), &real), some("/home/me"));
        for elsewhere in [
            "/",
            "/home",
            "/home/me/project/src",
            "/etc",
            "/home/me/projects",
        ] {
            assert_eq!(verified_cwd(some(elsewhere), &real), None, "{elsewhere}");
        }
    }

    #[test]
    fn nothing_is_authorized_when_either_side_is_unknown() {
        // The report did not resolve (missing, or not ours to read).
        assert_eq!(verified_cwd(None, &[some("/home/me")]), None);
        // No process folder could be read: a race with a second `cd` that removed the folder,
        // a process that is gone, or a platform without the check.
        assert_eq!(verified_cwd(some("/home/me"), &[None, None]), None);
        assert_eq!(verified_cwd(some("/home/me"), &[]), None);
        // One readable process is enough.
        assert_eq!(
            verified_cwd(some("/home/me"), &[None, some("/home/me")]),
            some("/home/me")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_and_another_foreground_leader_are_asked() {
        assert_eq!(reporting_processes(100, Some(100)), [100]);
        assert_eq!(reporting_processes(100, Some(200)), [100, 200]);
        assert_eq!(reporting_processes(100, None), [100]);
        assert_eq!(reporting_processes(0, Some(200)), [200]);
        assert_eq!(reporting_processes(0, None), Vec::<u32>::new());
        assert_eq!(reporting_processes(100, Some(-1)), [100]);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    mod process_folders {
        use super::super::*;
        use std::process::{Child, Command};

        /// A child process sleeping in `dir`, killed when dropped.
        struct Sleeper(Child);

        impl Sleeper {
            fn in_dir(dir: &Path) -> Self {
                Self(
                    Command::new("sleep")
                        .arg("30")
                        .current_dir(dir)
                        .spawn()
                        .expect("spawn sleep"),
                )
            }

            fn pid(&self) -> u32 {
                self.0.id()
            }
        }

        impl Drop for Sleeper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        fn reads_the_canonical_folder_of_a_running_process() {
            let root = tempfile::tempdir().unwrap();
            let real = root.path().join("real");
            std::fs::create_dir(&real).unwrap();
            std::os::unix::fs::symlink(&real, root.path().join("link")).unwrap();
            let child = Sleeper::in_dir(&root.path().join("link"));
            assert_eq!(
                process_cwd(child.pid()),
                Some(std::fs::canonicalize(&real).unwrap())
            );
        }

        #[test]
        fn a_deleted_folder_or_a_finished_process_reads_as_unknown() {
            let root = tempfile::tempdir().unwrap();
            let doomed = root.path().join("doomed");
            std::fs::create_dir(&doomed).unwrap();
            let child = Sleeper::in_dir(&doomed);
            std::fs::remove_dir(&doomed).unwrap();
            assert_eq!(process_cwd(child.pid()), None);
            // Even with a folder named like the kernel's spelling of the deleted one.
            std::fs::create_dir(root.path().join("doomed (deleted)")).unwrap();
            assert_eq!(process_cwd(child.pid()), None);

            let mut finished = Command::new("true").spawn().unwrap();
            let pid = finished.id();
            finished.wait().unwrap();
            assert_eq!(process_cwd(pid), None);
        }

        #[test]
        fn a_report_is_authorized_only_where_a_process_really_is() {
            let root = tempfile::tempdir().unwrap();
            let shell_dir = root.path().join("shell");
            let job_dir = root.path().join("job");
            let elsewhere = root.path().join("elsewhere");
            for dir in [&shell_dir, &job_dir, &elsewhere] {
                std::fs::create_dir(dir).unwrap();
            }
            let shell = Sleeper::in_dir(&shell_dir);
            let job = Sleeper::in_dir(&job_dir);
            let processes = reporting_processes(shell.pid(), Some(job.pid() as libc::pid_t));
            let registry = WorkspaceRegistry::default();

            assert!(!authorize_reported(&registry, &elsewhere, &processes));
            assert!(!authorize_reported(&registry, root.path(), &processes));
            assert!(!authorize_reported(&registry, Path::new("/"), &processes));
            assert!(!authorize_reported(
                &registry,
                &root.path().join("missing"),
                &processes
            ));
            assert!(!registry.is_authorized(&std::fs::canonicalize(&elsewhere).unwrap()));

            // `..` and links resolve to the shell's folder.
            assert!(authorize_reported(
                &registry,
                &elsewhere.join("..").join("shell"),
                &processes
            ));
            assert!(registry.is_authorized(&std::fs::canonicalize(&shell_dir).unwrap()));
            assert!(authorize_reported(&registry, &job_dir, &processes));
            assert!(registry.is_authorized(&std::fs::canonicalize(&job_dir).unwrap()));
            assert!(!registry.is_authorized(&std::fs::canonicalize(&elsewhere).unwrap()));
        }
    }
}
