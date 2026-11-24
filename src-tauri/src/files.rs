// Dropped files are copied into %LOCALAPPDATA%\Nubo\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

// ── Paths a real drop delivered ─────────────────────────────────────────────
//
// `ingest_file` is callable from the page, so on its own it would copy any file
// the user can read (a script injected into the page could pull in ~/.ssh).
// Only paths the OS just delivered through a real drop are accepted: WebView2's
// drop objects on Windows (webview_drop.rs), Tauri's drag-drop window event
// elsewhere (lib.rs). Each is good once, for a couple of minutes.

const DROP_VALID_FOR: Duration = Duration::from_secs(120);
const DROP_MAX_PENDING: usize = 64;

static DROPPED: std::sync::Mutex<Vec<(String, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// Records paths that came from a real drop.
pub fn allow_dropped<I: IntoIterator<Item = String>>(paths: I) {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    for p in paths {
        list.push((p, now));
    }
    let excess = list.len().saturating_sub(DROP_MAX_PENDING);
    list.drain(..excess);
}

/// True (once) when `path` was delivered by a drop in the last couple of minutes.
fn take_dropped(path: &str) -> bool {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    match list.iter().position(|(p, _)| p == path) {
        Some(i) => {
            list.remove(i);
            true
        }
        None => false,
    }
}

static INBOX_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    if !take_dropped(source) {
        return Err(crate::i18n::t("Only files dropped on the island can be added."));
    }
    let src = Path::new(source);
    let meta = std::fs::metadata(src)
        .map_err(|e| crate::i18n::tf("Cannot read {path}: {error}", &[("path", source), ("error", &e.to_string())]))?;
    if meta.is_dir() {
        return Err(crate::i18n::t("Folders can't be dropped yet."));
    }

    let _guard = INBOX_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2u64.. {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    if let Err(error) = std::fs::copy(src, &dest) {
        let _ = std::fs::remove_file(&dest);
        return Err(crate::i18n::tf("Cannot copy: {error}", &[("error", &error.to_string())]));
    }
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// True when `path` is a regular file directly inside `dir`, both resolved
/// (no `..`, no symlink pointing out of it).
pub(crate) fn is_inside(dir: &std::path::Path, path: &std::path::Path) -> bool {
    let (Ok(dir), Ok(file)) = (dir.canonicalize(), path.canonicalize()) else { return false };
    file.parent() == Some(dir.as_path())
        && std::fs::symlink_metadata(&file).map(|m| m.is_file()).unwrap_or(false)
}

#[cfg(windows)]
mod shelf_drag {
    use super::{inbox_dir, is_inside, Path};
    use windows::core::{implement, BOOL, HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK,
    };
    use windows::Win32::System::Com::{IBindCtx, IDataObject};
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
        DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
    };
    use windows::Win32::System::SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON, MK_RBUTTON};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_LBUTTON, VK_RBUTTON, VK_SHIFT};
    use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, BHID_DataObject};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

    #[implement(IDropSource)]
    struct ShelfSource {
        button: VIRTUAL_KEY,
        pressed: MODIFIERKEYS_FLAGS,
    }

    impl IDropSource_Impl for ShelfSource_Impl {
        fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            drag_decision(escape.as_bool(), keys.0 & self.pressed.0 != 0, held(self.button))
        }

        fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    fn drag_decision(escape: bool, message_pressed: bool, physical_pressed: bool) -> HRESULT {
        if escape {
            DRAGDROP_S_CANCEL
        } else if !message_pressed || !physical_pressed {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn held(key: VIRTUAL_KEY) -> bool {
        unsafe { GetAsyncKeyState(key.0.into()) < 0 }
    }

    /// Runs on the window's UI thread so OLE owns the mouse only for this gesture.
    /// Shift at the start moves the inbox copy. The default keeps it reusable.
    pub fn drag_out(path: &str) -> Result<bool, String> {
        if !is_inside(&inbox_dir(), Path::new(path)) {
            return Err(crate::i18n::t("Only files dropped on the island can be dragged out."));
        }
        let (button, pressed) = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
            (VK_RBUTTON, MK_RBUTTON)
        } else {
            (VK_LBUTTON, MK_LBUTTON)
        };
        if !held(button) {
            return Ok(false);
        }
        let allowed = if held(VK_SHIFT) { DROPEFFECT_MOVE } else { DROPEFFECT_COPY };
        let source: IDropSource = ShelfSource { button, pressed }.into();
        let shell_path = HSTRING::from(path);
        let result = unsafe {
            OleInitialize(None).map_err(|error| error.to_string())?;
            let result = (|| {
                let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(shell_path.as_ptr()), None::<&IBindCtx>)?;
                let data: IDataObject = item.BindToHandler(None::<&IBindCtx>, &BHID_DataObject)?;
                if !held(button) {
                    return Ok(None);
                }
                let mut effect = DROPEFFECT::default();
                let status = DoDragDrop(&data, &source, allowed, &mut effect);
                status.ok()?;
                Ok::<_, windows::core::Error>((status == DRAGDROP_S_DROP).then_some(effect))
            })();
            OleUninitialize();
            result
        };
        let outcome = result.map_err(|error| error.to_string())?;
        if allowed != DROPEFFECT_MOVE {
            return Ok(false);
        }
        finish_move(Path::new(path), outcome).map_err(|error| error.to_string())
    }

    fn finish_move(path: &Path, outcome: Option<DROPEFFECT>) -> std::io::Result<bool> {
        let Some(effect) = outcome else { return Ok(false) };
        // Explorer may move the file itself without returning MOVE. When the
        // target returns MOVE, it can leave deletion of the inbox copy to us.
        if effect == DROPEFFECT_MOVE {
            match std::fs::remove_file(path) {
                Ok(()) => return Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
                Err(error) => return Err(error),
            }
        }
        match std::fs::metadata(path) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(error),
        }
    }

    #[cfg(test)]
    #[test]
    fn explorer_can_move_the_copy_itself_or_leave_cleanup_to_the_source() {
        let path = std::env::temp_dir().join(format!("nubo-move-{}.txt", std::process::id()));
        std::fs::write(&path, "shelf copy").unwrap();
        assert!(!finish_move(&path, None).unwrap());
        assert!(path.exists());
        assert!(finish_move(&path, Some(DROPEFFECT_MOVE)).unwrap());
        assert!(!path.exists());
        assert!(finish_move(&path, Some(DROPEFFECT::default())).unwrap());
    }

    #[cfg(test)]
    #[test]
    fn releasing_the_mouse_ends_the_drag_even_with_stale_ole_input() {
        assert_eq!(drag_decision(false, true, true), S_OK);
        assert_eq!(drag_decision(false, false, true), DRAGDROP_S_DROP);
        assert_eq!(drag_decision(false, true, false), DRAGDROP_S_DROP);
        assert_eq!(drag_decision(true, true, false), DRAGDROP_S_CANCEL);
    }
}

#[cfg(windows)]
pub use shelf_drag::drag_out;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("nubo-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let drop = |p: &Path| allow_dropped([p.to_string_lossy().to_string()]);
        drop(&source);
        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        drop(&source);
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        drop(&tmp);
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        drop(&old_source);
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    // One test: the list is process-wide and tests run in parallel.
    #[test]
    fn only_a_dropped_path_is_ingested_once_and_the_list_stays_bounded() {
        let p = "/tmp/nubo-test-not-dropped.txt".to_string();
        assert!(ingest(&p).is_err(), "never dropped");
        allow_dropped([p.clone()]);
        assert!(take_dropped(&p));
        assert!(!take_dropped(&p), "good once");

        allow_dropped((0..200).map(|i| format!("/tmp/bounded-{i}")));
        assert!(DROPPED.lock().unwrap().len() <= DROP_MAX_PENDING);
        assert!(take_dropped("/tmp/bounded-199"));
        assert!(!take_dropped("/tmp/bounded-0"));
    }
}
