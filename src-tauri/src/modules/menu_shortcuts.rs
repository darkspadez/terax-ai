//! The app shortcuts the macOS menu bar carries as well (`app_menu.rs`), so
//! they work while a preview frame has the keyboard and the page never sees
//! their keys: the key equivalents each app window sends from the user's
//! bindings (`menuShortcuts.ts`), and the shortcut a chosen item asks the
//! window in front to run.

use serde::{Deserialize, Serialize};

/// Every modifier and the longest key name fit well within this.
const MAX_ACCELERATOR_LEN: usize = 48;

/// The menu items' key equivalents in the menu's accelerator syntax
/// (`Cmd+Shift+KeyT`); `None` leaves an item without one.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuAccelerators {
    new_tab: Option<String>,
    /// Tab 1 to Tab 9.
    select_tab: [Option<String>; 9],
    next_tab: Option<String>,
    previous_tab: Option<String>,
    command_palette: Option<String>,
    toggle_ai: Option<String>,
}

impl MenuAccelerators {
    /// Keeps only names joined by `+`, as the page writes them; anything else
    /// leaves its item without a key equivalent.
    pub fn validated(self) -> Self {
        Self {
            new_tab: valid(self.new_tab),
            select_tab: self.select_tab.map(valid),
            next_tab: valid(self.next_tab),
            previous_tab: valid(self.previous_tab),
            command_palette: valid(self.command_palette),
            toggle_ai: valid(self.toggle_ai),
        }
    }

    /// The key equivalent of the item that runs `shortcut`.
    pub fn of(&self, shortcut: MenuShortcut) -> Option<&str> {
        match shortcut {
            MenuShortcut::NewTab => self.new_tab.as_deref(),
            MenuShortcut::SelectTab { tab } => self
                .select_tab
                .get(usize::from(tab).checked_sub(1)?)?
                .as_deref(),
            MenuShortcut::NextTab => self.next_tab.as_deref(),
            MenuShortcut::PreviousTab => self.previous_tab.as_deref(),
            MenuShortcut::CommandPalette => self.command_palette.as_deref(),
            MenuShortcut::ToggleAi => self.toggle_ai.as_deref(),
        }
    }
}

fn valid(accelerator: Option<String>) -> Option<String> {
    accelerator.filter(|accelerator| {
        accelerator.len() <= MAX_ACCELERATOR_LEN
            && accelerator
                .split('+')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric()))
    })
}

/// A shortcut chosen in the menu bar, sent to the page as it names the
/// shortcut (`{"id":"tab.selectByIndex","tab":3}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "id")]
pub enum MenuShortcut {
    #[serde(rename = "tab.new")]
    NewTab,
    #[serde(rename = "tab.selectByIndex")]
    SelectTab { tab: u8 },
    #[serde(rename = "tab.next")]
    NextTab,
    #[serde(rename = "tab.prev")]
    PreviousTab,
    #[serde(rename = "commandPalette.open")]
    CommandPalette,
    #[serde(rename = "ai.toggle")]
    ToggleAi,
}

const SELECT_TAB_MENU_ID: &str = "oarlock.select-tab-";

impl MenuShortcut {
    /// The id of the menu item that runs it.
    pub fn menu_id(self) -> String {
        match self {
            Self::NewTab => "oarlock.new-tab".into(),
            Self::SelectTab { tab } => format!("{SELECT_TAB_MENU_ID}{tab}"),
            Self::NextTab => "oarlock.next-tab".into(),
            Self::PreviousTab => "oarlock.previous-tab".into(),
            Self::CommandPalette => "oarlock.command-palette".into(),
            Self::ToggleAi => "oarlock.toggle-ai".into(),
        }
    }

