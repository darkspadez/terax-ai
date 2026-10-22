//! Whether the OS would run a file as a program when it opens it in its default app.
//! "Open in Default App" (`file::fs_open_default`) opens documents at once and asks the user
//! first for anything classified here as a program. The OS picks the handler, which Terax
//! cannot see, so the rules err toward asking: an unneeded question costs a click, a missed one
//! runs code.

use std::io::Read;
use std::path::Path;

/// The OS that opens the file. Each picks the handler its own way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    /// ShellExecute: the handler comes from the extension alone.
    Windows,
    /// LaunchServices (`open`): the extension, the execute bit and the content.
    MacOs,
    /// `xdg-open` and the desktop's handlers; also the other Unix systems.
    Linux,
}

impl Host {
    pub const CURRENT: Self = if cfg!(windows) {
        Self::Windows
    } else if cfg!(target_os = "macos") {
        Self::MacOs
    } else {
        Self::Linux
    };
}

/// What the classifier reads about a file.
pub struct FileFacts<'a> {
    /// The last component of the file's real path.
    pub name: &'a str,
    /// Any execute permission bit is set (never on Windows).
    pub executable: bool,
    /// The file's first `HEAD_LEN` bytes, fewer for a short or unreadable file.
    pub head: &'a [u8],
}

pub const HEAD_LEN: usize = 4;

/// Windows programs, and the shortcuts and location files that start whatever they point at.
const WINDOWS_LAUNCHERS: &[&str] = &[
    "exe",
    "com",
    "scr",
    "pif",
    "cpl",
    "msc",
    "hta",
    "gadget",
    "application",
    "appref-ms",
    "xbap",
    "lnk",
    "url",
    "website",
    "scf",
    "settingcontent-ms",
];

const WINDOWS_INSTALLERS: &[&str] = &[
    "msi",
    "msp",
    "mst",
    "msu",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appinstaller",
    "diagcab",
];

/// Scripts for cmd, PowerShell and Windows Script Host, and for runtimes that register
/// themselves as the handler (Python, Java, Perl, Git Bash).
const WINDOWS_SCRIPTS: &[&str] = &[
    "bat", "cmd", "ps1", "psm1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "msh", "msh1", "msh2",
    "mshxml", "msh1xml", "msh2xml", "vb", "vbs", "vbe", "js", "jse", "ws", "wsf", "wsh", "wsc",
    "sct", "py", "pyw", "pyz", "pyzw", "pyc", "pyo", "jar", "jnlp", "pl", "sh", "bash",
];

/// Settings Windows applies, help files that run script, and add-ins another program loads
/// as code.
const WINDOWS_LOADED: &[&str] = &[
    "reg",
    "theme",
    "themepack",
    "deskthemepack",
    "wsb",
    "ins",
    "isp",
    "chm",
    "hlp",
    "xll",
    "xla",
    "xlam",
    "ppa",
    "ppam",
    "vsto",
];

const WINDOWS_PROGRAMS: &[&[&str]] = &[
    WINDOWS_LAUNCHERS,
    WINDOWS_INSTALLERS,
    WINDOWS_SCRIPTS,
    WINDOWS_LOADED,
];

/// macOS applications and the bundles System Settings or Automator install.
const MACOS_BUNDLES: &[&str] = &["app", "prefpane", "saver", "workflow", "action", "wdgt"];

/// Scripts Terminal runs, and Terminal settings files, which can run a command.
const MACOS_TERMINAL: &[&str] = &[
    "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "tcsh", "ksh",
];

/// Installers, location files (which open whatever they point at), and scripts a registered
/// launcher runs (Python Launcher, Jar Launcher).
const MACOS_OTHER: &[&str] = &[
    "pkg", "mpkg", "fileloc", "webloc", "inetloc", "py", "pyw", "jar", "jnlp",
];

/// Linux launchers and self-contained programs, shell scripts (a file manager may offer to
/// run them), packages a software center installs, and Java archives.
const LINUX_PROGRAMS: &[&str] = &[
    "desktop",
    "appimage",
    "run",
    "sh",
    "bash",
    "zsh",
    "csh",
    "tcsh",
    "ksh",
    "fish",
    "deb",
    "rpm",
    "snap",
    "flatpak",
    "flatpakref",
    "flatpakrepo",
    "jar",
    "jnlp",
];

/// Windows programs, which Wine or CrossOver run on macOS and Linux when installed.
const WINE_PROGRAMS: &[&str] = &["exe", "com", "scr", "pif", "msi", "bat", "cmd", "lnk"];

