//! Installed OS font enumeration (editor ticket). Uses `fontdb` (MIT).

use std::collections::BTreeSet;
use std::sync::OnceLock;

/// Turns raw family names into a sorted (case-insensitive), de-duplicated list,
/// skipping blanks and hidden system families (names starting with `.`).
fn normalize_families<I, S>(names: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = BTreeSet::new();
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.as_ref().trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            out.push(name.to_string());
        }
    }
    out.sort_by_key(|a| a.to_lowercase());
    out
}

/// Scans the system fonts. Takes only each face's first family name
/// (fontdb puts the English US name first), so localized aliases are not duplicated.
fn enumerate_system_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let names: Vec<String> = db
        .faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect();
    normalize_families(names)
}

static FONT_CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// Cached for the app's lifetime: the scan runs once, on first call.
fn cached_system_families() -> Vec<String> {
    FONT_CACHE.get_or_init(enumerate_system_families).clone()
}

/// Returns the installed OS font family names, sorted and de-duplicated.
/// Runs off the main thread; returns an empty list if enumeration fails.
#[tauri::command]
pub async fn list_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(cached_system_families)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{cached_system_families, enumerate_system_families, normalize_families};

    #[test]
    fn sorts_dedupes_and_skips_hidden() {
        let out = normalize_families(["Times", "arial", "Arial", "  ", ".SF Hidden", "Courier"]);
        assert_eq!(out, vec!["arial", "Courier", "Times"]);
    }

    #[test]
    fn enumerates_sorted_and_cached() {
        let fonts = enumerate_system_families();
        let mut sorted = fonts.clone();
        sorted.sort_by_key(|a| a.to_lowercase());
        assert_eq!(fonts, sorted);
        assert_eq!(cached_system_families(), cached_system_families());
    }
}
