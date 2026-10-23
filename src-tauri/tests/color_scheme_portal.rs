//! `color_scheme::follow` against a stand-in settings portal on a real session
//! bus. Needs a bus and a display, so it is ignored by default:
//! `dbus-run-session -- xvfb-run -a cargo test --test color_scheme_portal -- --ignored`
#![cfg(target_os = "linux")]

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use gtk::gio::{self, prelude::*};
use gtk::glib;
use gtk::prelude::*;

const OBJECT: &str = "/org/freedesktop/portal/desktop";
const SETTINGS: &str = "org.freedesktop.portal.Settings";
const INTERFACE: &str = r#"<node>
  <interface name="org.freedesktop.portal.Settings">
    <method name="ReadOne">
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="v" direction="out"/>
    </method>
    <signal name="SettingChanged">
      <arg type="s"/><arg type="s"/><arg type="v"/>
    </signal>
  </interface>
</node>"#;

fn spin_until(what: &str, done: impl Fn() -> bool) {
    let context = glib::MainContext::default();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        while context.iteration(false) {}
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "needs a session bus and a display"]
fn follows_the_portal_color_scheme() {
    gtk::init().expect("a display");
    let settings = gtk::Settings::default().unwrap();
    settings.set_gtk_application_prefer_dark_theme(false);

    let scheme = Arc::new(AtomicU32::new(1));
    let portal: Arc<Mutex<Option<gio::DBusConnection>>> = Arc::default();
    let served = scheme.clone();
    let slot = portal.clone();
    let _owner = gio::bus_own_name(
        gio::BusType::Session,
        "org.freedesktop.portal.Desktop",
        gio::BusNameOwnerFlags::NONE,
        |_, _| {},
        move |connection, _| {
            let info = gio::DBusNodeInfo::for_xml(INTERFACE)
                .unwrap()
                .lookup_interface(SETTINGS)
                .unwrap();
            let served = served.clone();
            connection
                .register_object(
                    OBJECT,
                    &info,
                    move |_, _, _, _, method, parameters, invocation| {
                        assert_eq!(method, "ReadOne");
                        assert_eq!(
                            parameters.get::<(String, String)>(),
                            Some(("org.freedesktop.appearance".into(), "color-scheme".into()))
                        );
                        let value = served.load(Ordering::SeqCst).to_variant();
                        invocation.return_value(Some(&(value,).to_variant()));
                    },
                    |_, _, _, _, _| unreachable!("no properties"),
                    |_, _, _, _, _, _| false,
                )
                .unwrap();
            *slot.lock().unwrap() = Some(connection);
        },
        |_, _| panic!("could not own the portal name"),
    );
    spin_until("the portal name", || portal.lock().unwrap().is_some());

    oarlock_lib::modules::color_scheme::follow();
    spin_until("dark from ReadOne", || {
        settings.is_gtk_application_prefer_dark_theme()
    });

    let connection = portal.lock().unwrap().clone().unwrap();
    let change = |value: u32| {
        scheme.store(value, Ordering::SeqCst);
        connection
            .emit_signal(
                None,
                OBJECT,
                SETTINGS,
                "SettingChanged",
                Some(
                    &(
                        "org.freedesktop.appearance",
                        "color-scheme",
                        value.to_variant(),
                    )
                        .to_variant(),
                ),
            )
            .unwrap();
    };
    change(2);
    spin_until("light from SettingChanged", || {
        !settings.is_gtk_application_prefer_dark_theme()
    });
    change(1);
    spin_until("dark again", || {
        settings.is_gtk_application_prefer_dark_theme()
    });
    // No preference gives GTK back its own value (light here).
    change(0);
    spin_until("GTK's own value", || {
        !settings.is_gtk_application_prefer_dark_theme()
    });
}
