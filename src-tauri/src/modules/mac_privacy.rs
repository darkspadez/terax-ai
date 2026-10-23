//! What macOS privacy controls (TCC) let Oarlock reach, as far as an app can tell
//! without macOS asking the user.
//!
//! TCC treats Oarlock and every program its terminals start as one app. Full Disk
//! Access is the only grant an app can test silently: the files that need it are
//! refused (`EPERM`) without a prompt, and open with it. Desktop, Documents,
//! Downloads, iCloud Drive and removable and network volumes are asked about the
//! first time Oarlock opens them, so opening one to find out could put up that
//! prompt. Their state is therefore known here only through Full Disk Access; the
//! page explains a refusal where it happens.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What a privacy refusal returns; `EACCES` is the file's own permissions. 1 on
/// every Unix.
const EPERM: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Allowed,
    Denied,
    /// No probe file told: each was missing or unreadable for another reason.
    Unknown,
}

/// What opening one probe file said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Opened,
    Refused,
    Inconclusive,
}

impl Probe {
    pub fn of<T>(result: &std::io::Result<T>) -> Self {
        match result {
            Ok(_) => Self::Opened,
            Err(error) if error.raw_os_error() == Some(EPERM) => Self::Refused,
            Err(_) => Self::Inconclusive,
        }
    }
}

/// A search's root listing that macOS privacy controls refused, as the error the
/// page explains; any other outcome lets the search go on as before.
pub fn refused<T>(listing: std::io::Result<T>) -> Result<(), String> {
    match listing {
        Err(error) if error.raw_os_error() == Some(EPERM) => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Full Disk Access as the first probe that tells has it. Probes are taken in
/// order and only as far as needed.
pub fn full_disk_access(probes: impl IntoIterator<Item = Probe>) -> Access {
    for probe in probes {
        match probe {
            Probe::Opened => return Access::Allowed,
            Probe::Refused => return Access::Denied,
            Probe::Inconclusive => {}
        }
    }
    Access::Unknown
}

/// Files only Full Disk Access opens: the TCC databases, which TCC itself guards
/// on every release. The user's exists for every user and its owner may read it,
/// so only TCC refuses it; the system's sits in a folder that is `drwx------` on
/// some Macs, which reads as inconclusive. Opening either never prompts. Files
/// whose protection could change between releases are left out, since an
/// unprotected one would read as allowed, and so is `~/Library/Containers`,
/// where other apps' data asks the user.
pub fn probe_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(2);
    if let Some(home) = home {
        paths.push(home.join("Library/Application Support/com.apple.TCC/TCC.db"));
    }
    paths.push(PathBuf::from(
        "/Library/Application Support/com.apple.TCC/TCC.db",
    ));
    paths
}

/// A System Settings pane the page may open; it never names a URL itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPane {
    FullDiskAccess,
    /// Every folder and volume switch. The per-folder anchors
    /// (`Privacy_DesktopFolder`, ...) are left from System Preferences; System
    /// Settings (macOS 13, Oarlock's minimum) lists them all for each app under
    /// Files and Folders.
    FilesAndFolders,
}

