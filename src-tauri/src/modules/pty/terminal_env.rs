//! The terminal identity of a Terax shell.
//!
//! A shell inherits Terax's environment, and a Terax started from another
//! terminal (a dev build run in Ghostty, a launcher inside tmux, Terax itself)
//! carries that terminal's identity. Tools read it to pick escape sequences,
//! wrap output for a multiplexer that is not there, or reach the other terminal
//! over its socket, so it is dropped and Terax's own identity takes its place.
//! User configuration (PATH, locale, XDG dirs, a tool's config location) is
//! never touched.

use std::collections::HashMap;
use std::path::Path;

/// What every Terax terminal session advertises. The terminal core answers
/// XTVERSION with the same name and version.
pub const IDENTITY: [(&str, &str); 4] = [
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "terax"),
    ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION")),
];

/// Variables a terminal emulator or multiplexer exports only to describe
/// itself or the session it runs a program in.
const LAUNCHER_VARS: &[&str] = &[
    // De facto identity: Ghostty, iTerm2, Apple Terminal, WezTerm, VS Code,
    // tmux 3.2+, Hyper, Warp, Tabby, Rio.
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    // Apple Terminal and iTerm2 session restore.
    "TERM_SESSION_ID",
    // X11 window of the terminal: xterm, kitty, Alacritty, Konsole, Terminator.
    "WINDOWID",
    // Palette hint: iTerm2, Konsole, rxvt-unicode.
    "COLORFGBG",
    // Ghostty, including injection variables older releases leave behind.
    "GHOSTTY_RESOURCES_DIR",
    "GHOSTTY_BIN_DIR",
    "GHOSTTY_SHELL_FEATURES",
    "GHOSTTY_SURFACE_ID",
    "GHOSTTY_SHELL_INTEGRATION_NO_CURSOR",
    "GHOSTTY_SHELL_INTEGRATION_NO_SUDO",
    "GHOSTTY_SHELL_INTEGRATION_NO_TITLE",
    "GHOSTTY_SHELL_INTEGRATION_XDG_DIR",
    "GHOSTTY_ZSH_ZDOTDIR",
    "GHOSTTY_BASH_INJECT",
    "GHOSTTY_BASH_ENV",
    "GHOSTTY_BASH_RCFILE",
    "GHOSTTY_BASH_UNEXPORT_HISTFILE",
    // iTerm2. LC_TERMINAL* exist so ssh forwards the identity to remote hosts.
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "ITERM2_COOKIE",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "TERM_FEATURES",
    // kitty: its remote control socket, key and window, and shell injection.
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "KITTY_PUBLIC_KEY",
    "KITTY_LISTEN_ON",
    "KITTY_INSTALLATION_DIR",
    "KITTY_SHELL_INTEGRATION",
    "KITTY_SI_RUN_COMMAND_AT_STARTUP",
    "KITTY_IS_CLONE_LAUNCH",
    "KITTY_HOLD",
    // WezTerm: `wezterm cli` would drive the other terminal's panes.
    "WEZTERM_EXECUTABLE",
    "WEZTERM_EXECUTABLE_DIR",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    // Alacritty: `alacritty msg` would drive the other terminal's windows.
    "ALACRITTY_WINDOW_ID",
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    // Konsole.
    "KONSOLE_VERSION",
    "KONSOLE_DBUS_SERVICE",
    "KONSOLE_DBUS_SESSION",
    "KONSOLE_DBUS_WINDOW",
    "KONSOLE_DBUS_ACTIVATION_COOKIE",
    "SHELL_SESSION_ID",
    // VTE terminals: GNOME Terminal, Ptyxis, Tilix, Terminator. VTE_VERSION
    // also makes /etc/profile.d/vte.sh install its own prompt hooks.
    "VTE_VERSION",
    "GNOME_TERMINAL_SCREEN",
    "GNOME_TERMINAL_SERVICE",
    "PTYXIS_VERSION",
    "PTYXIS_PROFILE",
    "TILIX_ID",
    "TERMINATOR_UUID",
    "TERMINATOR_DBUS_NAME",
    "TERMINATOR_DBUS_PATH",
    // xterm.
    "XTERM_VERSION",
    "XTERM_SHELL",
    "XTERM_LOCALE",
    "XTERM_FILTER",
    // JetBrains IDE terminals.
    "TERMINAL_EMULATOR",
    // Windows Terminal.
    "WT_SESSION",
    "WT_PROFILE_ID",
    // VS Code's terminal: its CLI socket and shell integration injection.
    "VSCODE_IPC_HOOK_CLI",
    "VSCODE_INJECTION",
    "VSCODE_NONCE",
    "VSCODE_STABLE",
    "VSCODE_SHELL_LOGIN",
    "VSCODE_SHELL_ENV_REPORTING",
    "VSCODE_PATH_PREFIX",
    "VSCODE_PREVENT_SHELL_HISTORY",
    "VSCODE_AGENT_ZSH_FIXUPS",
    "VSCODE_ZDOTDIR",
    // Multiplexers: tools would wrap output in passthrough sequences and tmux
    // would refuse to start, for a session that does not exist here.
    "TMUX",
    "TMUX_PANE",
    "STY",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
    // A parent Terax session. Each is set again when it applies to this one;
    // TERAX_USER_ZDOTDIR is kept because it names the user's own zsh config.
    "TERAX_TERMINAL",
    "TERAX_BLOCKS",
    "TERAX_CONTROL_ADDR",
    "TERAX_CONTROL_TOKEN",
    "TERAX_PANE_ID",
    "TERAX_CLI",
];

