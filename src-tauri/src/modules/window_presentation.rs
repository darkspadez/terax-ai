use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationSnapshot {
    revision: u64,
    occluded: bool,
    sleeping: bool,
    /// The user is dragging the window's edge or corner. Renderers keep their canvas backing
    /// stores stable for the duration instead of reallocating on every step.
    live_resize: bool,
}

#[cfg(any(target_os = "macos", test))]
impl PresentationSnapshot {
    /// The window is not being looked at: occluded, or the machine is asleep.
    fn hidden(&self) -> bool {
        self.occluded || self.sleeping
    }

    fn update(&mut self, change: Change) -> Option<Self> {
        let occluded = change.occluded.unwrap_or(self.occluded);
        let sleeping = change.sleeping.unwrap_or(self.sleeping);
        let live_resize = change.live_resize.unwrap_or(self.live_resize);
        if self.occluded == occluded && self.sleeping == sleeping && self.live_resize == live_resize
        {
            return None;
        }
        self.occluded = occluded;
        self.sleeping = sleeping;
        self.live_resize = live_resize;
        self.revision += 1;
        Some(*self)
    }
}

/// What a notification reports; fields it does not know stay as they are.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Default)]
struct Change {
    occluded: Option<bool>,
    sleeping: Option<bool>,
    live_resize: Option<bool>,
}

/// Each app window's presentation, by label. Only macOS reports it natively;
/// elsewhere every window reads the default (the page's own visibility rules).
#[derive(Default)]
pub struct WindowPresentationState(Mutex<HashMap<String, PresentationSnapshot>>);

impl WindowPresentationState {
    #[cfg(target_os = "macos")]
    fn update(
        &self,
        label: &str,
        change: Change,
    ) -> (PresentationSnapshot, Option<PresentationSnapshot>) {
        let mut guard = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let snapshot = guard.entry(label.to_owned()).or_default();
        let previous = *snapshot;
        (previous, snapshot.update(change))
    }
}

/// The calling window's presentation.
#[tauri::command]
pub fn window_presentation_state(
    window: tauri::Window,
    state: State<'_, WindowPresentationState>,
) -> PresentationSnapshot {
    state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(window.label())
        .copied()
        .unwrap_or_default()
}

/// A destroyed window's state and native observers go.
pub fn forget_window(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<WindowPresentationState>() {
        state
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(label);
    }
    #[cfg(target_os = "macos")]
    macos::uninstall_window(label);
}

