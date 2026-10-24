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
//! A value is one item, exactly as `keyring` 3 wrote it, unless the store
//! cannot hold it in one: Credential Manager keeps at most 2,560 bytes of
//! UTF-16 per item. A longer value is split: its first item holds a head
//! (`HEAD`, the item count and a digest of the value) and the value's start,
//! items `<account>:1` to `<account>:<count - 1>` the rest. Every read and
//! write goes through `read_value` and `write_value`, so callers never see
//! chunks. A set that lost a chunk or mixes two writes fails the digest and
//! reads as missing, never as another value. A value is at most 32 KiB
//! (`MAX_VALUE_BYTES`) on every platform.
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
    /// Held for a whole read, write or delete, so no one sees a value half
    /// written.
    #[cfg(not(target_os = "linux"))]
    busy: Mutex<()>,
}

/// The longest value kept: 32 KiB of UTF-8, at most 26 items on Windows.
pub const MAX_VALUE_BYTES: usize = 32 * 1024;

/// UTF-16 units one item holds: Credential Manager keeps at most 2,560 bytes
/// (`CRED_MAX_CREDENTIAL_BLOB_SIZE`). A Keychain item and the Linux file have
/// no such limit, so values are never split there.
const ITEM_UNITS: Option<usize> = if cfg!(target_os = "windows") {
    Some(1280)
} else {
    None
};

/// Starts the first item of a split value. No key or token starts with a
/// control character, and a value that starts with this is always written
/// split, so a whole value is never taken for a head.
const HEAD: &str = "\x01oarlock-chunks:";
const MAX_CHUNKS: usize = 32;
/// Hex digits of the value's SHA-256 a head carries.
const DIGEST_HEX: usize = 16;
/// The longest head: the marker, a count of two digits and the digest, each
/// closed by `:`.
const HEAD_UNITS: usize = HEAD.len() + 3 + DIGEST_HEX + 1;

/// The account of chunk `index` (1 and up) of a split value.
fn chunk_account(account: &str, index: usize) -> String {
    format!("{account}:{index}")
}

/// Whether `account` is named like a chunk of another. No account Oarlock
/// uses is (MCP names never hold `:`), and no page may name one.
pub(crate) fn is_chunk_account(account: &str) -> bool {
    account
        .rsplit_once(':')
        .is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn digest(value: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes())[..DIGEST_HEX / 2]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The items `value` is kept in, the first under the account itself: the
/// value alone when it fits in `item_units` (None: no limit) and cannot be
/// taken for a head, else a head item and the chunks after it. A character
/// is never cut in two.
fn split_value(value: &str, item_units: Option<usize>) -> Result<Vec<String>, String> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!(
            "secrets: the value is longer than {} KiB",
            MAX_VALUE_BYTES / 1024
        ));
    }
    let fits = item_units.is_none_or(|max| value.encode_utf16().count() <= max);
    if fits && !value.starts_with(HEAD) {
        return Ok(vec![value.to_owned()]);
    }
    let max = item_units.unwrap_or(usize::MAX);
    debug_assert!(max > HEAD_UNITS + 1);
    let mut chunks = vec![String::new()];
    let mut room = max - HEAD_UNITS;
    for ch in value.chars() {
        let units = ch.len_utf16();
        if units > room {
            chunks.push(String::new());
            room = max;
        }
        chunks.last_mut().expect("never empty").push(ch);
        room -= units;
    }
    if chunks.len() > MAX_CHUNKS {
        return Err("secrets: the value is too long to keep".into());
    }
    chunks[0] = format!("{HEAD}{}:{}:{}", chunks.len(), digest(value), chunks[0]);
    Ok(chunks)
}

/// What the first item of an account holds.
#[derive(Debug, PartialEq, Eq)]
enum Head<'a> {
    /// The whole value.
    Whole,
    /// The start of a value kept in `count` items, whose digest is `digest`.
    Split {
        count: usize,
        digest: &'a str,
        data: &'a str,
    },
    /// A head that cannot be read.
    Damaged,
}

