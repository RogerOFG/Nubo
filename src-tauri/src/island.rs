// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::dock::{Dock, Edge, WorkArea};
use crate::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
pub const SIDE_PANEL_W: f64 = 390.0;
pub const SIDE_PANEL_H: f64 = 680.0;
/// Logical size of the invisible strip that wakes the island when it is hidden
/// and the closed island is set to show nothing.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Around the window, how far the cursor is still worth telling the page
/// about (Nubo's eyes follow it), in logical px. Past it the page hears once
/// that the cursor left, then nothing until it comes back: a cursor working in
/// another app costs neither messages nor island frames.
const NEAR_ZONE: f64 = 420.0;
/// The poll's period while the cursor is far from the island, in ms.
const FAR_PERIOD_MS: u64 = 50;

/// Whether a cursor at window-logical (x, y) is near a window of `size`.
fn is_near(x: f64, y: f64, size: (f64, f64)) -> bool {
    x >= -NEAR_ZONE && x <= size.0 + NEAR_ZONE && y >= -NEAR_ZONE && y <= size.1 + NEAR_ZONE
}

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    /// The window's logical size while collapsed: the closed island the page
    /// draws, or the wake strip.
    pub collapsed_size: Mutex<(f64, f64)>,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
    #[cfg(windows)]
    moving: Mutex<Option<IslandMove>>,
    #[cfg(windows)]
    centering: Mutex<Option<CenterMove>>,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            collapsed_size: Mutex::new((STRIP_W, STRIP_H)),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            #[cfg(windows)]
            moving: Mutex::new(None),
            #[cfg(windows)]
            centering: Mutex::new(None),
        }
    }

    pub fn is_moving(&self) -> bool {
        #[cfg(windows)]
        { self.moving.lock().unwrap().is_some() || self.centering.lock().unwrap().is_some() }
        #[cfg(not(windows))]
        { false }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Waits until the gate opens or `timeout` passes; true when it is open.
    pub(crate) fn wait_active_for(&self, timeout: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        if *guard {
            return true;
        }
        let (guard, _) = self.cv.wait_timeout(guard, timeout).unwrap();
        *guard
    }

    pub(crate) fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let d = describe(m);
            MonitorChoice {
                key: d.key(),
                label: crate::i18n::tf(
                    "{name} — {width}×{height} at {x},{y}",
                    &[
                        ("name", &d.name),
                        ("width", &d.w.to_string()),
                        ("height", &d.h.to_string()),
                        ("x", &d.x.to_string()),
                        ("y", &d.y.to_string()),
                    ],
                ),
            }
        })
        .collect()
}

/// What a display is remembered by: its logical origin, plus its name and
/// logical size, so it is still found after the layout is rearranged or the
/// resolution changes (the Mac keeps the display's UUID for the same reason;
/// Tauri has no stable ID).
#[derive(Debug, Clone, PartialEq)]
struct DisplayId {
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl DisplayId {
    /// `at:<x>,<y>` stays first, so a preference saved before still matches.
    fn key(&self) -> String {
        format!("at:{},{}|{}|{}x{}", self.x, self.y, self.name.replace('|', " "), self.w, self.h)
    }
}

fn describe(m: &Monitor) -> DisplayId {
    let (x, y) = logical_origin(m);
    let scale = m.scale_factor();
    let s = m.size();
    DisplayId {
        name: m.name().cloned().unwrap_or_else(|| "Display".into()),
        x,
        y,
        w: (s.width as f64 / scale).round() as i32,
        h: (s.height as f64 / scale).round() as i32,
    }
}

/// Which display a saved `at:` preference points at, best match first: same
/// place and name; the same name and size elsewhere (layout rearranged); the
/// same name alone when unique (resolution changed); the same place. None
/// means unplugged, and the caller falls back to the primary display.
fn pick_display(pref: &str, displays: &[DisplayId]) -> Option<usize> {
    let rest = pref.strip_prefix("at:")?;
    let mut parts = rest.split('|');
    let (x, y) = parts.next()?.split_once(',')?;
    let (x, y) = (x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?);
    let name = parts.next();
    let size = parts.next().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?))
    });
    let at = |d: &DisplayId| d.x == x && d.y == y;
    if let Some(name) = name {
        if let Some(i) = displays.iter().position(|d| at(d) && d.name == name) {
            return Some(i);
        }
        if let Some((w, h)) = size {
            if let Some(i) = displays.iter().position(|d| d.name == name && d.w == w && d.h == h) {
                return Some(i);
            }
        }
        let mut same_name = displays.iter().enumerate().filter(|(_, d)| d.name == name);
        if let (Some((i, _)), None) = (same_name.next(), same_name.next()) {
            return Some(i);
        }
    }
    displays.iter().position(at)
}