const MACOS_PROGRAMS: &[&[&str]] = &[MACOS_BUNDLES, MACOS_TERMINAL, MACOS_OTHER, WINE_PROGRAMS];

const LINUX_AND_WINE_PROGRAMS: &[&[&str]] = &[LINUX_PROGRAMS, WINE_PROGRAMS];

/// Mach-O thin (both word sizes, both byte orders) and universal binaries. The universal
/// magic is also a Java class file's, which asking about is harmless.
const MACH_O_MAGIC: &[[u8; 4]] = &[
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
];

/// The extension the OS picks the handler by, lowercased. A dotfile's name counts as its
/// extension (`*.desktop` globs match `.desktop`). Windows ignores trailing dots and spaces
/// when it opens a path, so they are ignored here too.
fn extension(host: Host, name: &str) -> Option<String> {
    let name = if host == Host::Windows {
        name.trim_end_matches(['.', ' '])
    } else {
        name
    };
    let (_, ext) = name.rsplit_once('.')?;
    (!ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

fn is_mach_o(head: &[u8]) -> bool {
    MACH_O_MAGIC.iter().any(|magic| head.starts_with(magic))
}

fn is_elf(head: &[u8]) -> bool {
    head.starts_with(b"\x7fELF")
}

/// A DOS or Windows executable, which Wine runs on macOS and Linux.
fn is_pe(head: &[u8]) -> bool {
    head.starts_with(b"MZ")
}

/// Whether `host` would run the file as a program instead of showing it as a document.
pub fn runs_as_program(host: Host, file: &FileFacts) -> bool {
    let ext = extension(host, file.name);
    let listed = |groups: &[&[&str]]| {
        ext.as_deref()
            .is_some_and(|ext| groups.iter().any(|group| group.contains(&ext)))
    };
    match host {
        // A colon names an alternate data stream, whose handler is not the visible extension's.
        Host::Windows => file.name.contains(':') || listed(WINDOWS_PROGRAMS),
        Host::MacOs => {
            file.executable || is_mach_o(file.head) || is_pe(file.head) || listed(MACOS_PROGRAMS)
        }
        Host::Linux => {
            file.executable
                || is_elf(file.head)
                || is_pe(file.head)
                || listed(LINUX_AND_WINE_PROGRAMS)
        }
    }
}

/// `runs_as_program` for a file on disk, as this OS would open it. Permissions that cannot be
/// read count as executable, so the user is asked.
pub fn file_runs_as_program(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let mut head = Vec::with_capacity(HEAD_LEN);
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(HEAD_LEN as u64).read_to_end(&mut head);
    }
    runs_as_program(
        Host::CURRENT,
        &FileFacts {
            name: &name,
            executable: is_executable(path),
            head: &head,
        },
    )
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(true)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Host; 3] = [Host::Windows, Host::MacOs, Host::Linux];

    fn named(host: Host, name: &str) -> bool {
        runs_as_program(
            host,
            &FileFacts {
                name,
                executable: false,
                head: b"",
            },
        )
    }

    #[test]
    fn documents_open_on_every_host() {
        for host in ALL {
            for name in [
                "report.pdf",
                "photo.PNG",
                "notes.txt",
                "deck.pptx",
                "sheet.xlsx",
                "song.mp3",
                "page.html",
                "archive.zip",
                "Makefile",
                "README",
                "data.json",
            ] {
                assert!(!named(host, name), "{name} on {host:?}");
            }
        }
    }

    #[test]
    fn windows_runs_programs_scripts_and_shortcuts() {
        for name in [
            "setup.exe",
            "old.com",
            "run.bat",
            "build.cmd",
            "deploy.ps1",
            "macro.vbs",
            "macro.vbe",
            "app.js",
            "app.jse",
            "job.wsf",
            "job.wsh",
            "install.msi",
            "console.msc",
            "saver.scr",
            "panel.cpl",
            "page.hta",
            "legacy.pif",
            "shortcut.lnk",
            "tweak.reg",
            "tool.application",
            "script.py",
            "tool.jar",
            "hook.sh",
            "link.url",
            "help.chm",
            "addin.xll",
        ] {
            assert!(named(Host::Windows, name), "{name}");
        }
    }

    #[test]
    fn windows_matching_ignores_case_and_what_windows_strips() {
        assert!(named(Host::Windows, "SETUP.EXE"));
        assert!(named(Host::Windows, "Run.Bat"));
        assert!(named(Host::Windows, "setup.exe."));
        assert!(named(Host::Windows, "setup.exe . "));
        assert!(named(Host::Windows, ".exe"));
    }

    #[test]
    fn windows_asks_for_an_alternate_data_stream() {
        assert!(named(Host::Windows, "notes.txt:payload.exe"));
        assert!(named(Host::Windows, "notes.txt:hidden"));
    }

    #[test]
    fn windows_goes_by_the_extension_alone() {
        let facts = FileFacts {
            name: "photo.png",
            executable: true,
            head: b"MZ\x90\x00",
        };
        assert!(!runs_as_program(Host::Windows, &facts));
        assert!(!named(Host::Windows, "setup.exe.txt"));
        assert!(!named(Host::Windows, "tool"));
    }

    #[test]
    fn macos_runs_bundles_terminal_scripts_installers_and_location_files() {
        for name in [
            "Tool.app",
            "Pane.prefPane",
            "Flow.workflow",
            "run.command",
            "run.tool",
            "Profile.terminal",
            "Install.pkg",
            "Install.mpkg",
            "build.sh",
            "Target.fileloc",
            "Site.webloc",
            "script.py",
            "Tool.jar",
            "setup.exe",
        ] {
            assert!(named(Host::MacOs, name), "{name}");
        }
    }

    #[test]
    fn macos_runs_mach_o_binaries_and_executables() {
        for head in [
            &[0xcf, 0xfa, 0xed, 0xfe][..],
            &[0xfe, 0xed, 0xfa, 0xcf],
            &[0xce, 0xfa, 0xed, 0xfe],
            &[0xca, 0xfe, 0xba, 0xbe],
        ] {
            let facts = FileFacts {
                name: "tool",
                executable: false,
                head,
            };
            assert!(runs_as_program(Host::MacOs, &facts), "{head:x?}");
        }
        let script = FileFacts {
            name: "notes.txt",
            executable: true,
            head: b"#!/b",
        };
        assert!(runs_as_program(Host::MacOs, &script));
        let elf = FileFacts {
            name: "tool",
            executable: false,
            head: b"\x7fELF",
        };
        assert!(!runs_as_program(Host::MacOs, &elf), "macOS cannot run ELF");
    }

    #[test]
    fn linux_runs_executables_launchers_scripts_and_packages() {
        for name in [
            "app.desktop",
            ".desktop",
            "Tool.AppImage",
            "Tool.appimage",
            "installer.run",
            "build.sh",
            "tool.deb",
            "tool.rpm",
            "app.flatpakref",
            "tool.jar",
            "setup.exe",
            "install.msi",
        ] {
            assert!(named(Host::Linux, name), "{name}");
        }
        let executable = FileFacts {
            name: "photo.png",
            executable: true,
            head: b"\x89PNG",
        };
        assert!(runs_as_program(Host::Linux, &executable));
        for head in [&b"\x7fELF"[..], b"MZ\x90\x00"] {
            let binary = FileFacts {
                name: "tool",
                executable: false,
                head,
            };
            assert!(runs_as_program(Host::Linux, &binary), "{head:x?}");
        }
        assert!(!named(Host::Linux, "Tool.command"), "a macOS-only type");
    }

    #[test]
    fn a_short_head_is_not_a_binary() {
        for host in ALL {
            let facts = FileFacts {
                name: "x",
                executable: false,
                head: b"\x7f",
            };
            assert!(!runs_as_program(host, &facts), "{host:?}");
        }
    }

    #[test]
    fn reads_the_facts_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("notes.pdf");
        std::fs::write(&doc, b"%PDF-1.7").unwrap();
        assert!(!file_runs_as_program(&doc));
        let script = dir.path().join("run.bat");
        std::fs::write(&script, b"@echo off").unwrap();
        assert!(file_runs_as_program(&script), "listed on every host");
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_execute_bit_and_the_magic() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("tool");
        std::fs::write(&tool, b"echo hi").unwrap();
        assert!(!file_runs_as_program(&tool));
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(file_runs_as_program(&tool));

        let binary = dir.path().join("binary");
        let magic: &[u8] = if Host::CURRENT == Host::MacOs {
            &[0xcf, 0xfa, 0xed, 0xfe, 0x07]
        } else {
            b"\x7fELF\x02"
        };
        std::fs::write(&binary, magic).unwrap();
        assert!(file_runs_as_program(&binary));
    }
}