fn parse_head(first: &str) -> Head<'_> {
    let Some(rest) = first.strip_prefix(HEAD) else {
        return Head::Whole;
    };
    let mut parts = rest.splitn(3, ':');
    let (Some(count), Some(digest), Some(data)) = (parts.next(), parts.next(), parts.next())
    else {
        return Head::Damaged;
    };
    let count = count
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=MAX_CHUNKS).contains(n) && n.to_string() == count);
    let digest_ok = digest.len() == DIGEST_HEX
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    match count {
        Some(count) if digest_ok => Head::Split {
            count,
            digest,
            data,
        },
        _ => Head::Damaged,
    }
}

/// The value a head's data and the chunks after it make, or None when one
/// is missing or they do not match the head's digest.
fn join_value(digest: &str, data: &str, rest: Vec<Option<String>>) -> Option<String> {
    let mut value = data.to_owned();
    for chunk in rest {
        value.push_str(&chunk?);
    }
    (self::digest(&value) == digest).then_some(value)
}

/// The items of one service in a store: the Keychain, Credential Manager or
/// the Linux file.
trait Items {
    fn get(&mut self, account: &str) -> Result<Option<String>, String>;
    fn set(&mut self, account: &str, value: &str) -> Result<(), String>;
    /// Removes an item; one that is not there is fine.
    fn delete(&mut self, account: &str) -> Result<(), String>;
}

fn read_value(items: &mut impl Items, account: &str) -> Result<Option<String>, String> {
    let Some(first) = items.get(account)? else {
        return Ok(None);
    };
    match parse_head(&first) {
        Head::Whole => {}
        Head::Damaged => {
            log::warn!("secrets: {account} is damaged; it reads as not set");
            return Ok(None);
        }
        Head::Split {
            count,
            digest,
            data,
        } => {
            let rest = (1..count)
                .map(|i| items.get(&chunk_account(account, i)))
                .collect::<Result<Vec<_>, _>>()?;
            let value = join_value(digest, data, rest);
            if value.is_none() {
                log::warn!("secrets: {account} is incomplete; it reads as not set");
            }
            return Ok(value);
        }
    }
    Ok(Some(first))
}

/// How many chunk items `account` has. Writes add chunks in ascending order
/// and every removal goes in descending order, so they always form a run
/// from `:1`, even after an interrupted write.
fn stored_chunks(items: &mut impl Items, account: &str) -> Result<usize, String> {
    let mut count = 0;
    while count + 1 < MAX_CHUNKS && items.get(&chunk_account(account, count + 1))?.is_some() {
        count += 1;
    }
    Ok(count)
}

/// Replaces what `account` holds with `value`. The head goes last, after the
/// new chunks are written and stale ones removed, so a reader finds the old
/// value or, while the chunks belong to two writes, nothing. A store that
/// never splits has no chunks to look for.
fn write_value(
    items: &mut impl Items,
    account: &str,
    value: &str,
    item_units: Option<usize>,
) -> Result<(), String> {
    let chunks = split_value(value, item_units)?;
    let stored = match item_units {
        Some(_) => stored_chunks(items, account)?,
        None => 0,
    };
    for (i, chunk) in chunks.iter().enumerate().skip(1) {
        items.set(&chunk_account(account, i), chunk)?;
    }
    for i in (chunks.len()..=stored).rev() {
        items.delete(&chunk_account(account, i))?;
    }
    items.set(account, &chunks[0])
}

/// Removes `account` and its chunks, the head last.
fn delete_value(
    items: &mut impl Items,
    account: &str,
    item_units: Option<usize>,
) -> Result<(), String> {
    let stored = match item_units {
        Some(_) => stored_chunks(items, account)?,
        None => 0,
    };
    for i in (1..=stored).rev() {
        items.delete(&chunk_account(account, i))?;
    }
    items.delete(account)
}