/// The display the island lives on: a chosen one, the primary one, or the one
/// under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    if let Some(i) = pick_display(pref, &ids) {
        return Some(monitors[i].clone());
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(test)]
mod display_tests {
    use super::*;

    fn d(name: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayId {
        DisplayId { name: name.into(), x, y, w, h }
    }

    #[test]
    fn a_display_is_found_again_after_changes() {
        let dell = d("DELL U2720Q", 1920, 0, 2560, 1440);
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let key = dell.key();
        assert_eq!(pick_display(&key, &[lap.clone(), dell.clone()]), Some(1));
        // Rearranged: the Dell moved to the left of the laptop.
        let moved = [d("eDP-1", 2560, 0, 1920, 1200), d("DELL U2720Q", 0, 0, 2560, 1440)];
        assert_eq!(pick_display(&key, &moved), Some(1));
        // Resolution changed, still the only Dell.
        let rescaled = [lap.clone(), d("DELL U2720Q", 1920, 0, 1920, 1080)];
        assert_eq!(pick_display(&key, &rescaled), Some(1));
        // Unplugged: nothing, so the caller falls back to the primary display.
        assert_eq!(pick_display(&key, &[lap.clone()]), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_place() {
        let a = d("LG 27UL500", 0, 0, 1920, 1080);
        let b = d("LG 27UL500", 1920, 0, 1920, 1080);
        assert_eq!(pick_display(&b.key(), &[a.clone(), b.clone()]), Some(1));
        assert_eq!(pick_display(&a.key(), &[a, b]), Some(0));
    }

    #[test]
    fn preferences_saved_before_still_match() {
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let ext = d("HDMI-1", 1920, 0, 1920, 1080);
        assert_eq!(pick_display("at:1920,0", &[lap.clone(), ext.clone()]), Some(1));
        assert_eq!(pick_display("primary", &[lap, ext]), None);
        assert_eq!(pick_display("at:nonsense", &[]), None);
    }
}

/// Calculates the zoom correction factor so that 1 CSS pixel equals 1 window logical pixel.
/// If WebView2's devicePixelRatio differs from the window's scale factor (e.g. system text
/// scaling or multi-monitor DPI mismatch), adjusting the webview zoom ensures the island
/// canvas (PANEL_W / EXPANDED_W) fits within the window without clipping.
pub fn calculate_zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    if dpr <= 0.0 || !dpr.is_finite() || scale <= 0.0 || !scale.is_finite() {
        return None;
    }
    if (dpr - scale).abs() / scale < 0.02 {
        return None;
    }
    let new_zoom = (current_zoom * (scale / dpr)).clamp(0.25, 4.0);
    Some(new_zoom)
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn zoom_correction_is_none_when_dpr_matches_window_scale() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.25), None);
        // Within 2% threshold
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.01), None);
    }

    #[test]
    fn zoom_correction_adjusts_for_dpi_mismatch() {
        // Issue #346: 100% scale display (scale 1.0) but WebView2 dpr = 1.25
        let zoom = calculate_zoom_correction(1.0, 1.0, 1.25);
        assert_eq!(zoom, Some(0.8));

        // 125% display with 125% text scale (dpr 1.5625 vs scale 1.25)
        let zoom = calculate_zoom_correction(1.0, 1.25, 1.5625);
        assert_eq!(zoom, Some(0.8));

        // 150% display with 100% webview dpr
        let zoom = calculate_zoom_correction(1.0, 1.5, 1.0);
        assert_eq!(zoom, Some(1.5));
    }

    #[test]
    fn only_a_cursor_near_the_island_is_followed() {
        let size = (PANEL_W, PANEL_H);
        assert!(is_near(360.0, 10.0, size));
        assert!(is_near(-400.0, PANEL_H + 400.0, size));
        assert!(!is_near(-500.0, 10.0, size));
        assert!(!is_near(360.0, PANEL_H + 900.0, size));
    }

    #[test]
    fn a_closed_island_stays_inside_the_panel() {
        assert_eq!(clamp_collapsed((160.0, 26.0), Edge::Top), (160.0, 26.0));
        assert_eq!(clamp_collapsed((5000.0, 900.0), Edge::Top), (PANEL_W, PANEL_H));
        assert_eq!(clamp_collapsed((5000.0, 900.0), Edge::Right), (SIDE_PANEL_W, SIDE_PANEL_H));
        assert_eq!(clamp_collapsed((0.0, -3.0), Edge::Top), (1.0, 1.0));
        assert_eq!(clamp_collapsed((f64::NAN, 26.0), Edge::Top), (PANEL_W, 26.0));
    }

    #[test]
    fn zoom_correction_handles_invalid_inputs() {
        assert_eq!(calculate_zoom_correction(1.0, 0.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, -1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, f64::NAN, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, f64::INFINITY), None);
    }

}


pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

pub fn placement(app: &AppHandle) -> Dock {
    if !cfg!(windows) { return Dock::default(); }
    app.try_state::<crate::Shared>().map(|state| state.settings.lock().unwrap().island_dock).unwrap_or_default()
}

fn work_area(m: &Monitor) -> WorkArea {
    let (position, size) = (m.position(), m.size());
    if cfg!(windows) {
        let work = m.work_area();
        if work.size.width > 0 && work.size.height > 0 {
            return WorkArea { x: work.position.x, y: work.position.y, w: work.size.width, h: work.size.height };
        }
    }
    WorkArea { x: position.x, y: position.y, w: size.width, h: size.height }
}

#[derive(Clone, Serialize)]
struct IslandFrame {
    edge: Edge,
    /// Desired anchor in window-local logical pixels.
    anchor: f64,
}

fn anchor_in_window(work: WorkArea, dock: Dock, x: i32, y: i32, scale: f64) -> f64 {
    if dock.edge.lateral() {
        (f64::from(work.y - y) + f64::from(work.h) * dock.offset()) / scale
    } else {
        (f64::from(work.x - x) + f64::from(work.w) * dock.offset()) / scale
    }
}

pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: Option<(f64, f64)>) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let ms = *m.size();
    let dock = placement(app);
    let work = work_area(&m);
    let (lw, lh) = collapsed.map(|size| clamp_collapsed(size, dock.edge)).unwrap_or_else(|| panel_size(dock.edge));
    let pw = (lw * scale).round().clamp(1.0, f64::from(work.w.max(1))) as u32;
    let ph = (lh * scale).round().clamp(1.0, f64::from(work.h.max(1))) as u32;
    let (x, y) = work.place(dock, pw, ph);
    let anchor = anchor_in_window(work, dock, x, y, scale);

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let (lx, ly) = logical_origin(&m);
    platform::pin_to_monitor(&win, lx, ly);
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);

    // On Windows, moving across displays or waking from the strip can clamp or lag
    // the resize. If the physical inner size differs from what was requested, retry once.
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            crate::log::line(format!(
                "window size mismatch: wanted {pw}x{ph}, got {}x{} (scale {scale}, monitor {}x{})",
                got.width, got.height, ms.width, ms.height
            ));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = win.emit("island-frame", IslandFrame { edge: dock.edge, anchor });
}

/// A closed island never grows past the panel, and never shrinks below one
/// pixel (a zero-sized window can't be placed).
pub fn clamp_collapsed((w, h): (f64, f64), edge: Edge) -> (f64, f64) {
    let ok = |v: f64, max: f64| if v.is_finite() { v.clamp(1.0, max) } else { max };
    let (max_w, max_h) = panel_size(edge);
    (ok(w, max_w), ok(h, max_h))
}

fn panel_size(edge: Edge) -> (f64, f64) {
    if edge.lateral() { (SIDE_PANEL_W, SIDE_PANEL_H) } else { (PANEL_W, PANEL_H) }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<ScreenKey> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let size = m.size();
    let work = work_area(&m);
    Some((work.x, work.y, work.w, work.h, size.width, size.height, m.scale_factor().to_bits()))
}

type ScreenKey = (i32, i32, u32, u32, u32, u32, u64);