#[cfg(target_os = "macos")]
pub mod macos {
    use super::{Change, WindowPresentationState};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSWindow, NSWindowDidChangeOcclusionStateNotification,
        NSWindowDidEndLiveResizeNotification, NSWindowOcclusionState,
        NSWindowWillStartLiveResizeNotification, NSWorkspace, NSWorkspaceDidWakeNotification,
        NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue,
    };
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ptr::NonNull;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

    use crate::modules::windows;

    struct Observer {
        center: Retained<NSNotificationCenter>,
        token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    impl Drop for Observer {
        fn drop(&mut self) {
            unsafe { self.center.removeObserver((*self.token).as_ref()) };
        }
    }

    thread_local! {
        /// Sleep and wake, for every window.
        static WORKSPACE: RefCell<Vec<Observer>> = const { RefCell::new(Vec::new()) };
        /// Each window's own notifications, by label.
        static WINDOWS: RefCell<HashMap<String, Vec<Observer>>> = RefCell::new(HashMap::new());
    }

    fn occluded(app: &AppHandle, label: &str) -> Option<bool> {
        let window = app.get_webview_window(label)?;
        let pointer = window.ns_window().ok()?;
        // Tauri owns this NSWindow; notification callbacks run on the main queue.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        Some(
            !native
                .occlusionState()
                .contains(NSWindowOcclusionState::Visible),
        )
    }

    fn update(app: &AppHandle, label: &str, sleeping: Option<bool>, live_resize: Option<bool>) {
        let change = Change {
            occluded: occluded(app, label),
            sleeping,
            live_resize,
        };
        let state = app.state::<WindowPresentationState>();
        let (previous, next) = state.update(label, change);
        let Some(next) = next else { return };
        // Applied natively, with no frontend round trip: hidden terminals
        // switch to the occluded delivery cadence the moment the OS says so.
        if previous.hidden() != next.hidden() {
            if let Some(pty) = app.try_state::<crate::modules::pty::PtyState>() {
                pty.set_window_hidden(label, next.hidden());
            }
        }
        let _ = app.emit_to(label, "terax:window-presentation", next);
    }

    /// Sleep and wake notifications, then every app window open now.
    pub fn install(app: &AppHandle) {
        uninstall();
        let queue = NSOperationQueue::mainQueue();
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        for (name, sleeping) in unsafe {
            [
                (NSWorkspaceWillSleepNotification, true),
                (NSWorkspaceDidWakeNotification, false),
            ]
        } {
            let handle = app.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                let labels: Vec<String> = handle
                    .webview_windows()
                    .into_keys()
                    .filter(|label| windows::is_app_window(label))
                    .collect();
                for label in labels {
                    update(&handle, &label, Some(sleeping), None);
                }
            });
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&queue),
                    &block,
                )
            };
            WORKSPACE.with_borrow_mut(|observers| {
                observers.push(Observer {
                    center: center.clone(),
                    token,
                })
            });
        }
        for (label, window) in app.webview_windows() {
            if windows::is_app_window(&label) {
                install_window(app, &window);
            }
        }
    }

    /// One window's occlusion and live-resize notifications.
    pub fn install_window(app: &AppHandle, window: &WebviewWindow) {
        let label = window.label().to_owned();
        uninstall_window(&label);
        let Ok(pointer) = window.ns_window() else {
            return;
        };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        let queue = NSOperationQueue::mainQueue();
        let center = NSNotificationCenter::defaultCenter();
        let mut observers = Vec::new();
        // Live resize brackets one user drag of an edge or corner (not programmatic setFrame
        // calls), exactly the span in which WebKit holds on to every swapchain a resizing canvas
        // retires.
        for (name, live_resize) in unsafe {
            [
                (NSWindowDidChangeOcclusionStateNotification, None),
                (NSWindowWillStartLiveResizeNotification, Some(true)),
                (NSWindowDidEndLiveResizeNotification, Some(false)),
            ]
        } {
            let handle = app.clone();
            let label = label.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                update(&handle, &label, None, live_resize)
            });
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    Some(native),
                    Some(&queue),
                    &block,
                )
            };
            observers.push(Observer {
                center: center.clone(),
                token,
            });
        }
        WINDOWS.with_borrow_mut(|windows| {
            windows.insert(label.clone(), observers);
        });
        update(app, &label, None, None);
    }

    pub fn uninstall_window(label: &str) {
        WINDOWS.with_borrow_mut(|windows| {
            windows.remove(label);
        });
    }

    pub fn uninstall() {
        WORKSPACE.with_borrow_mut(Vec::clear);
        WINDOWS.with_borrow_mut(HashMap::clear);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_notifications_are_deduplicated_and_ordered() {
        let mut state = PresentationSnapshot::default();
        assert_eq!(state.update(occluded(true)).unwrap().revision, 1);
        for _ in 0..10_000 {
            assert!(state.update(occluded(true)).is_none());
        }
        assert_eq!(state.update(sleeping(true)).unwrap().revision, 2);
        let wake = Change {
            occluded: Some(false),
            sleeping: Some(false),
            live_resize: None,
        };
        assert_eq!(state.update(wake).unwrap().revision, 3);
        assert!(!state.occluded && !state.sleeping);
    }

    #[test]
    fn terminals_slow_down_when_the_window_is_occluded_or_the_machine_sleeps() {
        let mut state = PresentationSnapshot::default();
        assert!(!state.hidden());
        assert!(state.update(occluded(true)).unwrap().hidden());
        // Waking while still occluded keeps terminals on the slow cadence.
        assert!(state.update(sleeping(true)).unwrap().hidden());
        assert!(state.update(sleeping(false)).unwrap().hidden());
        assert!(state.update(sleeping(false)).is_none());
        assert!(!state.update(occluded(false)).unwrap().hidden());
        assert!(state.update(sleeping(true)).unwrap().hidden());
    }

    #[test]
    fn live_resize_is_reported_once_per_drag_and_never_hides_terminals() {
        let mut state = PresentationSnapshot::default();
        let start = state.update(live_resize(true)).unwrap();
        assert!(start.live_resize && !start.hidden());
        // AppKit sends the start notification once per drag, but a repeat must be harmless.
        assert!(state.update(live_resize(true)).is_none());
        // Occlusion changes during a drag keep the flag.
        let occluded = state.update(occluded(true)).unwrap();
        assert!(occluded.live_resize && occluded.hidden());
        let end = state.update(live_resize(false)).unwrap();
        assert!(!end.live_resize);
        assert_eq!(end.revision, 3);
    }

    #[test]
    fn snapshot_serializes_camel_case_for_the_frontend() {
        let mut state = PresentationSnapshot::default();
        let json = serde_json::to_value(state.update(live_resize(true)).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "revision": 1,
                "occluded": false,
                "sleeping": false,
                "liveResize": true,
            })
        );
    }

    fn occluded(value: bool) -> Change {
        Change {
            occluded: Some(value),
            ..Change::default()
        }
    }

    fn sleeping(value: bool) -> Change {
        Change {
            sleeping: Some(value),
            ..Change::default()
        }
    }

    fn live_resize(value: bool) -> Change {
        Change {
            live_resize: Some(value),
            ..Change::default()
        }
    }
}