#[cfg(target_os = "linux")]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
struct FileItems<'a> {
    map: &'a mut HashMap<String, String>,
    service: &'a str,
}

#[cfg(target_os = "linux")]
impl Items for FileItems<'_> {
    fn get(&mut self, account: &str) -> Result<Option<String>, String> {
        Ok(self.map.get(&key(self.service, account)).cloned())
    }

    fn set(&mut self, account: &str, value: &str) -> Result<(), String> {
        self.map.insert(key(self.service, account), value.to_owned());
        Ok(())
    }

    fn delete(&mut self, account: &str) -> Result<(), String> {
        self.map.remove(&key(self.service, account));
        Ok(())
    }
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

/// Changes the store: `f` works on a copy, which is written to disk and only
/// then cached, all under the lock, so concurrent writes neither interleave
/// nor undo one another.
#[cfg(target_os = "linux")]
fn update_store(
    app: &AppHandle,
    state: &SecretsState,
    f: impl FnOnce(&mut HashMap<String, String>) -> Result<(), String>,
) -> Result<(), String> {
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    let mut map = match guard.as_ref() {
        Some(map) => map.clone(),
        None => read_store(app)?,
    };
    f(&mut map)?;
    write_store(app, &map)?;
    *guard = Some(map);
    Ok(())
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

#[cfg(any(not(target_os = "linux"), test))]
struct KeyringItems<'a> {
    store: &'a keyring_core::CredentialStore,
    service: &'a str,
}

#[cfg(any(not(target_os = "linux"), test))]
impl KeyringItems<'_> {
    fn entry(&self, account: &str) -> Result<keyring_core::Entry, String> {
        self.store
            .build(self.service, account, None)
            .map_err(|e| e.to_string())
    }
}

#[cfg(any(not(target_os = "linux"), test))]
impl Items for KeyringItems<'_> {
    fn get(&mut self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&mut self, account: &str, value: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&mut self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn keychain(service: &str) -> Result<KeyringItems<'_>, String> {
    Ok(KeyringItems {
        store: store()?.as_ref(),
        service,
    })
}

#[cfg(not(target_os = "linux"))]
fn busy(state: &SecretsState) -> std::sync::MutexGuard<'_, ()> {
    state
        .busy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether a page may use the `secrets_*` commands on `service` and