/// Namespaces VS Code reserves for what its terminal injects: the git
/// extension's IPC and helpers, environment collections, Python activation.
const LAUNCHER_PREFIXES: &[&str] = &["VSCODE_GIT_", "VSCODE_ENV_", "VSCODE_PYTHON_"];

/// Generic names that are a launcher's only when its marker is present.
const MARKED_VARS: &[(&str, &str)] = &[
    // GNU screen's window number.
    ("WINDOW", "STY"),
    // Konsole's profile directory.
    ("PROFILEHOME", "KONSOLE_VERSION"),
];

/// The names to remove from `env` (a spawned shell's inherited environment):
/// every launcher identity variable, plus the general-purpose variables the
/// launcher pointed at its own installation.
pub fn inherited_identity<'a>(env: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<String> {
    let env: HashMap<&str, &str> = env.into_iter().collect();
    let mut stale: Vec<String> = env
        .keys()
        .filter(|key| {
            LAUNCHER_VARS.contains(key)
                || LAUNCHER_PREFIXES.iter().any(|p| key.starts_with(p))
                || MARKED_VARS
                    .iter()
                    .any(|(name, marker)| name == *key && env.contains_key(marker))
        })
        .map(|key| key.to_string())
        .collect();
    stale.extend(
        ["TERMINFO", "TERMINFO_DIRS", "GIT_ASKPASS", "GIT_EDITOR"]
            .into_iter()
            .filter(|key| {
                env.get(key)
                    .is_some_and(|value| launcher_owned(key, value, &env))
            })
            .map(String::from),
    );
    stale.sort_unstable();
    stale
}

fn launcher_owned(key: &str, value: &str, env: &HashMap<&str, &str>) -> bool {
    let parent = |var: &str| env.get(var).and_then(|v| Path::new(v).parent());
    match key {
        // Ghostty points TERMINFO beside its resources, kitty into its
        // installation or at the database itself (`b64:`).
        "TERMINFO" => {
            parent("GHOSTTY_RESOURCES_DIR")
                .is_some_and(|dir| Path::new(value) == dir.join("terminfo"))
                || env.get("KITTY_INSTALLATION_DIR").is_some_and(|dir| {
                    value.starts_with("b64:") || Path::new(value) == Path::new(dir).join("terminfo")
                })
        }
        // iTerm2 prepends the terminfo directory of its app bundle.
        "TERMINFO_DIRS" => {
            env.contains_key("ITERM_SESSION_ID")
                && value
                    .strip_suffix(":/usr/share/terminfo")
                    .is_some_and(|dir| dir.ends_with(".app/Contents/Resources/terminfo"))
        }
        // VS Code's git extension keeps its askpass and editor scripts beside
        // the entry points it exports; without that IPC they fail every prompt.
        "GIT_ASKPASS" => parent("VSCODE_GIT_ASKPASS_MAIN")
            .is_some_and(|dir| Path::new(value).parent() == Some(dir)),
        "GIT_EDITOR" => parent("VSCODE_GIT_EDITOR_MAIN")
            .is_some_and(|dir| Path::new(value.trim_matches('"')).parent() == Some(dir)),
        _ => false,
    }
}

