//! What the webview may load through asset URLs. The configured scope is empty
//! (`tauri.conf.json`), so a script in a webview cannot read an arbitrary file that way; the
//! backend grants, at runtime:
//!
//! - every authorized workspace root, recursively, as the registry authorizes it: the editor's
//!   image, video, audio and PDF previews and the Markdown preview's images load from there.
//!   A WSL root is registered by its host path (the share or the drive), which is also what
//!   `fs_host_path` turns a WSL file into for its asset URL.
//! - each installed font face `system_font_faces` hands the terminal, as a single file.
//!
//! Wildcards follow the scope's dot rule (Tauri's default: on Unix `**` never enters a name
//! starting with a dot), so a granted home folder does not expose `~/.ssh`.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::utils::config::FsScope;
use tauri::Manager;

use super::workspace::WorkspaceRegistry;

pub struct AssetScope {
    scope: tauri::scope::fs::Scope,
    literal_leading_dot: bool,
    granted_roots: Mutex<Vec<PathBuf>>,
}

/// Whether the configured scope's wildcards skip names that start with a dot, as Tauri
/// decides it.
fn literal_leading_dot(config: &FsScope) -> bool {
    match config {
        FsScope::Scope {
            require_literal_leading_dot: Some(required),
            ..
        } => *required,
        _ => cfg!(unix),
    }
}

/// Whether a recursive grant of `granted` already lets the scope serve everything under
/// `root`: `root` lies inside it, and no folder on the way down is one its wildcard skips.
fn covers(granted: &Path, root: &Path, literal_leading_dot: bool) -> bool {
    let Ok(rest) = root.strip_prefix(granted) else {
        return false;
    };
    !literal_leading_dot
        || rest.components().all(|component| match component {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => true,
        })
}

/// Whether a newly authorized `root` needs a grant of its own. A root the earlier grants
/// already cover adds nothing; skipping it keeps the scope's pattern list, which every asset
/// request scans, from growing with each folder a terminal visits.
fn needs_grant(root: &Path, granted: &[PathBuf], literal_leading_dot: bool) -> bool {
    !granted
        .iter()
        .any(|granted| covers(granted, root, literal_leading_dot))
}

impl AssetScope {
    fn grant_root(&self, root: &Path) {
        let mut granted = self
            .granted_roots
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !needs_grant(root, &granted, self.literal_leading_dot) {
            return;
        }
        match self.scope.allow_directory(root, true) {
            Ok(()) => granted.push(root.to_path_buf()),
            Err(e) => log::warn!("asset scope: cannot grant {}: {e}", root.display()),
        }
    }

    /// Lets the webview load one file, such as a font face the backend chose.
    pub fn grant_file(&self, file: &Path) {
        if let Err(e) = self.scope.allow_file(file) {
            log::warn!("asset scope: cannot grant {}: {e}", file.display());
        }
    }
}

/// Grants every workspace root the registry has authorized and will authorize.
pub fn install(app: &tauri::AppHandle) {
    app.manage(AssetScope {
        scope: app.asset_protocol_scope(),
        literal_leading_dot: literal_leading_dot(&app.config().app.security.asset_protocol.scope),
        granted_roots: Mutex::new(Vec::new()),
    });
    let handle = app.clone();
    app.state::<WorkspaceRegistry>()
        .watch_roots(move |root| handle.state::<AssetScope>().grant_root(root));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn the_first_root_is_granted() {
        assert!(needs_grant(Path::new("/home/me"), &[], true));
    }

    #[test]
    fn a_root_inside_a_granted_one_adds_nothing() {
        let granted = paths(&["/home/me"]);
        for dot_rule in [true, false] {
            assert!(!needs_grant(Path::new("/home/me"), &granted, dot_rule));
            assert!(!needs_grant(
                Path::new("/home/me/src/app"),
                &granted,
                dot_rule
            ));
        }
    }

    #[test]
    fn a_dot_folder_needs_its_own_grant_where_wildcards_skip_it() {
        let granted = paths(&["/home/me"]);
        assert!(needs_grant(
            Path::new("/home/me/.config/nvim"),
            &granted,
            true
        ));
        assert!(needs_grant(
            Path::new("/home/me/src/.hidden/x"),
            &granted,
            true
        ));
        assert!(!needs_grant(
            Path::new("/home/me/.config/nvim"),
            &granted,
            false
        ));
        let inside_dot_root = paths(&["/home/me/.config"]);
        assert!(!needs_grant(
            Path::new("/home/me/.config/nvim"),
            &inside_dot_root,
            true
        ));
    }

    #[test]
    fn a_sibling_or_a_parent_is_granted() {
        let granted = paths(&["/home/me/app"]);
        assert!(needs_grant(Path::new("/home/me/app2"), &granted, true));
        assert!(needs_grant(Path::new("/home/me"), &granted, true));
        assert!(needs_grant(Path::new("/srv/data"), &granted, true));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_and_drive_roots_are_matched_as_paths() {
        let granted = paths(&[r"\\?\UNC\wsl.localhost\Ubuntu\home\me", r"\\?\C:\Users\me"]);
        assert!(!needs_grant(
            Path::new(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\src"),
            &granted,
            false
        ));
        assert!(needs_grant(
            Path::new(r"\\?\UNC\wsl.localhost\Debian\home\me"),
            &granted,
            false
        ));
        assert!(!needs_grant(
            Path::new(r"\\?\C:\Users\me\.ssh"),
            &granted,
            false
        ));
        assert!(needs_grant(Path::new(r"\\?\D:\photos"), &granted, false));
    }

    #[test]
    fn the_dot_rule_follows_the_config_and_tauris_default() {
        assert_eq!(literal_leading_dot(&FsScope::default()), cfg!(unix));
        let explicit = |required| FsScope::Scope {
            allow: Vec::new(),
            deny: Vec::new(),
            require_literal_leading_dot: Some(required),
        };
        assert!(literal_leading_dot(&explicit(true)));
        assert!(!literal_leading_dot(&explicit(false)));
    }

    #[test]
    fn nothing_is_allowed_by_configuration() {
        let configs = [
            include_str!("../../tauri.conf.json"),
            include_str!("../../tauri.linux.conf.json"),
            include_str!("../../tauri.windows.conf.json"),
        ];
        for (i, config) in configs.into_iter().enumerate() {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let scope = &config["app"]["security"]["assetProtocol"]["scope"];
            if scope.is_null() && i > 0 {
                continue;
            }
            let scope: FsScope = serde_json::from_value(scope.clone()).unwrap();
            assert!(scope.allowed_paths().is_empty(), "{scope:?}");
        }
    }
}
