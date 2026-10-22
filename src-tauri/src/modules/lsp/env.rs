//! GUI-launched apps get a bare PATH on macOS, and servers like
//! typescript-language-server need the user's PATH themselves to find
//! `node`. Capture the user's interactive login shell env once, reuse for
//! detect and spawn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Empty on Windows (full user env is inherited there) or if capture failed.
pub fn server_env_overlay() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        #[cfg(unix)]
        {
            match capture_login_env() {
                Some(env) => env,
                None => {
                    log::warn!("lsp: login shell env capture failed, using process env");
                    HashMap::new()
                }
            }
        }
        #[cfg(windows)]
        {
            HashMap::new()
        }
    })
}

pub fn resolve_binary(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let path = server_env_overlay()
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    which::which_in(command, path, cwd).ok()
}

#[cfg(unix)]
const ENV_MARKER: &str = "__TERAX_ENV_6b1f__";
#[cfg(unix)]
const MAX_ENV_BYTES: usize = 1024 * 1024;

#[cfg(unix)]
fn capture_login_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    capture_shell_env(&shell)
}

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
        let p = resolve_binary("sh").expect("sh must resolve");
        assert!(p.is_absolute());
    }

    #[test]
    fn resolve_binary_rejects_empty_and_missing() {
        assert!(resolve_binary("").is_none());
        assert!(resolve_binary("   ").is_none());
        assert!(resolve_binary("terax-definitely-not-a-real-binary").is_none());
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