/// `WSLENV` with `names` added, so a WSL shell receives them: WSL passes on
/// only the Windows variables this list names. Entries already present keep
/// their translation flags.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn wslenv_with(existing: Option<&str>, names: &[&str]) -> String {
    let mut entries: Vec<&str> = existing
        .unwrap_or("")
        .split(':')
        .filter(|entry| !entry.is_empty())
        .collect();
    for name in names {
        if !entries
            .iter()
            .any(|entry| entry.split('/').next() == Some(name))
        {
            entries.push(name);
        }
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stale(env: &[(&str, &str)]) -> Vec<String> {
        inherited_identity(env.iter().copied())
    }

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        names.sort_unstable();
        names
    }

    #[test]
    fn identity_is_terax_at_the_app_version() {
        let identity: HashMap<_, _> = IDENTITY.into_iter().collect();
        assert_eq!(identity["TERM"], "xterm-256color");
        assert_eq!(identity["COLORTERM"], "truecolor");
        assert_eq!(identity["TERM_PROGRAM"], "terax");
        // The frontend answers XTVERSION with Tauri's app version; both must agree.
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(identity["TERM_PROGRAM_VERSION"], config["version"]);
    }

    #[test]
    fn every_launching_terminal_identity_is_dropped() {
        let launchers: &[&[(&str, &str)]] = &[
            &[
                ("TERM_PROGRAM", "ghostty"),
                ("TERM_PROGRAM_VERSION", "1.2.3"),
                (
                    "GHOSTTY_RESOURCES_DIR",
                    "/Applications/Ghostty.app/Contents/Resources/ghostty",
                ),
                (
                    "GHOSTTY_BIN_DIR",
                    "/Applications/Ghostty.app/Contents/MacOS",
                ),
                ("GHOSTTY_SHELL_FEATURES", "cursor,title"),
                ("GHOSTTY_SURFACE_ID", "0x0000000000000001"),
            ],
            &[
                ("TERM_PROGRAM", "iTerm.app"),
                ("TERM_SESSION_ID", "w0t0p0:1"),
                ("ITERM_SESSION_ID", "w0t0p0:1"),
                ("ITERM_PROFILE", "Default"),
                ("ITERM2_COOKIE", "secret"),
                ("LC_TERMINAL", "iTerm2"),
                ("LC_TERMINAL_VERSION", "3.6.0"),
                ("TERM_FEATURES", "T3LrMSc7UUw9Ts3BFGsSyHNoSxF"),
                ("COLORFGBG", "7;0"),
            ],
            &[
                ("TERM_PROGRAM", "Apple_Terminal"),
                ("TERM_SESSION_ID", "uuid"),
            ],
            &[
                ("KITTY_WINDOW_ID", "1"),
                ("KITTY_PID", "42"),
                ("KITTY_PUBLIC_KEY", "1:key"),
                ("KITTY_LISTEN_ON", "unix:/tmp/kitty"),
                ("KITTY_INSTALLATION_DIR", "/usr/lib/kitty"),
                ("WINDOWID", "88080391"),
            ],
            &[
                ("TERM_PROGRAM", "WezTerm"),
                ("WEZTERM_EXECUTABLE", "/usr/bin/wezterm-gui"),
                ("WEZTERM_EXECUTABLE_DIR", "/usr/bin"),
                ("WEZTERM_PANE", "0"),
                ("WEZTERM_UNIX_SOCKET", "/run/user/1000/wezterm/gui-sock-1"),
            ],
            &[
                ("ALACRITTY_WINDOW_ID", "1"),
                ("ALACRITTY_SOCKET", "/run/user/1000/Alacritty.sock"),
                ("ALACRITTY_LOG", "/tmp/Alacritty.log"),
            ],
            &[
                ("KONSOLE_VERSION", "250402"),
                ("KONSOLE_DBUS_SERVICE", ":1.42"),
                ("KONSOLE_DBUS_SESSION", "/Sessions/1"),
                ("KONSOLE_DBUS_WINDOW", "/Windows/1"),
                ("KONSOLE_DBUS_ACTIVATION_COOKIE", "secret"),
                ("SHELL_SESSION_ID", "abc"),
                ("PROFILEHOME", ""),
            ],
            &[
                ("VTE_VERSION", "8002"),
                ("GNOME_TERMINAL_SCREEN", "/org/gnome/Terminal/screen/1"),
                ("GNOME_TERMINAL_SERVICE", ":1.99"),
                ("PTYXIS_VERSION", "48.0"),
                ("TILIX_ID", "uuid"),
                ("TERMINATOR_UUID", "urn:uuid:1"),
            ],
            &[
                ("XTERM_VERSION", "XTerm(390)"),
                ("XTERM_SHELL", "/bin/bash"),
            ],
            &[("TERMINAL_EMULATOR", "JetBrains-JediTerm")],
            &[("WT_SESSION", "guid"), ("WT_PROFILE_ID", "guid")],
            &[
                ("TERM_PROGRAM", "vscode"),
                ("VSCODE_IPC_HOOK_CLI", "/tmp/vscode-ipc.sock"),
                ("VSCODE_GIT_IPC_HANDLE", "/tmp/vscode-git.sock"),
                ("VSCODE_GIT_ASKPASS_NODE", "/app/code"),
                ("VSCODE_GIT_ASKPASS_EXTRA_ARGS", ""),
                ("VSCODE_GIT_ASKPASS_MAIN", "/app/git/dist/askpass-main.js"),
                ("VSCODE_PYTHON_AUTOACTIVATE_GUARD", "1"),
                ("VSCODE_INJECTION", "1"),
            ],
            &[("TMUX", "/tmp/tmux-1000/default,1,0"), ("TMUX_PANE", "%1")],
            &[("STY", "1.pts-0.host"), ("WINDOW", "0")],
            &[
                ("ZELLIJ", "0"),
                ("ZELLIJ_SESSION_NAME", "s"),
                ("ZELLIJ_PANE_ID", "1"),
            ],
            &[
                ("TERAX_TERMINAL", "1"),
                ("TERAX_BLOCKS", "1"),
                ("TERAX_CONTROL_ADDR", "127.0.0.1:1"),
                ("TERAX_CONTROL_TOKEN", "secret"),
                ("TERAX_PANE_ID", "3"),
                ("TERAX_CLI", "/app/terax-cli"),
            ],
        ];
        for launcher in launchers {
            let names: Vec<&str> = launcher.iter().map(|(name, _)| *name).collect();
            assert_eq!(stale(launcher), sorted(&names), "{launcher:?}");
        }
    }

    #[test]
    fn user_configuration_survives() {
        let env = [
            ("PATH", "/Applications/Ghostty.app/Contents/MacOS:/usr/bin"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "en_US.UTF-8"),
            ("HOME", "/home/u"),
            ("SHELL", "/bin/zsh"),
            ("EDITOR", "nvim"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            (
                "XDG_DATA_DIRS",
                "/usr/share:/Applications/Ghostty.app/Contents/Resources",
            ),
            (
                "MANPATH",
                ":/Applications/Ghostty.app/Contents/Resources/man",
            ),
            ("KITTY_CONFIG_DIRECTORY", "/home/u/.config/kitty"),
            ("WEZTERM_CONFIG_FILE", "/home/u/.wezterm.lua"),
            ("ALACRITTY_EXTRA_LOG_TARGETS", "winit"),
            ("VSCODE_PORTABLE", "/opt/code-data"),
            ("TERAX_USER_ZDOTDIR", "/home/u/.config/zsh"),
            ("FLATPAK_TTY_PROGRESS", "1"),
            // Generic names only belong to a launcher whose marker is present.
            ("WINDOW", "0"),
            ("PROFILEHOME", "/home/u"),
            // The user's own terminfo and git helpers.
            ("TERMINFO", "/home/u/.terminfo"),
            ("TERMINFO_DIRS", "/opt/terminfo:/usr/share/terminfo"),
            ("GIT_ASKPASS", "/usr/lib/ssh/x11-ssh-askpass"),
            ("GIT_EDITOR", "nvim"),
        ];
        assert_eq!(stale(&env), Vec::<String>::new());
    }

    #[test]
    fn terminfo_goes_only_when_it_is_the_launchers() {
        let ghostty = [
            (
                "GHOSTTY_RESOURCES_DIR",
                "/Applications/Ghostty.app/Contents/Resources/ghostty",
            ),
            (
                "TERMINFO",
                "/Applications/Ghostty.app/Contents/Resources/terminfo",
            ),
        ];
        assert!(stale(&ghostty).contains(&"TERMINFO".to_string()));

        for terminfo in ["/usr/lib/kitty/terminfo", "b64:AAAA"] {
            let kitty = [
                ("KITTY_INSTALLATION_DIR", "/usr/lib/kitty"),
                ("TERMINFO", terminfo),
            ];
            assert!(
                stale(&kitty).contains(&"TERMINFO".to_string()),
                "{terminfo}"
            );
        }

        let iterm = [
            ("ITERM_SESSION_ID", "w0t0p0:1"),
            (
                "TERMINFO_DIRS",
                "/Applications/iTerm.app/Contents/Resources/terminfo:/usr/share/terminfo",
            ),
        ];
        assert!(stale(&iterm).contains(&"TERMINFO_DIRS".to_string()));

        let own = [
            (
                "GHOSTTY_RESOURCES_DIR",
                "/Applications/Ghostty.app/Contents/Resources/ghostty",
            ),
            ("KITTY_INSTALLATION_DIR", "/usr/lib/kitty"),
            ("ITERM_SESSION_ID", "w0t0p0:1"),
            ("TERMINFO", "/home/u/.terminfo"),
            ("TERMINFO_DIRS", "/opt/terminfo:/usr/share/terminfo"),
        ];
        let dropped = stale(&own);
        assert!(!dropped.contains(&"TERMINFO".to_string()));
        assert!(!dropped.contains(&"TERMINFO_DIRS".to_string()));
    }

    #[test]
    fn vscode_git_helpers_go_with_their_ipc() {
        let vscode = [
            ("VSCODE_GIT_ASKPASS_MAIN", "/app/git/dist/askpass-main.js"),
            ("GIT_ASKPASS", "/app/git/dist/askpass.sh"),
            ("VSCODE_GIT_EDITOR_MAIN", "/app/git/dist/git-editor-main.js"),
            ("GIT_EDITOR", "\"/app/git/dist/git-editor.sh\""),
        ];
        assert_eq!(stale(&vscode), sorted(&vscode.map(|(name, _)| name)));

        let user = [
            ("VSCODE_GIT_ASKPASS_MAIN", "/app/git/dist/askpass-main.js"),
            ("GIT_ASKPASS", "/usr/bin/ksshaskpass"),
            ("VSCODE_GIT_EDITOR_MAIN", "/app/git/dist/git-editor-main.js"),
            ("GIT_EDITOR", "vim"),
        ];
        assert_eq!(
            stale(&user),
            sorted(&["VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_EDITOR_MAIN"])
        );
    }

    #[test]
    fn wslenv_gains_missing_names_and_keeps_flags() {
        let names = ["TERM", "TERM_PROGRAM"];
        assert_eq!(wslenv_with(None, &names), "TERM:TERM_PROGRAM");
        assert_eq!(wslenv_with(Some(""), &names), "TERM:TERM_PROGRAM");
        assert_eq!(
            wslenv_with(Some("WT_SESSION:WT_PROFILE_ID:"), &names),
            "WT_SESSION:WT_PROFILE_ID:TERM:TERM_PROGRAM"
        );
        assert_eq!(
            wslenv_with(Some("TERM/u:USERPROFILE/p"), &names),
            "TERM/u:USERPROFILE/p:TERM_PROGRAM"
        );
    }
}