/// `account`. MCP secrets (`mcp::SECRET_SERVICE`) are written through
/// `mcp_secret_set` and read only by the backend, when it starts a server or
/// sends a request, so no page can read them back. Chunks of a long value
/// are the backend's.
fn page_may_use(service: &str, account: &str) -> Result<(), String> {
    if service == crate::modules::mcp::SECRET_SERVICE {
        return Err("secrets: this service is not readable from the page".into());
    }
    if is_chunk_account(account) {
        return Err(format!("secrets: invalid account {account:?}"));
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
    page_may_use(&service, &account)?;
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
        with_store(app, state, |map| {
            read_value(&mut FileItems { map, service }, account)
        })?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let _busy = busy(state);
        read_value(&mut keychain(service)?, account)
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    page_may_use(&service, &account)?;
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
        update_store(app, state, |map| {
            write_value(&mut FileItems { map, service }, account, &password, ITEM_UNITS)
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let _busy = busy(state);
        write_value(&mut keychain(service)?, account, &password, ITEM_UNITS)
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    service: String,
    account: String,
) -> Result<(), String> {
    page_may_use(&service, &account)?;
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
        update_store(app, state, |map| {
            delete_value(&mut FileItems { map, service }, account, ITEM_UNITS)
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let _busy = busy(state);
        delete_value(&mut keychain(service)?, account, ITEM_UNITS)
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

    #[test]
    fn the_file_keeps_every_value_in_one_entry() {
        let mut map = HashMap::new();
        let long = "k".repeat(MAX_VALUE_BYTES);
        let mut items = FileItems {
            map: &mut map,
            service: "svc",
        };
        write_value(&mut items, "a", &long, ITEM_UNITS).unwrap();
        write_value(&mut items, "b", "sk-plain", ITEM_UNITS).unwrap();
        let head_like = format!("{HEAD}1:0123456789abcdef:x");
        write_value(&mut items, "c", &head_like, ITEM_UNITS).unwrap();
        assert_eq!(read_value(&mut items, "a").unwrap().as_deref(), Some(&*long));
        assert_eq!(read_value(&mut items, "c").unwrap(), Some(head_like));
        assert_eq!(map.len(), 3);
        assert_eq!(map[&key("svc", "a")], long);
        assert_eq!(map[&key("svc", "b")], "sk-plain");
        let mut items = FileItems {
            map: &mut map,
            service: "svc",
        };
        delete_value(&mut items, "c", ITEM_UNITS).unwrap();
        assert!(read_value(&mut items, "c").unwrap().is_none());
    }
}

/// Uses the real Keychain / Credential Manager, so it is ignored by default;
/// CI runs it on macOS and Windows (`cargo nextest run --run-ignored only`).
#[cfg(all(test, not(target_os = "linux")))]
mod keychain_compat {
    use super::*;

    /// Deletes the test item, and any chunk of it, however the test ends.
    struct Cleanup(String, String);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for index in 0..MAX_CHUNKS {
                let account = match index {
                    0 => self.1.clone(),
                    i => chunk_account(&self.1, i),
                };
                if let Ok(item) = keyring3::Entry::new(&self.0, &account) {
                    let _ = item.delete_credential();
                }
            }
        }
    }

    fn unique_item() -> Cleanup {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Cleanup(
            format!(
                "consulting.quantumops.oarlock.test.{}.{nanos}",
                std::process::id()
            ),
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

        let mut items = keychain(service).unwrap();
        let new = items.entry(account).unwrap();
        assert_eq!(
            new.get_password().unwrap(),
            "sk-written-by-keyring-3 \u{1f511}"
        );
        assert_eq!(
            read_value(&mut items, account).unwrap().as_deref(),
            Some("sk-written-by-keyring-3 \u{1f511}")
        );

        new.set_password("sk-written-by-keyring-core").unwrap();
        assert_eq!(old.get_password().unwrap(), "sk-written-by-keyring-core");
        write_value(&mut items, account, "sk-written-by-oarlock", ITEM_UNITS).unwrap();
        assert_eq!(old.get_password().unwrap(), "sk-written-by-oarlock");

        new.delete_credential().unwrap();
        assert!(matches!(old.get_password(), Err(keyring3::Error::NoEntry)));
        assert!(matches!(
            new.get_password(),
            Err(keyring_core::Error::NoEntry)
        ));
    }

    /// A long value is one item on macOS and a head with chunks on Windows;
    /// a short one written over it is a single item again, which an earlier
    /// release reads.
    #[test]
    #[ignore = "uses the real keychain; CI runs it on macOS and Windows"]
    fn keychain_compat_keeps_long_values() {
        let item = unique_item();
        let (service, account) = (&item.0, &item.1);
        let old = keyring3::Entry::new(service, account).unwrap();
        let mut items = keychain(service).unwrap();
        let long: String = "a\u{1f511}".repeat(4000);

        write_value(&mut items, account, &long, ITEM_UNITS).unwrap();
        assert_eq!(read_value(&mut items, account).unwrap(), Some(long.clone()));
        let first = old.get_password().unwrap();
        if cfg!(target_os = "windows") {
            assert!(first.starts_with(HEAD));
            let second = keyring3::Entry::new(service, &chunk_account(account, 1)).unwrap();
            assert!(second.get_password().is_ok());
        } else {
            assert_eq!(first, long);
        }

        write_value(&mut items, account, "sk-short", ITEM_UNITS).unwrap();
        assert_eq!(old.get_password().unwrap(), "sk-short");
        let second = keyring3::Entry::new(service, &chunk_account(account, 1)).unwrap();
        assert!(matches!(
            second.get_password(),
            Err(keyring3::Error::NoEntry)
        ));

        write_value(&mut items, account, &long, ITEM_UNITS).unwrap();
        delete_value(&mut items, account, ITEM_UNITS).unwrap();
        assert!(read_value(&mut items, account).unwrap().is_none());
        assert!(matches!(
            second.get_password(),
            Err(keyring3::Error::NoEntry)
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
    for account in &accounts {
        page_may_use(&service, account)?;
    }
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
        with_store(app, state, |map| {
            let mut items = FileItems { map, service };
            accounts
                .iter()
                .map(|a| read_value(&mut items, a).ok().flatten())
                .collect()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let _busy = busy(state);
        let Ok(mut items) = keychain(service) else {
            return Ok(vec![None; accounts.len()]);
        };
        Ok(accounts
            .iter()
            .map(|a| read_value(&mut items, a).ok().flatten())
            .collect())
    }
}

#[cfg(test)]
mod page_access {
    use super::page_may_use;

    #[test]
    fn pages_cannot_use_the_mcp_secret_service() {
        assert!(page_may_use("oarlock-ai", "openai-api-key").is_ok());
        assert!(page_may_use(crate::modules::mcp::SECRET_SERVICE, "s/env/A").is_err());
    }

    #[test]
    fn pages_cannot_name_a_chunk_of_a_long_value() {
        assert!(page_may_use("oarlock-ai", "openai-api-key:1").is_err());
        assert!(page_may_use("oarlock-ai", "openai-api-key:12").is_err());
        assert!(page_may_use("oarlock-ai", "compat-1a2b3c4d-api-key").is_ok());
        assert!(page_may_use("oarlock-ai", "a:b").is_ok());
    }
}

/// The split and join of long values, and the Windows path over keyring-core's
/// in-memory store, which keeps items as Credential Manager does.
#[cfg(test)]
mod chunks {
    use super::*;
    use std::sync::Arc;

    const WINDOWS: Option<usize> = Some(1280);

    fn units(item: &str) -> usize {
        item.encode_utf16().count()
    }

    fn join(chunks: &[String]) -> Option<String> {
        match parse_head(&chunks[0]) {
            Head::Whole => {
                assert_eq!(chunks.len(), 1);
                Some(chunks[0].clone())
            }
            Head::Split {
                count,
                digest,
                data,
            } => {
                assert_eq!(count, chunks.len());
                join_value(digest, data, chunks[1..].iter().cloned().map(Some).collect())
            }
            Head::Damaged => None,
        }
    }

    fn mock() -> Arc<keyring_core::CredentialStore> {
        keyring_core::mock::Store::new().unwrap()
    }

    fn items(store: &Arc<keyring_core::CredentialStore>) -> KeyringItems<'_> {
        KeyringItems {
            store: store.as_ref(),
            service: "oarlock-test",
        }
    }

    #[test]
    fn a_value_that_fits_is_one_item_as_given() {
        for value in ["", "sk-1", &"x".repeat(1280), &"\u{1f511}".repeat(640)] {
            assert_eq!(split_value(value, WINDOWS).unwrap(), vec![value.to_owned()]);
        }
        let long = "x".repeat(MAX_VALUE_BYTES);
        assert_eq!(split_value(&long, None).unwrap(), vec![long.clone()]);
    }

    #[test]
    fn long_values_split_into_items_windows_can_hold() {
        let first_room = 1280 - HEAD_UNITS;
        for len in [
            1281,
            first_room + 1279,
            first_room + 1280,
            first_room + 1281,
            5000,
            MAX_VALUE_BYTES,
        ] {
            let value = "x".repeat(len);
            let chunks = split_value(&value, WINDOWS).unwrap();
            assert!(chunks.len() > 1, "{len}");
            assert!(chunks.iter().all(|c| units(c) <= 1280), "{len}");
            assert_eq!(join(&chunks).as_deref(), Some(&*value), "{len}");
        }
        assert_eq!(
            split_value(&"x".repeat(first_room + 1280), WINDOWS)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            split_value(&"x".repeat(MAX_VALUE_BYTES), WINDOWS)
                .unwrap()
                .len(),
            26
        );
    }

    #[test]
    fn wide_characters_are_never_cut() {
        for prefix in ["", "a", "ab"] {
            let value = format!("{prefix}{}", "\u{1f511}".repeat(2000));
            let chunks = split_value(&value, WINDOWS).unwrap();
            assert!(chunks.iter().all(|c| units(c) <= 1280));
            assert_eq!(join(&chunks).as_deref(), Some(&*value));
        }
        let value = "\u{1f511}".repeat(641);
        assert_eq!(split_value(&value, WINDOWS).unwrap().len(), 2);
    }

    #[test]
    fn too_long_a_value_is_refused_with_its_limit() {
        let value = "x".repeat(MAX_VALUE_BYTES + 1);
        for limit in [WINDOWS, None] {
            let error = split_value(&value, limit).unwrap_err();
            assert!(error.contains("32 KiB"), "{error}");
        }
        assert!(split_value(&"x".repeat(MAX_VALUE_BYTES), WINDOWS).is_ok());
    }

    #[test]
    fn a_value_that_looks_like_a_head_is_written_as_one() {
        let lookalikes = [
            HEAD.to_owned(),
            format!("{HEAD}1:0123456789abcdef:sk"),
            format!("{HEAD}2:{}:sk", digest("sk")),
            format!("{HEAD}garbage"),
        ];
        for value in &lookalikes {
            for limit in [WINDOWS, None] {
                let chunks = split_value(value, limit).unwrap();
                assert!(matches!(parse_head(&chunks[0]), Head::Split { .. }));
                assert_eq!(join(&chunks).as_ref(), Some(value));
            }
        }
        // A control character alone is no head.
        assert_eq!(
            split_value("\x01sk", WINDOWS).unwrap(),
            vec!["\x01sk".to_owned()]
        );
        assert_eq!(parse_head("\x01sk"), Head::Whole);
    }

    #[test]
    fn a_damaged_head_is_refused() {
        let d = digest("x");
        for bad in [
            HEAD.to_owned(),
            format!("{HEAD}1:{d}"),
            format!("{HEAD}0:{d}:x"),
            format!("{HEAD}33:{d}:x"),
            format!("{HEAD}01:{d}:x"),
            format!("{HEAD}+1:{d}:x"),
            format!("{HEAD}1:{}:x", d.to_uppercase()),
            format!("{HEAD}1:{}:x", &d[1..]),
            format!("{HEAD}1:{d}0:x"),
        ] {
            assert_eq!(parse_head(&bad), Head::Damaged, "{bad:?}");
        }
        assert_eq!(
            parse_head(&format!("{HEAD}2:{d}:a:b")),
            Head::Split {
                count: 2,
                digest: &d,
                data: "a:b"
            }
        );
    }

    #[test]
    fn a_missing_or_foreign_chunk_reads_as_missing() {
        let value = "y".repeat(4000);
        let mut chunks = split_value(&value, WINDOWS).unwrap();
        assert_eq!(chunks.len(), 4);
        let (count, digest, data) = match parse_head(&chunks[0]) {
            Head::Split {
                count,
                digest,
                data,
            } => (count, digest.to_owned(), data.to_owned()),
            other => panic!("{other:?}"),
        };
        assert_eq!(count, 4);
        let rest = |chunks: &[String]| chunks[1..].iter().cloned().map(Some).collect::<Vec<_>>();
        let mut missing = rest(&chunks);
        missing[1] = None;
        assert_eq!(join_value(&digest, &data, missing), None);
        chunks[2] = "z".repeat(units(&chunks[2]));
        assert_eq!(join_value(&digest, &data, rest(&chunks)), None);
        chunks.pop();
        assert_eq!(join_value(&digest, &data, rest(&chunks)), None);
    }

    #[test]
    fn the_windows_store_reads_back_what_it_wrote() {
        let store = mock();
        let mut items = items(&store);
        for value in [
            "sk-short".to_owned(),
            "k".repeat(1280),
            "k".repeat(1281),
            "e\u{1f511}".repeat(3000),
            format!("{HEAD}1:0123456789abcdef:sk"),
        ] {
            write_value(&mut items, "acct", &value, WINDOWS).unwrap();
            assert_eq!(read_value(&mut items, "acct").unwrap(), Some(value.clone()));
            let mut index = 0;
            while let Some(item) = items
                .get(&match index {
                    0 => "acct".to_owned(),
                    i => chunk_account("acct", i),
                })
                .unwrap()
            {
                assert!(units(&item) <= 1280);
                index += 1;
            }
            assert_eq!(index, split_value(&value, WINDOWS).unwrap().len());
        }
        assert!(read_value(&mut items, "other").unwrap().is_none());
    }

    #[test]
    fn shrinking_and_deleting_remove_every_stale_chunk() {
        let store = mock();
        let mut items = items(&store);
        write_value(&mut items, "acct", &"q".repeat(MAX_VALUE_BYTES), WINDOWS).unwrap();
        assert_eq!(stored_chunks(&mut items, "acct").unwrap(), 25);

        write_value(&mut items, "acct", &"q".repeat(3000), WINDOWS).unwrap();
        assert_eq!(stored_chunks(&mut items, "acct").unwrap(), 2);
        write_value(&mut items, "acct", "sk-short", WINDOWS).unwrap();
        assert_eq!(stored_chunks(&mut items, "acct").unwrap(), 0);
        // A single item again, as an earlier release wrote it.
        assert_eq!(items.get("acct").unwrap().as_deref(), Some("sk-short"));

        write_value(&mut items, "acct", &"q".repeat(3000), WINDOWS).unwrap();
        delete_value(&mut items, "acct", WINDOWS).unwrap();
        assert!(items.get("acct").unwrap().is_none());
        assert_eq!(stored_chunks(&mut items, "acct").unwrap(), 0);
        delete_value(&mut items, "acct", WINDOWS).unwrap();
    }

    #[test]
    fn an_interrupted_write_never_reads_as_another_value() {
        let store = mock();
        let mut items = items(&store);
        let old = "o".repeat(3000);
        let new = "n".repeat(3000);
        write_value(&mut items, "acct", &old, WINDOWS).unwrap();
        // The new chunks landed, the new head did not.
        let chunks = split_value(&new, WINDOWS).unwrap();
        items.set(&chunk_account("acct", 1), &chunks[1]).unwrap();
        assert_eq!(read_value(&mut items, "acct").unwrap(), None);

        // A short value whose longer successor only got its chunks written.
        write_value(&mut items, "acct", "sk-old", WINDOWS).unwrap();
        for (i, chunk) in chunks.iter().enumerate().skip(1) {
            items.set(&chunk_account("acct", i), chunk).unwrap();
        }
        assert_eq!(
            read_value(&mut items, "acct").unwrap().as_deref(),
            Some("sk-old")
        );
        // The next write clears what was left.
        write_value(&mut items, "acct", "sk-new", WINDOWS).unwrap();
        assert_eq!(stored_chunks(&mut items, "acct").unwrap(), 0);
    }

    #[test]
    fn a_store_without_a_limit_keeps_one_item() {
        let store = mock();
        let mut items = items(&store);
        let long = "m".repeat(MAX_VALUE_BYTES);
        write_value(&mut items, "acct", &long, None).unwrap();
        assert_eq!(items.get("acct").unwrap().as_deref(), Some(&*long));
        assert!(items.get(&chunk_account("acct", 1)).unwrap().is_none());
        assert_eq!(read_value(&mut items, "acct").unwrap(), Some(long));
        delete_value(&mut items, "acct", None).unwrap();
        assert!(items.get("acct").unwrap().is_none());
    }
}