fn watch_screen(app: &AppHandle, last: &mut Option<ScreenKey>) {
    if let Some(now) = current_screen_key(app) {
        if last.replace(now).is_some_and(|previous| previous != now) {
            crate::log::line("display layout changed — repositioning");
            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
        }
    }
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (16, 30) } else { (500, 1) };
        loop {
            // Parked. Folded on Windows, a glance at the cursor four times a
            // second: on the closed island, it is told to wake up, whether or
            // not the webview delivers the pointer to such a small window.
            let mut parked_ticks: u8 = 0;
            loop {
                if gate.wait_active_for(Duration::from_millis(250)) {
                    break;
                }
                if platform::CURSOR_POLL && gate.collapsed.load(Ordering::Relaxed) {
                    wake_if_hovered(&app, &gate);
                    parked_ticks = parked_ticks.wrapping_add(1);
                    if parked_ticks % 4 == 0 {
                        watch_screen(&app, &mut last_screen);
                    }
                }
            }
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            // The cursor was far at the last tick, and the page has been told.
            let mut far = false;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(if far { FAR_PERIOD_MS } else { period }));
                if !gate.is_active() {
                    break;
                }

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                #[cfg(windows)]
                if move_tick(&app, &gate) || center_tick(&app, &gate) {
                    last = (f64::MIN, f64::MIN);
                    far = false;
                    continue;
                }
                if ticks % screen_every == 0 {
                    watch_screen(&app, &mut last_screen);
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                // Re-evaluate hit testing even with a stationary pointer. A
                // drop can resize the island while the pointer is still down.
                let r = *gate.rect.lock().unwrap();
                let accept = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // The settings workaround only applies while that window is
                // visible. The island has its own WebView2 drop target.
                let down = left_button_down();
                if down && !was_down && crate::hub_is_shown() {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    // Under the gate's lock, and only while it is open: a tick
                    // still running as the island folds must not make the
                    // closed island click-through after set_collapsed made it
                    // take the mouse — nothing would ever wake it again.
                    let active = gate.active.lock().unwrap();
                    if !*active {
                        break;
                    }
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    platform::set_click_through(&win, !accept);
                }

                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Far from the island: the page hears it once, then nothing.
                let near = is_near(x, y, size);
                if !near && far {
                    continue;
                }
                far = !near;
                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

/// The cursor is on the folded window: it takes the mouse, and the page hears
/// `closed-hover` (it opens the compact island).
fn wake_if_hovered(app: &AppHandle, gate: &PollGate) {
    let Some(win) = window(app) else { return };
    let (Ok(origin), Ok(size), Some((cx, cy))) = (win.outer_position(), win.inner_size(), cursor_physical()) else { return };
    let x = cx - origin.x as f64;
    let y = cy - origin.y as f64;
    if x >= 0.0 && y >= 0.0 && x <= size.width as f64 && y <= size.height as f64 + 2.0 {
        gate.ignoring.store(false, Ordering::Relaxed);
        platform::set_click_through(&win, false);
        let _ = win.emit("closed-hover", ());
    }
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The closed island (or the wake strip) itself, never "the whole
        // window": if the window ever fails to shrink, the rest of it must not
        // swallow clicks meant for whatever sits under the top of the screen.
        let (w, h) = clamp_collapsed(*gate.collapsed_size.lock().unwrap(), placement(app).edge);
        Some((0.0, 0.0, w, h))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        platform::set_click_through(&win, ignore);
    }
}

fn restore_geometry(app: &AppHandle, shared: &crate::Shared) {
    let screen = shared.settings.lock().unwrap().screen.clone();
    let closed = shared.gate.collapsed.load(Ordering::Relaxed);
    let size = *shared.gate.collapsed_size.lock().unwrap();
    apply_geometry(app, &screen, closed.then_some(size));
    refresh_click_through(app, &shared.gate);
}

fn save_placement(app: &AppHandle, screen: Option<String>, dock: Option<Dock>) -> Result<(), String> {
    let Some(shared) = app.try_state::<crate::Shared>() else { return Ok(()) };
    let next = {
        let mut settings = shared.settings.lock().unwrap();
        let mut next = settings.clone();
        if let Some(screen) = screen { next.screen = screen; }
        if let Some(dock) = dock { next.island_dock = dock; }
        crate::settings::save(&next).map_err(|error| error.to_string())?;
        *settings = next.clone();
        next
    };
    restore_geometry(app, &shared);
    let _ = app.emit("settings-changed", next);
    Ok(())
}

pub fn reset_placement(app: &AppHandle) {
    cancel_move(app);
    if let Err(error) = save_placement(app, Some("primary".into()), Some(Dock::default())) {
        crate::log::line(format!("island position: {error}"));
    }
}

#[tauri::command]
pub fn set_island_placement(app: AppHandle, screen: Option<String>, edge: Option<Edge>, reset: Option<bool>) -> Result<(), String> {
    cancel_move(&app);
    if reset == Some(true) {
        return save_placement(&app, Some("primary".into()), Some(Dock::default()));
    }
    if let Some(pref) = screen.as_deref() {
        if !matches!(pref, "primary" | "cursor") && !monitor_choices(&app).iter().any(|choice| choice.key == pref) {
            return Err(crate::i18n::t("Display not found."));
        }
    }
    let dock = edge.filter(|_| cfg!(windows)).map(|edge| Dock { edge, ..Dock::default() });
    save_placement(&app, screen, dock)
}