    /// The shortcut a menu item runs; `None` for any other item.
    pub fn from_menu_id(id: &str) -> Option<Self> {
        Some(match id {
            "oarlock.new-tab" => Self::NewTab,
            "oarlock.next-tab" => Self::NextTab,
            "oarlock.previous-tab" => Self::PreviousTab,
            "oarlock.command-palette" => Self::CommandPalette,
            "oarlock.toggle-ai" => Self::ToggleAi,
            _ => match id.strip_prefix(SELECT_TAB_MENU_ID)?.as_bytes() {
                [digit @ b'1'..=b'9'] => Self::SelectTab { tab: digit - b'0' },
                _ => return None,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MenuAccelerators, MenuShortcut};
    use serde_json::json;

    fn every_shortcut() -> Vec<MenuShortcut> {
        let mut all = vec![
            MenuShortcut::NewTab,
            MenuShortcut::NextTab,
            MenuShortcut::PreviousTab,
            MenuShortcut::CommandPalette,
            MenuShortcut::ToggleAi,
        ];
        all.extend((1..=9).map(|tab| MenuShortcut::SelectTab { tab }));
        all
    }

    #[test]
    fn each_item_runs_its_own_shortcut() {
        let shortcuts = every_shortcut();
        let mut ids: Vec<String> = shortcuts.iter().map(|s| s.menu_id()).collect();
        for (shortcut, id) in shortcuts.iter().zip(&ids) {
            assert_eq!(MenuShortcut::from_menu_id(id), Some(*shortcut), "{id}");
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), shortcuts.len());
    }

    #[test]
    fn other_items_run_no_shortcut() {
        for id in [
            "oarlock.quit",
            "oarlock.close-tab",
            "oarlock.new-window",
            "oarlock.select-tab-0",
            "oarlock.select-tab-10",
            "oarlock.select-tab-+1",
            "oarlock.select-tab-",
            "",
        ] {
            assert_eq!(MenuShortcut::from_menu_id(id), None, "{id}");
        }
    }

    #[test]
    fn the_page_reads_the_shortcut_by_its_own_name() {
        assert_eq!(
            serde_json::to_value(MenuShortcut::SelectTab { tab: 3 }).unwrap(),
            json!({ "id": "tab.selectByIndex", "tab": 3 })
        );
        assert_eq!(
            serde_json::to_value(MenuShortcut::NewTab).unwrap(),
            json!({ "id": "tab.new" })
        );
        assert_eq!(
            serde_json::to_value(MenuShortcut::PreviousTab).unwrap(),
            json!({ "id": "tab.prev" })
        );
        assert_eq!(
            serde_json::to_value(MenuShortcut::CommandPalette).unwrap(),
            json!({ "id": "commandPalette.open" })
        );
        assert_eq!(
            serde_json::to_value(MenuShortcut::ToggleAi).unwrap(),
            json!({ "id": "ai.toggle" })
        );
    }

    fn defaults() -> serde_json::Value {
        json!({
            "newTab": "Cmd+KeyT",
            "selectTab": (1..=9).map(|n| format!("Cmd+Digit{n}")).collect::<Vec<_>>(),
            "nextTab": "Ctrl+Tab",
            "previousTab": "Ctrl+Shift+Tab",
            "commandPalette": "Cmd+KeyP",
            "toggleAi": null,
        })
    }

    #[test]
    fn takes_the_key_equivalents_the_page_sends() {
        let accelerators: MenuAccelerators = serde_json::from_value(defaults()).unwrap();
        let accelerators = accelerators.validated();
        assert_eq!(accelerators.of(MenuShortcut::NewTab), Some("Cmd+KeyT"));
        assert_eq!(
            accelerators.of(MenuShortcut::SelectTab { tab: 9 }),
            Some("Cmd+Digit9")
        );
        assert_eq!(
            accelerators.of(MenuShortcut::PreviousTab),
            Some("Ctrl+Shift+Tab")
        );
        assert_eq!(accelerators.of(MenuShortcut::ToggleAi), None);
        assert_eq!(accelerators.of(MenuShortcut::SelectTab { tab: 0 }), None);
        assert_eq!(accelerators.of(MenuShortcut::SelectTab { tab: 10 }), None);
    }

    #[test]
    fn leaves_an_item_without_a_key_for_anything_else() {
        for junk in [
            "",
            "+",
            "Cmd+",
            "Cmd++",
            "+KeyT",
            "Cmd+\u{2020}",
            "Cmd+Key T",
            "Cmd+KeyT\n",
            &"Cmd+".repeat(20),
        ] {
            let mut value = defaults();
            value["newTab"] = json!(junk);
            let accelerators: MenuAccelerators = serde_json::from_value(value).unwrap();
            assert_eq!(
                accelerators.validated().of(MenuShortcut::NewTab),
                None,
                "{junk:?}"
            );
        }
    }

    #[test]
    fn refuses_another_shape() {
        let mut extra = defaults();
        extra["closeTab"] = json!("Cmd+KeyW");
        assert!(serde_json::from_value::<MenuAccelerators>(extra).is_err());
        let mut short = defaults();
        short["selectTab"] = json!(["Cmd+Digit1"]);
        assert!(serde_json::from_value::<MenuAccelerators>(short).is_err());
    }
}
