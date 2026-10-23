//! GUI-launched apps get a bare PATH on macOS, and servers like
//! typescript-language-server need the user's PATH themselves to find
//! `node`. Capture the environment of the shell the user's terminal runs
//! (interactive and login), once per shell, and reuse it for detect and spawn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// A captured shell environment.
pub type ServerEnv = HashMap<String, String>;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The environment language servers get: that of the shell configured in
/// Terax (an enumerated shell only), else the user's login shell, as new
/// terminals run them. A configured shell whose capture fails falls back to
/// the login shell. Empty on Windows (the full user env is inherited there)
/// or when every capture failed.
pub fn server_env_overlay(shell: Option<String>) -> Arc<ServerEnv> {
    #[cfg(unix)]
    {
        use crate::modules::pty::shell_init::terminal_shell_path;
        let configured = terminal_shell_path(shell);
        let login = terminal_shell_path(None);
        env_through(&configured, &login, |shell| {
            captured_envs().get(shell, capture_shell_env)
        })
    }
    #[cfg(windows)]
    {
        let _ = shell;
        Arc::new(HashMap::new())
    }
}

/// The environment of `configured`, or of `login` when that one is empty.
#[cfg(unix)]
fn env_through(
    configured: &str,
    login: &str,
    env_of: impl Fn(&str) -> Arc<ServerEnv>,
) -> Arc<ServerEnv> {
    let env = env_of(configured);
    if !env.is_empty() || configured == login {
        return env;
    }
    log::warn!("lsp: no environment from {configured}, using the login shell's");
    env_of(login)
}

/// Captures by shell path, each run once: concurrent callers for one shell
/// wait for its capture, other shells capture in parallel. A failed capture
/// is kept as empty, as the process env is used then.
#[cfg(unix)]
#[derive(Default)]
struct EnvCache {
    shells: std::sync::Mutex<HashMap<String, Arc<std::sync::OnceLock<Arc<ServerEnv>>>>>,
}

#[cfg(unix)]
impl EnvCache {
    fn get(&self, shell: &str, capture: impl FnOnce(&str) -> Option<ServerEnv>) -> Arc<ServerEnv> {
        let cell = self
            .shells
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(shell.to_owned())
            .or_default()
            .clone();
        cell.get_or_init(|| {
            Arc::new(capture(shell).unwrap_or_else(|| {
                log::warn!("lsp: shell env capture failed for {shell}, using process env");
                HashMap::new()
            }))
        })
        .clone()
    }
}

#[cfg(unix)]
fn captured_envs() -> &'static EnvCache {
    static CACHE: std::sync::OnceLock<EnvCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(EnvCache::default)
}

pub fn resolve_binary(command: &str, env: &ServerEnv) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let path = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    which::which_in(command, path, cwd).ok()
}

#[cfg(unix)]
const ENV_MARKER: &str = "__TERAX_ENV_6b1f__";
#[cfg(unix)]
const MAX_ENV_BYTES: usize = 1024 * 1024;

/// PATH added in an interactive rc file (nvm, pyenv or an npm prefix behind
/// Ubuntu's "not interactive, return" guard, zsh's .zshrc) exists only in an
/// interactive shell, which is what the user's terminal runs. The login-only
/// capture is the fallback for an rc file that fails without a terminal.
#[cfg(unix)]
fn capture_shell_env(shell: &str) -> Option<HashMap<String, String>> {
    run_capture(capture_command(shell, true)).or_else(|| run_capture(capture_command(shell, false)))
}

