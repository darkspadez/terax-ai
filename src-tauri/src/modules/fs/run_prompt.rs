//! The OS's own "run this program?" question `fs_open_default` asks before opening a file that
//! would run as a program: a warning naming the file, Cancel and Run, attached to the calling
//! window. Return presses Cancel on every platform, so running a program takes a deliberate click
//! on Run (or moving the focus to it first); Escape and closing the dialog cancel too.
//!
//! tauri-plugin-dialog cannot choose the default button. Through rfd its first button is always
//! the default: the first `NSAlert` button takes Return on macOS, a `TaskDialog` with
//! `nDefaultButton` 0 defaults to its first button on Windows, and GTK gets no default response,
//! so Return goes to whatever has the focus. Giving the plugin the labels in the other order is
//! unsafe: it reports a dialog answered any other way (Escape, closed) as its second button,
//! which would then be Run. So each OS's dialog is built here:
//!
//! - macOS: an `NSAlert` sheet. Cancel is added first (the trailing, accented button) and takes
//!   Return; Run has no key at all. A button takes one key, so Escape, which `NSAlert` gives only
//!   to a Cancel button that is not the default, is caught while the sheet is up and presses
//!   Cancel.
//! - Windows: `TaskDialogIndirect` with Run and Cancel, Cancel the default button (focused, and
//!   Return); Escape, Alt+F4 and the close button cancel.
//! - Linux: a `GtkMessageDialog` transient for the window, Cancel the default response and
//!   focused; Escape and closing it cancel.
//!
//! Only an explicit Run runs: any other answer, a dialog that never showed or one destroyed with
//! its window is a Cancel.

use tauri::{AppHandle, Window};

/// The user's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Cancel,
    Run,
}

/// AppKit's return codes for the alert's buttons, in the order they are added: Cancel first.
#[cfg(any(target_os = "macos", test))]
const ALERT_CANCEL: isize = 1000;
#[cfg(any(target_os = "macos", test))]
const ALERT_RUN: isize = 1001;

/// The answer an `NSAlert` sheet ended with: only its Run button runs; the Cancel button and a
/// sheet ended any other way (stopped, aborted) cancel.
#[cfg(any(target_os = "macos", test))]
fn alert_answer(response: isize) -> Answer {
    if response == ALERT_RUN {
        Answer::Run
    } else {
        Answer::Cancel
    }
}

/// The task dialog's own button ids; Escape and closing it answer `IDCANCEL` (2).
#[cfg(any(windows, test))]
const TASK_RUN: i32 = 100;
#[cfg(any(windows, test))]
const TASK_CANCEL: i32 = 101;

/// The answer `TaskDialogIndirect` returned: only a successful call that ended on Run runs.
#[cfg(any(windows, test))]
fn task_dialog_answer(result: i32, button: i32) -> Answer {
    if result == 0 && button == TASK_RUN {
        Answer::Run
    } else {
        Answer::Cancel
    }
}

/// Asks, in the OS's own dialog attached to `window`, whether to run the program the title and
/// message describe. True only when the user chose Run. Waits without holding a thread.
pub(super) async fn ask(app: &AppHandle, window: &Window, title: String, message: String) -> bool {
    let (answer, answered) = tokio::sync::oneshot::channel::<Answer>();
    show(app, window, title, message, answer);
    // A dialog that never showed or never answered dropped the sender: nothing runs.
    matches!(answered.await, Ok(Answer::Run))
}