impl SettingsPane {
    /// The legacy pane id still routes to Privacy & Security in System Settings.
    pub fn url(self) -> &'static str {
        match self {
            Self::FullDiskAccess => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            }
            Self::FilesAndFolders => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStatus {
    full_disk_access: Access,
}

/// Opens at most two files, so the Settings window can ask again whenever it
/// regains focus.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn mac_privacy_status() -> Result<PrivacyStatus, String> {
    super::fs::blocking(|| {
        let home = dirs::home_dir();
        let probes = probe_paths(home.as_deref())
            .into_iter()
            .map(|path| Probe::of(&std::fs::File::open(path)));
        Ok(PrivacyStatus {
            full_disk_access: full_disk_access(probes),
        })
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn mac_privacy_open_settings(
    app: tauri::AppHandle,
    pane: SettingsPane,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    super::fs::blocking(move || {
        app.opener()
            .open_url(pane.url(), None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    fn refused_probe() -> std::io::Result<()> {
        Err(Error::from_raw_os_error(EPERM))
    }

    #[test]
    fn only_eperm_is_a_refusal() {
        assert_eq!(Probe::of(&Ok(())), Probe::Opened);
        assert_eq!(Probe::of(&refused_probe()), Probe::Refused);
        // EACCES: the file's own permissions, which say nothing about TCC.
        assert_eq!(
            Probe::of::<()>(&Err(Error::from_raw_os_error(13))),
            Probe::Inconclusive
        );
        assert_eq!(
            Probe::of::<()>(&Err(Error::from(ErrorKind::NotFound))),
            Probe::Inconclusive
        );
        // PermissionDenied without an errno is not known to be a refusal.
        assert_eq!(
            Probe::of::<()>(&Err(Error::from(ErrorKind::PermissionDenied))),
            Probe::Inconclusive
        );
    }

    #[test]
    fn a_search_reports_only_a_refused_root() {
        assert_eq!(
            refused(refused_probe()),
            Err(Error::from_raw_os_error(EPERM).to_string())
        );
        assert_eq!(refused(Ok(())), Ok(()));
        // Unreadable for another reason: the search goes on as it always did.
        assert_eq!(refused::<()>(Err(Error::from_raw_os_error(13))), Ok(()));
        assert_eq!(refused::<()>(Err(Error::from(ErrorKind::NotFound))), Ok(()));
    }

    #[test]
    fn the_first_probe_that_tells_decides() {
        use Probe::*;
        assert_eq!(full_disk_access([Opened]), Access::Allowed);
        assert_eq!(full_disk_access([Refused]), Access::Denied);
        assert_eq!(
            full_disk_access([Inconclusive, Opened, Refused]),
            Access::Allowed
        );
        assert_eq!(
            full_disk_access([Inconclusive, Refused, Opened]),
            Access::Denied
        );
        assert_eq!(
            full_disk_access([Inconclusive, Inconclusive]),
            Access::Unknown
        );
        assert_eq!(full_disk_access([]), Access::Unknown);
    }

    #[test]
    fn probes_stop_once_one_tells() {
        let mut taken = 0;
        let probes = [Probe::Inconclusive, Probe::Refused, Probe::Opened]
            .into_iter()
            .inspect(|_| taken += 1);
        assert_eq!(full_disk_access(probes), Access::Denied);
        assert_eq!(taken, 2);
    }

    #[test]
    fn probes_the_users_tcc_database_first() {
        let paths = probe_paths(Some(Path::new("/Users/me")));
        assert_eq!(
            paths,
            [
                PathBuf::from("/Users/me/Library/Application Support/com.apple.TCC/TCC.db"),
                PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db"),
            ]
        );
        assert_eq!(probe_paths(None), paths[1..]);
    }

    #[test]
    fn probes_nothing_that_asks_the_user() {
        // Folders macOS asks about, and other apps' data, which it asks about too.
        let asking = [
            "/Desktop",
            "/Documents",
            "/Downloads",
            "/Library/Mobile Documents",
            "/Library/Containers",
            "/Library/Group Containers",
            "/Volumes",
        ];
        for path in probe_paths(Some(Path::new("/Users/me"))) {
            let path = path.to_string_lossy().into_owned();
            assert!(asking.iter().all(|place| !path.contains(place)), "{path}");
        }
    }

    #[test]
    fn panes_open_privacy_and_security() {
        assert_eq!(
            SettingsPane::FullDiskAccess.url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
        assert_eq!(
            SettingsPane::FilesAndFolders.url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        );
    }

    #[test]
    fn the_page_names_a_pane_never_a_url() {
        let pane: SettingsPane = serde_json::from_str("\"filesAndFolders\"").unwrap();
        assert_eq!(pane, SettingsPane::FilesAndFolders);
        let pane: SettingsPane = serde_json::from_str("\"fullDiskAccess\"").unwrap();
        assert_eq!(pane, SettingsPane::FullDiskAccess);
        for refused in [
            "\"x-apple.systempreferences:com.apple.preference.security\"",
            "\"https://example.com\"",
            "\"FullDiskAccess\"",
        ] {
            assert!(serde_json::from_str::<SettingsPane>(refused).is_err());
        }
    }
}
