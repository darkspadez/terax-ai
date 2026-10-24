//! The desktop's light or dark preference, for the webview on Linux.
//!
//! WebKitGTK answers `prefers-color-scheme` from GTK 3's settings
//! (`gtk-application-prefer-dark-theme`, or a theme named `*-dark`), which
//! GNOME 42+ and KDE leave alone: they publish the preference through the
//! freedesktop settings portal (`org.freedesktop.appearance color-scheme`).
//! This reads it there at start and on every change and mirrors it into GTK,
//! which WebKitGTK follows live. Without a portal nothing changes.

use std::cell::RefCell;

use gtk::gio::{self, prelude::*};
use gtk::glib::{self, Variant};
use gtk::prelude::*;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const OBJECT: &str = "/org/freedesktop/portal/desktop";
const SETTINGS: &str = "org.freedesktop.portal.Settings";
const NAMESPACE: &str = "org.freedesktop.appearance";
const KEY: &str = "color-scheme";
const READ_TIMEOUT_MS: i32 = 2_000;

thread_local! {
    /// The portal's signals arrive only while its proxy lives.
    static PROXY: RefCell<Option<gio::DBusProxy>> = const { RefCell::new(None) };
}

/// GTK's dark preference for a `color-scheme` value: 1 prefers dark, 2 prefers
/// light, anything else states none and keeps what GTK had (`initial`).
fn prefer_dark_theme(scheme: u32, initial: bool) -> bool {
    match scheme {
        1 => true,
        2 => false,
        _ => initial,
    }
}

/// A `color-scheme` value however the portal wraps it: `ReadOne` answers
/// `(v)`, the older `Read` a `(v)` holding another `v`.
fn scheme_of(value: &Variant) -> Option<u32> {
    let mut value = value.clone();
    for _ in 0..4 {
        if let Some(scheme) = value.get::<u32>() {
            return Some(scheme);
        }
        if !value.is_container() || value.n_children() != 1 {
            return None;
        }
        value = value.child_value(0);
    }
    None
}

/// The new `color-scheme` from a `SettingChanged (ssv)` signal, if that is
/// what changed.
fn changed_scheme(parameters: &Variant) -> Option<u32> {
    let (namespace, key, value) = parameters.get::<(String, String, Variant)>()?;
    if namespace != NAMESPACE || key != KEY {
        return None;
    }
    scheme_of(&value)
}

fn apply(settings: &gtk::Settings, scheme: u32, initial: bool) {
    let dark = prefer_dark_theme(scheme, initial);
    if settings.is_gtk_application_prefer_dark_theme() != dark {
        settings.set_gtk_application_prefer_dark_theme(dark);
    }
}

fn read(proxy: &gio::DBusProxy, method: &'static str, settings: gtk::Settings, initial: bool) {
    let retry = proxy.clone();
    proxy.call(
        method,
        Some(&(NAMESPACE, KEY).to_variant()),
        gio::DBusCallFlags::NONE,
        READ_TIMEOUT_MS,
        None::<&gio::Cancellable>,
        move |reply| match reply {
            Ok(reply) => {
                if let Some(scheme) = scheme_of(&reply) {
                    apply(&settings, scheme, initial);
                }
            }
            // Portals before version 2 only have `Read`.
            Err(_) if method == "ReadOne" => read(&retry, "Read", settings, initial),
            Err(_) => {}
        },
    );
}

/// Starts following the portal's `color-scheme`, on the GTK main loop.
pub fn follow() {
    glib::MainContext::default().invoke(|| {
        let Some(settings) = gtk::Settings::default() else {
            return;
        };
        let initial = settings.is_gtk_application_prefer_dark_theme();
        gio::DBusProxy::for_bus(
            gio::BusType::Session,
            gio::DBusProxyFlags::DO_NOT_LOAD_PROPERTIES,
            None::<&gio::DBusInterfaceInfo>,
            PORTAL,
            OBJECT,
            SETTINGS,
            None::<&gio::Cancellable>,
            move |proxy| {
                let Ok(proxy) = proxy else {
                    return;
                };
                let changed = settings.clone();
                proxy.connect_local("g-signal", false, move |values| {
                    let signal = values.get(2)?.get::<String>().ok()?;
                    let parameters = values.get(3)?.get::<Variant>().ok()?;
                    if signal == "SettingChanged" {
                        if let Some(scheme) = changed_scheme(&parameters) {
                            apply(&changed, scheme, initial);
                        }
                    }
                    None
                });
                read(&proxy, "ReadOne", settings, initial);
                PROXY.with(|slot| *slot.borrow_mut() = Some(proxy));
            },
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_dark_and_light_and_keeps_gtk_without_a_preference() {
        assert!(prefer_dark_theme(1, false));
        assert!(!prefer_dark_theme(2, true));
        assert!(prefer_dark_theme(0, true));
        assert!(!prefer_dark_theme(0, false));
        // A value a newer portal may add states no preference either.
        assert!(!prefer_dark_theme(7, false));
    }

    #[test]
    fn reads_the_scheme_from_read_one_and_from_the_older_read() {
        // A Variant in a tuple is boxed as `v`.
        let read_one = (1u32.to_variant(),).to_variant();
        assert_eq!(read_one.type_().as_str(), "(v)");
        assert_eq!(scheme_of(&read_one), Some(1));
        let read = (Variant::from_variant(&2u32.to_variant()),).to_variant();
        assert_eq!(
            read.child_value(0).as_variant().unwrap().type_().as_str(),
            "v"
        );
        assert_eq!(scheme_of(&read), Some(2));
        assert_eq!(scheme_of(&("dark",).to_variant()), None);
    }

    #[test]
    fn takes_only_the_color_scheme_from_setting_changes() {
        let change = |namespace: &str, key: &str, value: Variant| {
            let change = (namespace, key, value).to_variant();
            assert_eq!(change.type_().as_str(), "(ssv)");
            change
        };
        assert_eq!(
            changed_scheme(&change(NAMESPACE, KEY, 1u32.to_variant())),
            Some(1)
        );
        assert_eq!(
            changed_scheme(&change(NAMESPACE, "accent-color", 1u32.to_variant())),
            None
        );
        assert_eq!(
            changed_scheme(&change(
                "org.gnome.desktop.interface",
                KEY,
                1u32.to_variant()
            )),
            None
        );
        assert_eq!(changed_scheme(&(1u32,).to_variant()), None);
    }
}
