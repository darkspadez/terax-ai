//! Installed fonts by family, for the OpenType features the terminal applies
//! to them (`fontFeatures.ts`). Canvas text takes no `font-feature-settings`,
//! so the webview declares the family's faces again through `FontFace` with
//! the features; `local()` cannot name them reliably (face names differ per
//! platform and font), so this hands it each face's file instead, which it
//! loads through the asset protocol when the face is first drawn. On macOS
//! the same holds without features: WKWebView's canvas does not see fonts the
//! user installed.
//!
//! The font database is built on first use (it reads every installed font's
//! name table) and rebuilt when a family is missing, at most every
//! `RESCAN_INTERVAL`, so a font installed while Terax runs is found.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use fontdb::{Database, Source, Stretch, Style};
use serde::Serialize;

const RESCAN_INTERVAL: Duration = Duration::from_secs(10);
/// A family with more faces than this is not a terminal font.
const MAX_FACES: usize = 64;

#[derive(Default)]
pub struct SystemFontsState(Mutex<Option<Scan>>);

struct Scan {
    database: Database,
    at: Instant,
}

/// One face of an installed family, with what `FontFace` needs to match it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFace {
    pub path: String,
    pub weight: u16,
    pub style: &'static str,
    /// CSS percentage (100 is normal).
    pub stretch: f32,
}

/// CSS `font-stretch` percentages of the OS/2 width classes.
fn stretch_percent(stretch: Stretch) -> f32 {
    match stretch {
        Stretch::UltraCondensed => 50.0,
        Stretch::ExtraCondensed => 62.5,
        Stretch::Condensed => 75.0,
        Stretch::SemiCondensed => 87.5,
        Stretch::Normal => 100.0,
        Stretch::SemiExpanded => 112.5,
        Stretch::Expanded => 125.0,
        Stretch::ExtraExpanded => 150.0,
        Stretch::UltraExpanded => 200.0,
    }
}

fn style_name(style: Style) -> &'static str {
    match style {
        Style::Normal => "normal",
        Style::Italic => "italic",
        Style::Oblique => "oblique",
    }
}

/// The faces of `family` (case-insensitive, any of a face's names) in
/// `database`. Faces inside a collection other than its first cannot be
/// loaded from the file alone, so they are left out.
fn faces_of(database: &Database, family: &str) -> Vec<InstalledFace> {
    let mut faces: Vec<InstalledFace> = database
        .faces()
        .filter(|face| {
            face.families
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(family))
        })
        .filter(|face| face.index == 0)
        .filter_map(|face| {
            let path = match &face.source {
                Source::File(path) => path.clone(),
                Source::SharedFile(path, _) => path.clone(),
                Source::Binary(_) => return None,
            };
            Some(InstalledFace {
                path: path.to_string_lossy().into_owned(),
                weight: face.weight.0,
                style: style_name(face.style),
                stretch: stretch_percent(face.stretch),
            })
        })
        .collect();
    // One file per face, in a stable order.
    faces.sort_by(|a, b| a.path.cmp(&b.path));
    faces.dedup_by(|a, b| a.path == b.path);
    faces.truncate(MAX_FACES);
    faces
}

fn scan() -> Scan {
    let mut database = Database::new();
    database.load_system_fonts();
    Scan {
        database,
        at: Instant::now(),
    }
}

impl SystemFontsState {
    fn faces(&self, family: &str) -> Vec<InstalledFace> {
        let mut guard = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let current = guard.get_or_insert_with(scan);
        let faces = faces_of(&current.database, family);
        if !faces.is_empty() || current.at.elapsed() < RESCAN_INTERVAL {
            return faces;
        }
        *current = scan();
        faces_of(&current.database, family)
    }
}

/// The installed faces of `family`; empty when it is not installed. Each face's file is
/// granted to the asset protocol, which is how the webview loads it.
#[tauri::command]
pub async fn system_font_faces(
    app: tauri::AppHandle,
    family: String,
) -> Result<Vec<InstalledFace>, String> {
    use tauri::Manager;
    let family = family.trim().to_owned();
    if family.is_empty() || family.len() > 256 {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let faces = app.state::<SystemFontsState>().faces(&family);
        if let Some(assets) = app.try_state::<crate::modules::asset_scope::AssetScope>() {
            for face in &faces {
                assets.grant_file(std::path::Path::new(&face.path));
            }
        }
        faces
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fontdb::{FaceInfo, Language, Weight, ID};
    use std::path::PathBuf;

    fn face(path: &str, index: u32, families: &[&str], style: Style, weight: u16) -> FaceInfo {
        FaceInfo {
            id: ID::dummy(),
            source: Source::File(PathBuf::from(path)),
            index,
            families: families
                .iter()
                .map(|name| ((*name).to_owned(), Language::English_UnitedStates))
                .collect(),
            post_script_name: String::new(),
            style,
            weight: Weight(weight),
            stretch: Stretch::Normal,
            monospaced: true,
        }
    }

    #[test]
    fn a_family_is_found_by_any_of_its_names_with_each_face_file_once() {
        let mut database = Database::new();
        let nerd = "JetBrainsMono Nerd Font";
        database.push_face_info(face("/f/JBM-Regular.ttf", 0, &[nerd], Style::Normal, 400));
        database.push_face_info(face("/f/JBM-Italic.ttf", 0, &[nerd], Style::Italic, 400));
        // A weight style-linked under its own family name, typographic name last.
        database.push_face_info(face(
            "/f/JBM-SemiBold.ttf",
            0,
            &["JetBrainsMono NF SemiBold", nerd],
            Style::Normal,
            600,
        ));
        // The same file twice, and a collection's second face.
        database.push_face_info(face("/f/JBM-Regular.ttf", 0, &[nerd], Style::Normal, 400));
        database.push_face_info(face("/f/Collection.ttc", 1, &[nerd], Style::Normal, 700));
        database.push_face_info(face("/f/Other.ttf", 0, &["Other"], Style::Normal, 400));

        let found = faces_of(&database, "jetbrainsmono nerd font");
        assert_eq!(
            found,
            vec![
                InstalledFace {
                    path: "/f/JBM-Italic.ttf".into(),
                    weight: 400,
                    style: "italic",
                    stretch: 100.0,
                },
                InstalledFace {
                    path: "/f/JBM-Regular.ttf".into(),
                    weight: 400,
                    style: "normal",
                    stretch: 100.0,
                },
                InstalledFace {
                    path: "/f/JBM-SemiBold.ttf".into(),
                    weight: 600,
                    style: "normal",
                    stretch: 100.0,
                },
            ]
        );
        assert!(faces_of(&database, "No Such Family").is_empty());
    }

    #[test]
    fn faces_serialize_as_font_face_descriptors() {
        let json = serde_json::to_value(InstalledFace {
            path: "/f/a.ttf".into(),
            weight: 700,
            style: "italic",
            stretch: stretch_percent(Stretch::Condensed),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "path": "/f/a.ttf", "weight": 700, "style": "italic", "stretch": 75.0 })
        );
    }
}
