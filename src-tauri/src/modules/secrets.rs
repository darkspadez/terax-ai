//! Secret storage with platform-appropriate backends.
//!
//! - macOS: the login Keychain (`keyring-core` + `apple-native-keyring-store`)
//! - Windows: Credential Manager (`keyring-core` + `windows-native-keyring-store`)
//!   Both stores keep the item layout of `keyring` 3 (generic password with
//!   service/account; Windows target `account.service`, UTF-16 blob), so keys
//!   saved by earlier releases are found; `keychain_compat` tests lock that.
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` — no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[derive(Default)]
pub struct SecretsState {
    #[cfg(target_os = "linux")]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(target_os = "linux"))]
    _phantom: Mutex<()>,
}

#[cfg(target_os = "linux")]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    read_store_at(&store_path(app)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    write_store_at(&store_path(app)?, map)
}

#[cfg(target_os = "linux")]
pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

/// The platform credential store, created on first use.
#[cfg(not(target_os = "linux"))]
fn store() -> Result<&'static std::sync::Arc<keyring_core::CredentialStore>, String> {
    use std::sync::{Arc, OnceLock};
    static STORE: OnceLock<Result<Arc<keyring_core::CredentialStore>, String>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(target_os = "windows")]
            let store = windows_native_keyring_store::Store::new();
            store
                .map(|store| store as Arc<keyring_core::CredentialStore>)
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn entry(service: &str, account: &str) -> Result<keyring_core::Entry, String> {
    store()?
        .build(service, account, None)
        .map_err(|e| e.to_string())
}

/// Whether a page may use the `secrets_*` commands on `service`. MCP secrets
/// (`mcp::SECRET_SERVICE`) are written through `mcp_secret_set` and read only
/// by the backend, when it starts a server or sends a request, so no page can
/// read them back.
fn page_may_use_service(service: &str) -> Result<(), String> {
    if service == crate::modules::mcp::SECRET_SERVICE {
        return Err("secrets: this service is not readable from the page".into());
    }
    Ok(())
}

/// Reads secrets for the backend's own use; they never cross IPC.
pub(crate) async fn backend_get(
    app: AppHandle,
    service: &'static str,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    blocking_secret(app, move |app, state| {
        accounts
            .iter()
            .map(|account| get_secret(app, state, service, account))
            .collect()
    })
    .await
}

pub(crate) async fn backend_set(
    app: AppHandle,
    service: &'static str,
    account: String,
    value: String,
) -> Result<(), String> {
    blocking_secret(app, move |app, state| {
        set_secret(app, state, service, &account, value)
    })
    .await
}

pub(crate) async fn backend_delete(
    app: AppHandle,
    service: &'static str,
    accounts: Vec<String>,
) -> Result<(), String> {
    blocking_secret(app, move |app, state| {
        accounts
            .iter()
            .try_for_each(|account| delete_secret(app, state, service, account))
    })
    .await
}

// The keychain and the Linux file store both block (a locked keychain can wait
// on the user), so every command runs on the blocking pool.
fn blocking_secret<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&AppHandle, &SecretsState) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    crate::modules::fs::blocking(move || {
        let state = app.state::<SecretsState>();
        work(&app, &state)
    })
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    page_may_use_service(&service)?;
    blocking_secret(app, move |app, state| {
        get_secret(app, state, &service, &account)
    })
    .await
}

fn get_secret(
    app: &AppHandle,
    state: &SecretsState,
    service: &str,
    account: &str,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(service, account);
        with_store(app, state, |m| m.get(&key).cloned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(service, account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    page_may_use_service(&service)?;
    blocking_secret(app, move |app, state| {
        set_secret(app, state, &service, &account, password)
    })
    .await
}

fn set_secret(
    app: &AppHandle,
    state: &SecretsState,
    service: &str,
    account: &str,
    password: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(service, account);
        with_store(app, state, |m| {
            m.insert(key, password);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(service, account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    service: String,
    account: String,
) -> Result<(), String> {
    page_may_use_service(&service)?;
    blocking_secret(app, move |app, state| {
        delete_secret(app, state, &service, &account)
    })
    .await
}

fn delete_secret(
    app: &AppHandle,
    state: &SecretsState,
    service: &str,
    account: &str,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(service, account);
        with_store(app, state, |m| {
            m.remove(&key);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(service, account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use tempfile::TempDir;

    #[test]
    fn key_format_is_service_double_colon_account() {
        assert_eq!(key("openai", "alice"), "openai::alice");
        assert_eq!(key("", ""), "::");
    }

    #[test]
    fn read_store_at_missing_path_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.json");
        let map = read_store_at(&p).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        let mut m = HashMap::new();
        m.insert(key("svc", "alice"), "p1".into());
        m.insert(key("svc", "bob"), "p2".into());

        write_store_at(&p, &m).unwrap();
        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn write_uses_mode_0600() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let mode = fs::metadata(&p).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be user-only readable");
    }

    #[test]
    fn write_does_not_leave_tmp_file_on_success() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let tmp_path = p.with_extension("json.tmp");
        assert!(
            !tmp_path.exists(),
            "tmp file must be renamed away on success"
        );
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");

        let mut first = HashMap::new();
        first.insert("a".into(), "1".into());
        write_store_at(&p, &first).unwrap();

        let mut second = HashMap::new();
        second.insert("b".into(), "2".into());
        write_store_at(&p, &second).unwrap();

        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, second);
        assert!(!loaded.contains_key("a"));
    }

    #[test]
    fn read_store_at_garbage_file_errors() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        fs::write(&p, b"not json").unwrap();
        assert!(read_store_at(&p).is_err());
    }
}

/// Uses the real Keychain / Credential Manager, so it is ignored by default;
/// CI runs it on macOS and Windows (`cargo nextest run --run-ignored only`).
#[cfg(all(test, not(target_os = "linux")))]
mod keychain_compat {
    use super::entry;

    /// Deletes the test item however the test ends.
    struct Cleanup(String, String);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(item) = keyring3::Entry::new(&self.0, &self.1) {
                let _ = item.delete_credential();
            }
        }
    }

    fn unique_item() -> Cleanup {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Cleanup(
            format!("app.crynta.terax.test.{}.{nanos}", std::process::id()),
            "openai".into(),
        )
    }

    #[test]
    #[ignore = "uses the real keychain; CI runs it on macOS and Windows"]
    fn keychain_compat_reads_and_replaces_keyring3_items() {
        let item = unique_item();
        let (service, account) = (&item.0, &item.1);
        let old = keyring3::Entry::new(service, account).unwrap();
        old.set_password("sk-written-by-keyring-3 \u{1f511}")
            .unwrap();

        let new = entry(service, account).unwrap();
        assert_eq!(
            new.get_password().unwrap(),
            "sk-written-by-keyring-3 \u{1f511}"
        );

        new.set_password("sk-written-by-keyring-core").unwrap();
        assert_eq!(old.get_password().unwrap(), "sk-written-by-keyring-core");

        new.delete_credential().unwrap();
        assert!(matches!(old.get_password(), Err(keyring3::Error::NoEntry)));
        assert!(matches!(
            new.get_password(),
            Err(keyring_core::Error::NoEntry)
        ));
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    page_may_use_service(&service)?;
    blocking_secret(app, move |app, state| {
        get_all_secrets(app, state, &service, accounts)
    })
    .await
}

fn get_all_secrets(
    app: &AppHandle,
    state: &SecretsState,
    service: &str,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(target_os = "linux")]
    {
        with_store(app, state, |m| {
            accounts
                .iter()
                .map(|a| m.get(&key(service, a)).cloned())
                .collect()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| entry(service, &a).ok().and_then(|e| e.get_password().ok()))
            .collect())
    }
}

#[cfg(test)]
mod page_access {
    use super::page_may_use_service;

    #[test]
    fn pages_cannot_use_the_mcp_secret_service() {
        assert!(page_may_use_service("terax-ai").is_ok());
        assert!(page_may_use_service(crate::modules::mcp::SECRET_SERVICE).is_err());
    }
}