#[cfg(target_os = "macos")]
fn show(
    app: &AppHandle,
    window: &Window,
    title: String,
    message: String,
    answer: tokio::sync::oneshot::Sender<Answer>,
) {
    use std::cell::Cell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle, NSEvent,
        NSEventMask, NSModalResponse, NSResponder, NSWindow,
    };
    use objc2_foundation::{NSObjectNSDelayedPerforming, NSString};

    /// `kVK_Escape`.
    const ESCAPE_KEY: u16 = 53;

    let window = window.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Ok(pointer) = window.ns_window() else {
            log::warn!("run question: the window has no NSWindow; not running");
            return;
        };
        // Tauri owns this NSWindow and it outlives this call on the main thread.
        let parent: &NSWindow = unsafe { &*pointer.cast::<NSWindow>() };
        debug_assert_eq!(NSAlertFirstButtonReturn, ALERT_CANCEL);
        debug_assert_eq!(NSAlertSecondButtonReturn, ALERT_RUN);

        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(&title));
        alert.setInformativeText(&NSString::from_str(&message));
        let cancel = alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        let run = alert.addButtonWithTitle(&NSString::from_str("Run"));
        cancel.setKeyEquivalent(&NSString::from_str("\r"));
        run.setKeyEquivalent(&NSString::from_str(""));

        // Escape presses Cancel while the sheet is up: on the next turn of the run loop, which
        // keeps the button alive until then, so the sheet does not end (and remove this monitor)
        // inside the monitor's own call.
        let sheet = alert.window();
        let escape_cancels = RcBlock::new({
            let (cancel, sheet, pressed) = (cancel.clone(), sheet.clone(), Cell::new(false));
            move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let key = unsafe { event.as_ref() };
                let on_sheet = key.window(mtm).is_some_and(|target| target == sheet);
                if on_sheet && key.keyCode() == ESCAPE_KEY {
                    if !pressed.replace(true) {
                        unsafe {
                            cancel.performSelector_withObject_afterDelay(
                                sel!(performClick:),
                                None,
                                0.0,
                            )
                        };
                    }
                    return std::ptr::null_mut();
                }
                event.as_ptr()
            }
        });
        let monitor: Cell<Option<Retained<AnyObject>>> = Cell::new(unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown,
                &escape_cancels,
            )
        });

        let answer = Cell::new(Some(answer));
        // The handler keeps the alert alive until the sheet ends: its buttons target it.
        let keep = alert.clone();
        let handler = RcBlock::new(move |response: NSModalResponse| {
            let _ = &keep;
            if let Some(monitor) = monitor.take() {
                unsafe { NSEvent::removeMonitor(&monitor) };
            }
            if let Some(answer) = answer.take() {
                let _ = answer.send(alert_answer(response));
            }
        });
        alert.beginSheetModalForWindow_completionHandler(parent, Some(&*handler));
        // With keyboard navigation on, the focus ring (and Space) starts on Cancel too.
        let cancel: &NSResponder = &cancel;
        sheet.makeFirstResponder(Some(cancel));
    });
}

#[cfg(windows)]
fn show(
    _app: &AppHandle,
    window: &Window,
    title: String,
    message: String,
    answer: tokio::sync::oneshot::Sender<Answer>,
) {
    let owner = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as usize,
        Err(error) => {
            log::warn!("run question: the window has no HWND ({error}); not running");
            return;
        }
    };
    // The dialog runs its own message loop until answered, so it gets a thread of its own; the
    // window, owned by the main thread, stays disabled meanwhile.
    let spawned = std::thread::Builder::new()
        .name("terax-run-question".into())
        .spawn(move || {
            let _ = answer.send(task_dialog(owner as _, &title, &message));
        });
    if let Err(error) = spawned {
        log::warn!("run question: could not start its thread ({error}); not running");
    }
}

