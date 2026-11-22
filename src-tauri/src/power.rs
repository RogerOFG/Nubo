// Waking from sleep or hibernation.
//
// WebView2 draws with the graphics card, and after the PC has slept the card's
// state is often lost: the island came back half drawn (a black block, a pill,
// no Nubo). Nothing in a page can tell, so Windows is asked to say when the PC
// wakes, and the pages — the island, Nubo on the desktop, the dictation pill —
// reload themselves (`system-resumed`). What they show comes back from the
// settings and the next hook; nothing is lost that was not stale already.
//
// Reloading alone was not enough: the window's surface itself stays broken. So
// before the reload each visible webview is made to compose again — hidden and
// shown, its transparent background set once more, its position announced.

#[cfg(windows)]
pub fn watch(app: tauri::AppHandle) {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use tauri::Emitter;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Power::{RegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS};
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    const PBT_APMRESUMESUSPEND: u32 = 0x0007;
    const PBT_APMRESUMEAUTOMATIC: u32 = 0x0012;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static LAST: AtomicI64 = AtomicI64::new(0);

    unsafe extern "system" fn on_power(_context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
        if kind != PBT_APMRESUMESUSPEND && kind != PBT_APMRESUMEAUTOMATIC {
            return 0;
        }
        // Windows reports a wake twice: once is enough.
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if now - LAST.swap(now, Ordering::Relaxed) < 10_000 {
            return 0;
        }
        if let Some(app) = APP.get().cloned() {
            std::thread::spawn(move || {
                // Let the display come back first.
                std::thread::sleep(Duration::from_secs(2));
                crate::log::line("power: the PC woke up, the windows compose again and the pages reload");
                recompose(&app);
                std::thread::sleep(Duration::from_millis(400));
                let _ = app.emit("system-resumed", ());
            });
        }
        0
    }

    let _ = APP.set(app);
    // The registration must outlive the program: it is leaked on purpose.
    let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(on_power),
        Context: std::ptr::null_mut(),
    }));
    let registered =
        unsafe { RegisterSuspendResumeNotification(HANDLE(params as *mut _ as *mut c_void), DEVICE_NOTIFY_CALLBACK) };
    if let Err(err) = registered {
        crate::log::line(format!("power: could not watch for waking up: {err}"));
    }
}

/// Makes each visible webview compose from scratch.
#[cfg(windows)]
fn recompose(app: &tauri::AppHandle) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller2, COREWEBVIEW2_COLOR};
    use wv2_core::Interface;

    for label in ["island", "nubo", "pill"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let visible = win.is_visible().unwrap_or(false);
        let size = win.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_default();
        let at = win.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_default();
        crate::log::line(format!("power: {label} visible={visible} size={size} at={at}"));
        if !visible {
            continue;
        }
        let result = win.with_webview(|webview| unsafe {
            let controller = webview.controller();
            if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
                let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 });
            }
            let _ = controller.NotifyParentWindowPositionChanged();
            let _ = controller.SetIsVisible(false);
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = controller.SetIsVisible(true);
        });
        if let Err(err) = result {
            crate::log::line(format!("power: {label}: with_webview failed: {err}"));
        }
    }
}

#[cfg(not(windows))]
pub fn watch(_app: tauri::AppHandle) {}
