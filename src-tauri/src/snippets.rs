// Quick texts: short pieces of text kept under a name, copied to the clipboard
// with one click on the island (the tab with the document icon), ready to paste.
//
// They live in snippets.json next to settings.json, written whole through a
// temporary file so a crash never leaves half a list. The text is the user's:
// it is never logged, never sent anywhere, and only ever goes to the clipboard
// when its card is clicked.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Most chips the island holds, and the longest name and text of one.
const MAX_ITEMS: usize = 60;
const MAX_LABEL: usize = 40;
const MAX_TEXT: usize = 20_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippet {
    pub id: String,
    pub label: String,
    pub text: String,
}

fn file() -> PathBuf {
    crate::settings::config_dir().join("snippets.json")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// What may be kept: no empty texts, names and texts within their limits, an
/// id for each, at most `MAX_ITEMS`. A chip without a name is named by its text.
fn clean(items: Vec<Snippet>) -> Vec<Snippet> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| {
            let text = truncate_chars(&s.text, MAX_TEXT);
            let named = s.label.trim();
            let label = if named.is_empty() {
                truncate_chars(text.trim().lines().next().unwrap_or(""), MAX_LABEL)
            } else {
                truncate_chars(named, MAX_LABEL)
            };
            Snippet { id: truncate_chars(&s.id, 64), label, text }
        })
        .filter(|s| !s.id.is_empty() && seen.insert(s.id.clone()))
        .take(MAX_ITEMS)
        .collect()
}

fn read_from(path: &Path) -> Vec<Snippet> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    serde_json::from_slice::<Vec<Snippet>>(&bytes).map(clean).unwrap_or_default()
}

fn write_to(path: &Path, items: &[Snippet]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::platform::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The saved quick texts, in the order the user keeps them.
#[tauri::command]
pub fn snippets_load() -> Vec<Snippet> {
    read_from(&file())
}

/// Replaces the list. Returns what was actually kept (limits applied).
#[tauri::command]
pub fn snippets_save(items: Vec<Snippet>) -> Result<Vec<Snippet>, String> {
    let kept = clean(items);
    write_to(&file(), &kept)?;
    Ok(kept)
}

/// Puts `text` on the clipboard, ready to paste (kept out of the clipboard
/// history, like the dictation's). False when the clipboard refused it.
#[tauri::command]
pub async fn snippet_copy(text: String) -> bool {
    if text.is_empty() {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || crate::flow::paste::copy(&text)).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, label: &str, text: &str) -> Snippet {
        Snippet { id: id.into(), label: label.into(), text: text.into() }
    }

    #[test]
    fn empty_texts_and_duplicate_ids_are_dropped() {
        let kept = clean(vec![s("a", "Hi", "Hello"), s("b", "Empty", "  \n"), s("a", "Again", "Other"), s("", "NoId", "x")]);
        assert_eq!(kept, vec![s("a", "Hi", "Hello")]);
    }

    #[test]
    fn an_unnamed_chip_is_named_by_its_first_line() {
        let kept = clean(vec![s("a", "  ", "First line\nSecond")]);
        assert_eq!(kept[0].label, "First line");
    }

    #[test]
    fn limits_are_applied_by_characters_not_bytes() {
        let long = "é".repeat(MAX_TEXT + 10);
        let kept = clean(vec![s("a", &"ñ".repeat(100), &long)]);
        assert_eq!(kept[0].label.chars().count(), MAX_LABEL);
        assert_eq!(kept[0].text.chars().count(), MAX_TEXT);
        let many: Vec<Snippet> = (0..100).map(|i| s(&i.to_string(), "n", "t")).collect();
        assert_eq!(clean(many).len(), MAX_ITEMS);
    }

    #[test]
    fn a_saved_list_reads_back_and_a_missing_or_broken_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("coucou-snippets-{}", std::process::id()));
        let path = dir.join("snippets.json");
        assert!(read_from(&path).is_empty());
        let items = vec![s("a", "Hi", "Hello\nWorld"), s("b", "Sig", "Thanks,\nMe")];
        write_to(&path, &items).unwrap();
        assert_eq!(read_from(&path), items);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_from(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