#[cfg(windows)]
struct CenterMove {
    dock: Dock,
    work: WorkArea,
    size: PhysicalSize<u32>,
    scale: f64,
    started: std::time::Instant,
}

#[tauri::command]
pub fn center_island(app: AppHandle, win: WebviewWindow, animate: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let Some(shared) = app.try_state::<crate::Shared>() else { return Ok(()) };
        if win.label() != WINDOW_LABEL || !shared.gate.is_active()
            || shared.gate.centering.lock().unwrap().is_some() { return Ok(()); }
        let dock = placement(&app);
        if (dock.offset() - 0.5).abs() < 0.001 { return Ok(()); }
        cancel_move(&app);
        if animate {
            if let (Ok(Some(monitor)), Ok(size)) = (win.current_monitor(), win.inner_size()) {
                *shared.gate.centering.lock().unwrap() = Some(CenterMove {
                    dock, work: work_area(&monitor), size, scale: monitor.scale_factor(),
                    started: std::time::Instant::now(),
                });
                return Ok(());
            }
        }
        return save_placement(&app, None, Some(dock.toward_center(1.0)));
    }
    #[cfg(not(windows))]
    { let _ = (app, win, animate); Ok(()) }
}

#[cfg(windows)]
fn center_tick(app: &AppHandle, gate: &PollGate) -> bool {
    let mut active = gate.centering.lock().unwrap();
    let Some(motion) = active.as_ref() else { return false };
    let progress = motion.started.elapsed().as_secs_f64() / 0.32;
    let dock = motion.dock.toward_center(progress);
    if progress < 1.0 {
        if let Some(win) = window(app) {
            let (x, y) = motion.work.place(dock, motion.size.width, motion.size.height);
            let anchor = anchor_in_window(motion.work, dock, x, y, motion.scale);
            let _ = win.set_position(PhysicalPosition::new(x, y));
            let _ = win.emit("island-frame", IslandFrame { edge: dock.edge, anchor });
        }
        return true;
    }
    *active = None;
    drop(active);
    if let Err(error) = save_placement(app, None, Some(dock)) {
        crate::log::line(format!("island position: {error}"));
        if let Some(shared) = app.try_state::<crate::Shared>() { restore_geometry(app, &shared); }
    }
    true
}

#[cfg(windows)]
struct IslandMove {
    start: (f64, f64),
    grab: (f64, f64),
    surface: IslandRect,
    scale: f64,
    moved: bool,
    edge: Option<Edge>,
    pull: f64,
    last_cursor: (f64, f64),
    monitors: Vec<Monitor>,
    checked_at: std::time::Instant,
}

#[cfg(windows)]
impl IslandMove {
    fn surface_at(&self, cursor: (f64, f64), scale: f64) -> (f64, f64) {
        (cursor.0 + (self.surface.x - self.grab.0) * scale,
         cursor.1 + (self.surface.y - self.grab.1) * scale)
    }

    fn size_at(&self, scale: f64) -> (f64, f64) {
        (self.surface.w * scale, self.surface.h * scale)
    }
}

#[tauri::command]
pub fn begin_island_move(win: WebviewWindow, shared: tauri::State<'_, crate::Shared>, x: f64, y: f64) -> bool {
    #[cfg(windows)]
    {
        if win.label() != WINDOW_LABEL || !shared.gate.is_active() || !left_button_down()
            || shared.gate.centering.lock().unwrap().is_some() {
            return false;
        }
        let Ok(origin) = win.outer_position() else { return false };
        let scale = win.scale_factor().unwrap_or(1.0);
        let Some(start) = cursor_physical() else { return false };
        let grab = ((start.0 - f64::from(origin.x)) / scale, (start.1 - f64::from(origin.y)) / scale);
        let rect = *shared.gate.rect.lock().unwrap();
        if !x.is_finite() || !y.is_finite() || x < rect.x || x > rect.x + rect.w
            || y < rect.y || y > rect.y + rect.h
        {
            return false;
        }
        let edge = shared.settings.lock().unwrap().island_dock.edge;
        let mut active = shared.gate.moving.lock().unwrap();
        if active.is_some() { return false; }
        *active = Some(IslandMove { start, grab, surface: rect, scale, moved: false, edge: Some(edge), pull: 1.0,
            last_cursor: start, monitors: win.available_monitors().unwrap_or_default(),
            checked_at: std::time::Instant::now() });
        return true;
    }
    #[cfg(not(windows))]
    { let _ = (win, shared, x, y); false }
}

