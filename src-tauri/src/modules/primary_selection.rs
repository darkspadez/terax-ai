//! The PRIMARY selection behind the terminal's copy-on-select and middle-click
//! paste. Only X11 and Wayland have one: elsewhere a write is dropped and a
//! read finds nothing.

use tauri::State;

/// Selections above this are refused both ways: an IPC payload and a buffer
/// the owner serves to every requester, not something to middle-click paste.
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct PrimarySelection {
    #[cfg(target_os = "linux")]
    inner: std::sync::Arc<linux::Primary>,
}

impl PrimarySelection {
    async fn write(&self, text: String) -> Result<(), String> {
        check_size(text.len())?;
        // Clearing a selection leaves PRIMARY with whoever owns it, as in xterm.
        if text.is_empty() {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            // Taken at dispatch: a write that reaches the display after a
            // newer one is dropped instead of replacing it.
            let ticket = self.inner.ticket();
            let inner = self.inner.clone();
            crate::modules::fs::blocking(move || inner.write(ticket, text)).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(())
        }
    }

    async fn read(&self) -> Result<Option<String>, String> {
        #[cfg(target_os = "linux")]
        {
            let inner = self.inner.clone();
            crate::modules::fs::blocking(move || inner.read()).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn terminal_primary_selection_write(
    state: State<'_, PrimarySelection>,
    text: String,
) -> Result<(), String> {
    state.write(text).await
}

#[tauri::command]
pub async fn terminal_primary_selection_read(
    state: State<'_, PrimarySelection>,
) -> Result<Option<String>, String> {
    state.read().await
}

fn check_size(len: usize) -> Result<(), String> {
    if len > MAX_TEXT_BYTES {
        return Err(format!(
            "selection is {len} bytes, more than the {MAX_TEXT_BYTES} byte limit"
        ));
    }
    Ok(())
}

/// Hands out write tickets in dispatch order.
#[derive(Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct WriteOrder(std::sync::atomic::AtomicU64);

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl WriteOrder {
    fn ticket(&self) -> u64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    /// Admits `ticket` unless a newer write was admitted before it.
    fn admit(applied: &mut u64, ticket: u64) -> bool {
        if ticket <= *applied {
            return false;
        }
        *applied = ticket;
        true
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::{Mutex, TryLockError};

    use arboard::{Clipboard, Error, GetExtLinux, LinuxClipboardKind, SetExtLinux};

    use super::{check_size, WriteOrder};

    /// Both clipboards are created on first use and kept for the app's
    /// lifetime: on X11 the selection is served by arboard's background
    /// thread, which lives only while a `Clipboard` does (a Wayland
    /// data-control copy serves from its own thread until replaced). Reads
    /// have their own, so a read stuck on an unresponsive owner (seconds on
    /// X11, unbounded on Wayland) never holds up selecting text.
    #[derive(Default)]
    pub struct Primary {
        order: WriteOrder,
        writer: Mutex<Writer>,
        reader: Mutex<Option<Clipboard>>,
    }

    #[derive(Default)]
    struct Writer {
        clipboard: Option<Clipboard>,
        applied: u64,
    }

    impl Primary {
        pub fn ticket(&self) -> u64 {
            self.order.ticket()
        }

        pub fn write(&self, ticket: u64, text: String) -> Result<(), String> {
            let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            let Writer { clipboard, applied } = &mut *writer;
            if !WriteOrder::admit(applied, ticket) {
                return Ok(());
            }
            let result = open(clipboard)?
                .set()
                .clipboard(LinuxClipboardKind::Primary)
                .text(text);
            match result {
                Ok(()) => Ok(()),
                Err(Error::ClipboardNotSupported) => {
                    log::debug!("this display has no PRIMARY selection");
                    Ok(())
                }
                Err(error) => Err(error.to_string()),
            }
        }

        pub fn read(&self) -> Result<Option<String>, String> {
            let mut reader = match self.reader.try_lock() {
                Ok(reader) => reader,
                Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => {
                    return Err("a PRIMARY selection read is already in progress".into())
                }
            };
            match open(&mut reader)?
                .get()
                .clipboard(LinuxClipboardKind::Primary)
                .text()
            {
                Ok(text) => {
                    check_size(text.len())?;
                    Ok(Some(text).filter(|text| !text.is_empty()))
                }
                Err(Error::ContentNotAvailable | Error::ClipboardNotSupported) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        }
    }

    fn open(slot: &mut Option<Clipboard>) -> Result<&mut Clipboard, String> {
        if slot.is_none() {
            *slot = Some(Clipboard::new().map_err(|e| e.to_string())?);
        }
        Ok(slot.as_mut().expect("opened above"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn an_oversized_selection_is_refused_before_any_display_access() {
        let state = PrimarySelection::default();
        assert!(check_size(MAX_TEXT_BYTES).is_ok());
        let error = block_on(state.write("x".repeat(MAX_TEXT_BYTES + 1))).unwrap_err();
        assert!(error.contains("limit"), "{error}");
    }

    #[test]
    fn an_empty_selection_leaves_primary_alone() {
        assert_eq!(
            block_on(PrimarySelection::default().write(String::new())),
            Ok(())
        );
    }

    #[test]
    fn a_write_overtaken_by_a_newer_one_is_dropped() {
        let order = WriteOrder::default();
        let (first, second, third) = (order.ticket(), order.ticket(), order.ticket());
        let mut applied = 0;
        assert!(WriteOrder::admit(&mut applied, second));
        assert!(!WriteOrder::admit(&mut applied, first));
        assert!(WriteOrder::admit(&mut applied, third));
        assert!(!WriteOrder::admit(&mut applied, third));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn other_platforms_have_no_primary_selection() {
        let state = PrimarySelection::default();
        assert_eq!(block_on(state.write("text".into())), Ok(()));
        assert_eq!(block_on(state.read()), Ok(None));
    }
}
