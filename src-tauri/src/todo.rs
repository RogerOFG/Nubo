// Tasks and notes for the island's Tasks tab: a short list of things to do,
// each with an optional time to be reminded at (once a day when it repeats),
// and a few notes. They live in todo.json next to settings.json, written whole
// through a temporary file so a crash never leaves half a list.
//
// The text is the user's: it is never logged and never leaves the machine. The
// reminders themselves are raised by the island (src/island/todo.ts), which
// reads the list from here.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_TASKS: usize = 200;
const MAX_NOTES: usize = 200;
const MAX_TITLE: usize = 120;
const MAX_NOTE: usize = 5_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    pub title: String,
    /// "HH:MM" (24 h), or "" for a task without a reminder.
    pub time: String,
    /// Comes back every day: done today, open again tomorrow.
    pub daily: bool,
    /// The day ("YYYY-MM-DD") it was ticked off, or "".
    pub done_day: String,
    /// The day it was last reminded, so it is once a day.
    pub notified_day: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Todo {
    pub tasks: Vec<Task>,
    pub notes: Vec<Note>,
}

fn file() -> PathBuf {
    crate::settings::config_dir().join("todo.json")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// "HH:MM" with a real hour and minute, else "".
fn clean_time(s: &str) -> String {
    let s = s.trim();
    let ok = s.len() == 5
        && s.as_bytes()[2] == b':'
        && s[..2].parse::<u32>().is_ok_and(|h| h < 24)
        && s[3..].parse::<u32>().is_ok_and(|m| m < 60);
    if ok { s.to_string() } else { String::new() }
}

/// "YYYY-MM-DD" as written by the island, else "".
fn clean_day(s: &str) -> String {
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if ok { s.to_string() } else { String::new() }
}

fn clean(todo: Todo) -> Todo {
    let mut seen = std::collections::HashSet::new();
    let tasks = todo
        .tasks
        .into_iter()
        .filter(|t| !t.title.trim().is_empty())
        .map(|t| Task {
            id: truncate_chars(&t.id, 64),
            title: truncate_chars(t.title.trim(), MAX_TITLE),
            time: clean_time(&t.time),
            daily: t.daily,
            done_day: clean_day(&t.done_day),
            notified_day: clean_day(&t.notified_day),
        })
        .filter(|t| !t.id.is_empty() && seen.insert(t.id.clone()))
        .take(MAX_TASKS)
        .collect();
    let mut seen = std::collections::HashSet::new();
    let notes = todo
        .notes
        .into_iter()
        .filter(|n| !n.title.trim().is_empty() || !n.text.trim().is_empty())
        .map(|n| {
            let text = truncate_chars(&n.text, MAX_NOTE);
            let named = n.title.trim();
            let title = if named.is_empty() {
                truncate_chars(text.trim().lines().next().unwrap_or(""), MAX_TITLE)
            } else {
                truncate_chars(named, MAX_TITLE)
            };
            Note { id: truncate_chars(&n.id, 64), title, text }
        })
        .filter(|n| !n.id.is_empty() && seen.insert(n.id.clone()))
        .take(MAX_NOTES)
        .collect();
    Todo { tasks, notes }
}

fn read_from(path: &Path) -> Todo {
    let Ok(bytes) = std::fs::read(path) else { return Todo::default() };
    serde_json::from_slice::<Todo>(&bytes).map(clean).unwrap_or_default()
}

fn write_to(path: &Path, todo: &Todo) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::platform::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(todo).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The saved tasks and notes.
#[tauri::command]
pub fn todo_load() -> Todo {
    read_from(&file())
}

/// Replaces both lists. Returns what was actually kept (limits applied).
#[tauri::command]
pub fn todo_save(todo: Todo) -> Result<Todo, String> {
    let kept = clean(todo);
    write_to(&file(), &kept)?;
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, title: &str, time: &str) -> Task {
        Task { id: id.into(), title: title.into(), time: time.into(), ..Default::default() }
    }

    #[test]
    fn times_and_days_are_kept_only_when_they_are_real() {
        assert_eq!(clean_time(" 09:30 "), "09:30");
        assert_eq!(clean_time("24:00"), "");
        assert_eq!(clean_time("9:30"), "");
        assert_eq!(clean_time("12:61"), "");
        assert_eq!(clean_time(""), "");
        assert_eq!(clean_day("2026-11-21"), "2026-11-21");
        assert_eq!(clean_day("21/11/2026"), "");
        assert_eq!(clean_day("2026-11-2x"), "");
    }

    #[test]
    fn tasks_without_a_title_or_with_a_repeated_id_are_dropped() {
        let kept = clean(Todo {
            tasks: vec![task("a", "Call", "10:00"), task("b", "  ", ""), task("a", "Again", ""), task("", "No id", "")],
            notes: vec![],
        });
        assert_eq!(kept.tasks, vec![task("a", "Call", "10:00")]);
    }

    #[test]
    fn a_note_without_a_title_is_named_by_its_first_line_and_an_empty_one_is_dropped() {
        let kept = clean(Todo {
            tasks: vec![],
            notes: vec![
                Note { id: "a".into(), title: "".into(), text: "First line\nMore".into() },
                Note { id: "b".into(), title: " ".into(), text: "  ".into() },
            ],
        });
        assert_eq!(kept.notes.len(), 1);
        assert_eq!(kept.notes[0].title, "First line");
    }

    #[test]
    fn limits_count_characters_not_bytes() {
        let kept = clean(Todo {
            tasks: vec![task("a", &"é".repeat(MAX_TITLE + 20), "")],
            notes: (0..300).map(|i| Note { id: i.to_string(), title: "n".into(), text: "t".into() }).collect(),
        });
        assert_eq!(kept.tasks[0].title.chars().count(), MAX_TITLE);
        assert_eq!(kept.notes.len(), MAX_NOTES);
    }

    #[test]
    fn a_saved_todo_reads_back_and_a_missing_or_broken_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("nubo-todo-{}", std::process::id()));
        let path = dir.join("todo.json");
        assert_eq!(read_from(&path), Todo::default());
        let todo = Todo {
            tasks: vec![Task { daily: true, done_day: "2026-11-21".into(), ..task("a", "Water", "11:00") }],
            notes: vec![Note { id: "n".into(), title: "Idea".into(), text: "Text".into() }],
        };
        write_to(&path, &todo).unwrap();
        assert_eq!(read_from(&path), todo);
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(read_from(&path), Todo::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