pub fn cancel_move(app: &AppHandle) {
    #[cfg(windows)]
    if let Some(shared) = app.try_state::<crate::Shared>() {
        let moving = shared.gate.moving.lock().unwrap().take().is_some();
        let centering = shared.gate.centering.lock().unwrap().take().is_some();
        if moving || centering {
            restore_geometry(app, &shared);
        }
        if moving {
            let _ = app.emit_to(WINDOW_LABEL, "island-move-end", false);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn cancel_island_move(app: AppHandle) {
    cancel_move(&app);
}

#[cfg(windows)]
fn move_tick(app: &AppHandle, gate: &PollGate) -> bool {
    let mut state = gate.moving.lock().unwrap();
    let Some(drag) = state.as_mut() else { return false };
    let cursor = cursor_physical();
    let released = !left_button_down();
    let cancelled = platform::escape_down();
    if released || cancelled || cursor.is_none() {
        let drag = state.take().unwrap();
        drop(state);
        let passed_threshold = cursor.is_some_and(|(x, y)| {
            (x - drag.start.0).hypot(y - drag.start.1) >= 6.0 * drag.scale
        });
        let moved = drag.moved || passed_threshold;
        let clicked = released && !cancelled && cursor.is_some() && !moved;
        let target = cursor.filter(|_| moved && !cancelled).and_then(|(x, y)| {
            let monitor = app.available_monitors().ok()?.into_iter().find(|m| monitor_contains(m, x, y))?;
            let scale = monitor.scale_factor();
            work_area(&monitor).magnet(drag.surface_at((x, y), scale), drag.size_at(scale), scale, drag.edge)
                .filter(|(_, strength)| *strength >= 0.8)
                .map(|(dock, _)| (describe(&monitor).key(), dock))
        });
        if let Some((screen, dock)) = target {
            if let Err(error) = save_placement(app, Some(screen), Some(dock)) {
                crate::log::line(format!("island position: {error}"));
                if let Some(shared) = app.try_state::<crate::Shared>() { restore_geometry(app, &shared); }
            }
        } else if drag.moved {
            if let Some(shared) = app.try_state::<crate::Shared>() { restore_geometry(app, &shared); }
        }
        let _ = app.emit_to(WINDOW_LABEL, "island-move-end", clicked);
        return true;
    }

    let Some(cursor) = cursor else { return true };
    if !drag.moved {
        let distance = (cursor.0 - drag.start.0).hypot(cursor.1 - drag.start.1);
        if distance < 6.0 * drag.scale { return true; }
        drag.moved = true;
    }
    if drag.last_cursor == cursor { return true; }
    drag.last_cursor = cursor;
    if drag.checked_at.elapsed() >= Duration::from_millis(160) {
        if let Ok(monitors) = app.available_monitors() { drag.monitors = monitors; }
        drag.checked_at = std::time::Instant::now();
    }
    let monitor = drag.monitors.iter().find(|m| monitor_contains(m, cursor.0, cursor.1));
    let scale = monitor.map_or(drag.scale, Monitor::scale_factor);
    let free = drag.surface_at(cursor, scale);
    let size = drag.size_at(scale);
    let snap = monitor.and_then(|m| {
        let work = work_area(m);
        work.magnet(free, size, scale, drag.edge).map(|(dock, strength)| (work, dock, strength))
    });
    if let Some(win) = window(app) {
        let preview = snap.map(|(_, dock, strength)| (dock.edge, strength));
        let edge = preview.map(|(edge, _)| edge);
        let pull = preview.map_or(0.0, |(_, pull)| pull);
        if drag.edge != edge || (drag.pull - pull).abs() > 0.004 {
            drag.edge = edge;
            drag.pull = pull;
            let _ = win.emit("island-move-preview", preview);
        }
        let position = match snap {
            Some((work, dock, strength)) => {
                let (x, y) = work.place(dock, size.0.round() as u32, size.1.round() as u32);
                (free.0 + (f64::from(x) - free.0) * strength, free.1 + (f64::from(y) - free.1) * strength)
            }
            None => free,
        };
        let x = (position.0 - drag.surface.x * scale).round() as i32;
        let y = (position.1 - drag.surface.y * scale).round() as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    true
}