#[cfg(unix)]
fn capture_command(shell: &str, interactive: bool) -> std::process::Command {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(shell);
    if interactive {
        cmd.arg("-i");
    }
    cmd.args([
        "-l",
        "-c",
        &format!("printf '%s' {ENV_MARKER}; /usr/bin/env -0; printf '%s' {ENV_MARKER}"),
    ])
    // Lets an rc file skip slow interactive setup for this run.
    .env("TERAX_RESOLVING_ENVIRONMENT", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // A session of its own without a controlling terminal: an interactive
    // shell would otherwise take over the terminal Terax was started from.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd
}

#[cfg(unix)]
fn run_capture(mut cmd: std::process::Command) -> Option<HashMap<String, String>> {
    use crate::modules::proc::capture::{self, Limits};

    let limits = Limits {
        stdout: MAX_ENV_BYTES,
        stderr: 4 * 1024,
        stop_on_stdout_cap: true,
    };
    let out = capture::run(&mut cmd, CAPTURE_TIMEOUT, limits).ok()?;
    if out.timed_out {
        log::warn!("lsp: shell env capture timed out after {CAPTURE_TIMEOUT:?}");
        return None;
    }
    parse_env_block(&out.stdout)
}

/// The `env -0` output between the two markers: interactive rc files can
/// print banners, prompts or escape sequences around it.
#[cfg(unix)]
fn parse_env_block(bytes: &[u8]) -> Option<HashMap<String, String>> {
    let marker = ENV_MARKER.as_bytes();
    let start = bytes.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let rest = &bytes[start..];
    let len = rest.windows(marker.len()).rposition(|w| w == marker)?;
    let env: HashMap<String, String> = rest[..len]
        .split(|&b| b == 0)
        .filter(|chunk| !chunk.is_empty())
        .filter_map(|chunk| {
            let s = std::str::from_utf8(chunk).ok()?;
            let (k, v) = s.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect();
    if env.is_empty() {
        return None;
    }
    Some(env)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn resolve_binary_finds_sh() {
        let p = resolve_binary("sh", &HashMap::new()).expect("sh must resolve");
        assert!(p.is_absolute());
    }

    #[test]
    fn resolve_binary_rejects_empty_and_missing() {
        let env = HashMap::new();
        assert!(resolve_binary("", &env).is_none());
        assert!(resolve_binary("   ", &env).is_none());
        assert!(resolve_binary("terax-definitely-not-a-real-binary", &env).is_none());
    }

    #[test]
    fn resolve_binary_searches_the_captured_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let server = dir.path().join("terax-test-language-server");
        std::fs::write(&server, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = HashMap::from([("PATH".to_string(), dir.path().display().to_string())]);
        assert_eq!(
            resolve_binary("terax-test-language-server", &env),
            Some(server)
        );
        assert!(resolve_binary("terax-test-language-server", &HashMap::new()).is_none());
    }

    fn env_with(key: &str) -> Arc<ServerEnv> {
        Arc::new(HashMap::from([(key.to_string(), "1".to_string())]))
    }

    // crynta/terax-ai#1039: servers see the PATH of the shell chosen in Terax.
    #[test]
    fn the_configured_shell_wins_and_falls_back_to_the_login_shell() {
        let env_of = |shell: &str| match shell {
            "/bin/fish" => env_with("FISH"),
            "/bin/zsh" => env_with("ZSH"),
            _ => Arc::new(HashMap::new()),
        };
        assert!(env_through("/bin/fish", "/bin/zsh", env_of).contains_key("FISH"));
        assert!(env_through("/bin/zsh", "/bin/zsh", env_of).contains_key("ZSH"));
        assert!(env_through("/bin/broken", "/bin/zsh", env_of).contains_key("ZSH"));
        assert!(env_through("/bin/broken", "/bin/broken", env_of).is_empty());
    }

    #[test]
    fn each_shell_is_captured_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = EnvCache::default();
        let captures = AtomicUsize::new(0);
        let capture = |shell: &str| {
            captures.fetch_add(1, Ordering::SeqCst);
            (shell != "/bin/broken")
                .then(|| HashMap::from([("SHELL".to_string(), shell.to_string())]))
        };
        let fish = cache.get("/bin/fish", capture);
        assert_eq!(fish["SHELL"], "/bin/fish");
        assert!(Arc::ptr_eq(&fish, &cache.get("/bin/fish", capture)));
        assert_eq!(cache.get("/bin/zsh", capture)["SHELL"], "/bin/zsh");
        assert!(cache.get("/bin/broken", capture).is_empty());
        assert!(cache.get("/bin/broken", capture).is_empty());
        assert_eq!(captures.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn concurrent_callers_share_one_capture() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Arc::new(EnvCache::default());
        let captures = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let captures = captures.clone();
                std::thread::spawn(move || {
                    cache.get("/bin/fish", |_| {
                        captures.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        Some(HashMap::from([("A".to_string(), "1".to_string())]))
                    })
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap()["A"], "1");
        }
        assert_eq!(captures.load(Ordering::SeqCst), 1);
    }

    fn block(entries: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(ENV_MARKER.as_bytes());
        for entry in entries {
            out.extend_from_slice(entry.as_bytes());
            out.push(0);
        }
        out.extend_from_slice(ENV_MARKER.as_bytes());
        out
    }

    #[test]
    fn parse_env_block_ignores_output_around_the_markers() {
        let mut bytes = b"Welcome back!\n\x1b]0;title\x07".to_vec();
        bytes.extend(block(&["PATH=/a:/b", "EQ=x=y", "=bad", "NOEQ"]));
        bytes.extend_from_slice(b"bye\n");
        let env = parse_env_block(&bytes).unwrap();
        assert_eq!(env.get("PATH").map(String::as_str), Some("/a:/b"));
        assert_eq!(env.get("EQ").map(String::as_str), Some("x=y"));
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn parse_env_block_rejects_missing_or_empty_blocks() {
        assert!(parse_env_block(b"PATH=/a\0").is_none());
        assert!(parse_env_block(ENV_MARKER.as_bytes()).is_none());
        assert!(parse_env_block(&block(&[])).is_none());
    }

    fn fake_shell(dir: &std::path::Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn capture_prefers_the_interactive_shell() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            r#"for a; do last=$a; done
case " $* " in *" -i "*) export TERAX_TEST_INTERACTIVE=1;; esac
echo banner
exec /bin/sh -c "$last""#,
        );
        let env = capture_shell_env(&shell).unwrap();
        assert_eq!(
            env.get("TERAX_TEST_INTERACTIVE").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("TERAX_RESOLVING_ENVIRONMENT").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn capture_falls_back_to_the_login_shell() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            r#"for a; do last=$a; done
case " $* " in *" -i "*) echo "rc failed"; exit 1;; esac
exec /bin/sh -c "$last""#,
        );
        let env = capture_shell_env(&shell).unwrap();
        assert!(env.contains_key("PATH"));
        assert!(!env.contains_key("TERAX_TEST_INTERACTIVE"));
    }

    // crynta/terax-ai#1039: Ubuntu's .bashrc returns early unless interactive,
    // so PATH it adds (nvm, npm prefix) only shows up in an interactive shell.
    #[test]
    fn capture_sees_path_from_an_interactive_bashrc() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(".bashrc"),
            "case $- in *i*) ;; *) return;; esac\nexport PATH=\"$HOME/nvm-bin:$PATH\"\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".bash_profile"),
            "[ -f \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"\n",
        )
        .unwrap();
        let nvm_bin = format!("{}/nvm-bin", home.path().display());
        let run = |interactive: bool| {
            let mut cmd = capture_command("/bin/bash", interactive);
            cmd.env("HOME", home.path());
            run_capture(cmd).unwrap()["PATH"].contains(&nvm_bin)
        };
        assert!(!run(false));
        assert!(run(true));
    }
}