#[cfg(windows)]
fn task_dialog(owner: windows_sys::Win32::Foundation::HWND, title: &str, message: &str) -> Answer {
    use windows_sys::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON,
        TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW, TDF_SIZE_TO_CONTENT,
        TD_WARNING_ICON,
    };

    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() };
    let (title, message) = (wide(title), wide(message));
    let (run, cancel) = (wide("Run"), wide("Cancel"));
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: TASK_RUN,
            pszButtonText: run.as_ptr(),
        },
        TASKDIALOG_BUTTON {
            nButtonID: TASK_CANCEL,
            pszButtonText: cancel.as_ptr(),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: owner,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION
            | TDF_POSITION_RELATIVE_TO_WINDOW
            | TDF_SIZE_TO_CONTENT,
        pszWindowTitle: title.as_ptr(),
        Anonymous1: TASKDIALOGCONFIG_0 {
            pszMainIcon: TD_WARNING_ICON,
        },
        pszContent: message.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        // Focused and pressed by Return.
        nDefaultButton: TASK_CANCEL,
        ..Default::default()
    };
    let mut button = 0;
    let result = unsafe {
        TaskDialogIndirect(
            &config,
            &mut button,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    task_dialog_answer(result, button)
}

#[cfg(target_os = "linux")]
fn show(
    app: &AppHandle,
    window: &Window,
    title: String,
    message: String,
    answer: tokio::sync::oneshot::Sender<Answer>,
) {
    let window = window.clone();
    let _ = app.run_on_main_thread(move || {
        let parent = window.gtk_window().ok();
        gtk_question(parent.as_ref(), &title, &message, answer);
    });
}

/// Shows the question on the GTK main thread and sends the answer once; the dialog destroys
/// itself when answered, and with `parent`.
#[cfg(target_os = "linux")]
fn gtk_question(
    parent: Option<&impl gtk::prelude::IsA<gtk::Window>>,
    title: &str,
    message: &str,
    answer: tokio::sync::oneshot::Sender<Answer>,
) -> gtk::MessageDialog {
    use gtk::prelude::*;
    use std::cell::Cell;

    let dialog = gtk::MessageDialog::new(
        parent,
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        gtk::MessageType::Warning,
        gtk::ButtonsType::None,
        title,
    );
    dialog.set_title(title);
    dialog.set_secondary_text(Some(message));
    let cancel = dialog.add_button("Cancel", gtk::ResponseType::Cancel);
    dialog.add_button("Run", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Cancel);
    let answer = Cell::new(Some(answer));
    dialog.connect_response(move |dialog, response| {
        if let Some(answer) = answer.take() {
            let _ = answer.send(gtk_answer(response));
        }
        // Ours alone: nothing reads it afterwards.
        unsafe { dialog.destroy() };
    });
    dialog.show_all();
    cancel.grab_focus();
    dialog
}

/// The answer a GTK dialog response carries: only Run's (`Accept`) runs; Cancel, Escape and
/// closing the dialog (`DeleteEvent`) cancel.
#[cfg(target_os = "linux")]
fn gtk_answer(response: gtk::ResponseType) -> Answer {
    if response == gtk::ResponseType::Accept {
        Answer::Run
    } else {
        Answer::Cancel
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn show(
    _app: &AppHandle,
    _window: &Window,
    _title: String,
    _message: String,
    _answer: tokio::sync::oneshot::Sender<Answer>,
) {
    log::warn!("run question: no native dialog on this platform; not running");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_alerts_run_button_runs() {
        assert_eq!(alert_answer(ALERT_RUN), Answer::Run);
        assert_eq!(alert_answer(ALERT_CANCEL), Answer::Cancel);
        // NSModalResponseStop, Abort and Continue: a sheet ended without a button.
        for response in [-1000, -1001, -1002, 0, 1002] {
            assert_eq!(alert_answer(response), Answer::Cancel, "{response}");
        }
    }

    #[test]
    fn only_the_task_dialogs_run_button_runs() {
        assert_eq!(task_dialog_answer(0, TASK_RUN), Answer::Run);
        assert_eq!(task_dialog_answer(0, TASK_CANCEL), Answer::Cancel);
        // Escape, Alt+F4 or the close button answer IDCANCEL.
        assert_eq!(task_dialog_answer(0, 2), Answer::Cancel);
        // A dialog that failed to show (E_OUTOFMEMORY, E_INVALIDARG) never runs.
        assert_eq!(
            task_dialog_answer(0x8007_000E_u32 as i32, TASK_RUN),
            Answer::Cancel
        );
        assert_eq!(
            task_dialog_answer(0x8007_0057_u32 as i32, TASK_RUN),
            Answer::Cancel
        );
    }

    /// Drives a real GTK dialog, so it needs a display (`xvfb-run cargo test`); skipped without.
    #[cfg(target_os = "linux")]
    #[test]
    fn return_and_escape_cancel_the_gtk_question_and_only_run_runs() {
        use gtk::gdk;
        use gtk::prelude::*;

        if gtk::init().is_err() {
            eprintln!("no display: skipping the GTK run question test");
            return;
        }
        let pump = || {
            while gtk::events_pending() {
                gtk::main_iteration();
            }
        };
        let ask = || {
            let (answer, answered) = tokio::sync::oneshot::channel();
            let dialog = gtk_question(None::<&gtk::Window>, "Run \u{201c}x\u{201d}?", "x", answer);
            for _ in 0..1000 {
                pump();
                if dialog.is_mapped() && dialog.window().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            (dialog, answered)
        };
        let settle = |mut answered: tokio::sync::oneshot::Receiver<Answer>| {
            for _ in 0..1000 {
                pump();
                match answered.try_recv() {
                    Ok(answer) => return Some(answer),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        std::thread::sleep(std::time::Duration::from_millis(2))
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => return None,
                }
            }
            None
        };
        // A key press as the display would deliver it to the dialog's window: GTK hands it to
        // the focused widget, or to the default response when nothing has the focus.
        let key = |dialog: &gtk::MessageDialog, key: gdk::keys::Key| {
            use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
            let window = dialog.window().expect("a realized dialog");
            let display = window.display();
            let keycode = gdk::Keymap::for_display(&display)
                .and_then(|keymap| keymap.entries_for_keyval(*key).first().map(|k| k.keycode()))
                .expect("the key in the keymap");
            let mut event = gdk::Event::new(gdk::EventType::KeyPress);
            unsafe {
                let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
                let raw = raw.cast::<gdk::ffi::GdkEventKey>();
                (*raw).window = window.to_glib_full();
                (*raw).send_event = 1;
                (*raw).keyval = *key;
                (*raw).hardware_keycode = keycode as u16;
            }
            let keyboard = display.default_seat().and_then(|seat| seat.keyboard());
            event.set_device(keyboard.as_ref());
            gtk::main_do_event(&mut event);
        };

        // Return with the focus where the dialog puts it: on Cancel.
        let (dialog, answered) = ask();
        key(&dialog, gdk::keys::constants::Return);
        assert_eq!(settle(answered), Some(Answer::Cancel));

        // Return with nothing focused goes to the default response, Cancel.
        let (dialog, answered) = ask();
        dialog.set_focus(None::<&gtk::Widget>);
        key(&dialog, gdk::keys::constants::Return);
        assert_eq!(settle(answered), Some(Answer::Cancel));

        let (dialog, answered) = ask();
        key(&dialog, gdk::keys::constants::Escape);
        assert_eq!(settle(answered), Some(Answer::Cancel));

        // Only a click on Run runs.
        let (dialog, answered) = ask();
        let run = dialog
            .widget_for_response(gtk::ResponseType::Accept)
            .and_then(|widget| widget.downcast::<gtk::Button>().ok())
            .expect("a Run button");
        run.clicked();
        assert_eq!(settle(answered), Some(Answer::Run));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_the_gtk_run_response_runs() {
        use gtk::ResponseType;
        assert_eq!(gtk_answer(ResponseType::Accept), Answer::Run);
        for response in [
            ResponseType::Cancel,
            ResponseType::DeleteEvent,
            ResponseType::None,
            ResponseType::Close,
            ResponseType::Reject,
            ResponseType::Ok,
            ResponseType::Other(0),
        ] {
            assert_eq!(gtk_answer(response), Answer::Cancel, "{response:?}");
        }
    }
}
