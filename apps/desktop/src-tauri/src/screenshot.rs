//! Screenshot capture.
//!
//! ## The constraint this module is built around
//!
//! Elite Dangerous is not touched. No DLL injection, no process memory access,
//! no DirectX hooking, no input automation, no modification of the game's own
//! screenshot system. Everything here is a read of what the desktop compositor
//! is already showing, through public Win32 APIs — the same discipline
//! `overlay.rs` follows, and for the same reason: an anti-cheat-visible
//! technique is not worth a convenience feature.
//!
//! ## Why GDI `BitBlt` rather than something newer
//!
//! Three approaches can capture a screen on Windows without touching the target
//! process:
//!
//! | Approach | Verdict |
//! |---|---|
//! | **GDI `BitBlt` from the screen DC** | Chosen. Pure read, public API, no new system dependencies, works on every supported Windows version. |
//! | Windows.Graphics.Capture | Better with exclusive fullscreen, but pulls in WinRT interop and a much larger surface for one feature. |
//! | DXGI Desktop Duplication | Also capable, also a Direct3D device and swap-chain lifetime to own. |
//!
//! `BitBlt` is the smallest thing that does the job, and the one whose failure
//! modes are easiest to explain to a commander. The others are a reasonable
//! upgrade later if exclusive fullscreen turns out to matter; nothing here
//! prevents that.
//!
//! ## What it cannot do, stated plainly
//!
//! **Exclusive fullscreen is expected to produce a black or stale image.** A
//! Direct3D application in true exclusive fullscreen owns the display's
//! swapchain and bypasses the desktop compositor, so there is nothing for a GDI
//! read of the screen DC to copy. This is the same limitation the overlay has,
//! for the same underlying reason, and `overlay::elite_display_mode` already
//! detects the setting — so the caller can warn *before* capturing rather than
//! handing over a black PNG.
//!
//! Borderless and windowed are the supported configurations.
//!
//! This is stated as an expectation rather than a measurement: it follows from
//! how exclusive fullscreen works, and this project does not claim verified
//! behaviour it has not verified. See `docs/SCREENSHOTS.md`.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Where a capture landed, and what it actually contains.
#[derive(Debug, Serialize)]
pub struct CaptureResult {
    /// Absolute path of the written file. Always a staging file; the frontend
    /// renames it once the commander has confirmed what it is.
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// `elite-window`, `elite-monitor` or `primary-monitor`.
    pub source: String,
    /// True when the image is entirely one colour, which is what exclusive
    /// fullscreen looks like from here. Reported rather than silently saved.
    pub looks_blank: bool,
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HBITMAP, HGDIOBJ, SRCCOPY,
    };

    /// The rectangle to copy, in virtual-screen coordinates.
    struct Target {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        source: &'static str,
    }

    fn target() -> Target {
        let info = crate::overlay::elite_window_info();

        /*
         * The game's own window rectangle, not the whole screen: a second
         * monitor full of other windows, the taskbar and anything overlapping
         * are all excluded, and in borderless the rectangle already covers the
         * monitor exactly.
         *
         * A minimised window has a meaningless rectangle, so that falls through
         * to the primary monitor rather than capturing off-screen coordinates.
         */
        if info.found && !info.is_minimised && info.width > 0 && info.height > 0 {
            return Target {
                x: info.x,
                y: info.y,
                width: info.width,
                height: info.height,
                source: "elite-window",
            };
        }

        let (w, h) = primary_size();
        Target {
            x: 0,
            y: 0,
            width: w,
            height: h,
            source: "primary-monitor",
        }
    }

    fn primary_size() -> (i32, i32) {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
        };
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
    }

    /// Copy the target rectangle into a BGRA buffer.
    ///
    /// Every GDI object is released on every path, including the error paths.
    /// A leaked DC or bitmap per capture would be a slow resource leak in a
    /// process that stays open for an entire play session.
    pub fn grab() -> Result<(Vec<u8>, u32, u32, &'static str), String> {
        let t = target();
        if t.width <= 0 || t.height <= 0 {
            return Err("Could not determine a screen area to capture.".into());
        }

        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("Could not open the screen device context.".into());
            }

            let mem = CreateCompatibleDC(screen);
            if mem.is_invalid() {
                ReleaseDC(None, screen);
                return Err("Could not create a capture device context.".into());
            }

            let bitmap: HBITMAP = CreateCompatibleBitmap(screen, t.width, t.height);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem);
                ReleaseDC(None, screen);
                return Err("Could not allocate a capture bitmap.".into());
            }

            let previous: HGDIOBJ = SelectObject(mem, HGDIOBJ::from(bitmap));

            let copied = BitBlt(mem, 0, 0, t.width, t.height, screen, t.x, t.y, SRCCOPY);

            let mut header = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: t.width,
                    // Negative height requests a top-down buffer, so the rows
                    // arrive in the order an encoder expects instead of upside
                    // down.
                    biHeight: -t.height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut buffer = vec![0u8; (t.width as usize) * (t.height as usize) * 4];
            let rows = if copied.is_ok() {
                GetDIBits(
                    mem,
                    bitmap,
                    0,
                    t.height as u32,
                    Some(buffer.as_mut_ptr() as *mut _),
                    &mut header,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            SelectObject(mem, previous);
            let _ = DeleteObject(HGDIOBJ::from(bitmap));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);

            if copied.is_err() {
                return Err("The screen copy failed.".into());
            }
            if rows == 0 {
                return Err("Could not read the captured pixels.".into());
            }

            Ok((buffer, t.width as u32, t.height as u32, t.source))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn grab() -> Result<(Vec<u8>, u32, u32, &'static str), String> {
        Err("Screenshot capture is implemented for Windows only.".into())
    }
}

/// Whether every pixel is the same colour.
///
/// This is what exclusive fullscreen looks like through a GDI read: a uniform
/// black frame. Detecting it lets the caller say so instead of cataloguing an
/// empty image and leaving the commander to discover it later.
///
/// Checked on a stride rather than every pixel: a 4K frame is 8.3 million of
/// them, and a uniform image is uniform at any sampling.
fn uniform(bgra: &[u8]) -> bool {
    if bgra.len() < 4 {
        return true;
    }
    let first = &bgra[0..3];
    let stride = (bgra.len() / 4 / 4096).max(1) * 4;
    let mut i = 0;
    while i + 3 < bgra.len() {
        if &bgra[i..i + 3] != first {
            return false;
        }
        i += stride;
    }
    true
}

/// BGRA (what GDI gives) to RGBA (what the encoder wants), dropping alpha.
///
/// `BitBlt` from the screen leaves the alpha byte undefined rather than 255, so
/// carrying it through would produce a PNG that some viewers render as fully
/// transparent.
fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len() / 4 * 3);
    for px in bgra.chunks_exact(4) {
        out.push(px[2]);
        out.push(px[1]);
        out.push(px[0]);
    }
    out
}

/// Capture, and write a PNG into `staging_dir`.
///
/// **Always writes to a staging file**, never to the commander's chosen name.
/// The rename happens later, after they have confirmed what the screenshot is —
/// so a cancelled dialog, a bad filename or an unavailable destination can never
/// lose the image. §22 asks for exactly this.
/**
 * How long to let the compositor settle after hiding the overlay.
 *
 * A heuristic, and labelled as one. `hide()` returns as soon as the request is
 * made; the desktop compositor redraws on its own schedule, so capturing
 * immediately can still catch the overlay mid-fade. Two frames at 60Hz is 33ms,
 * so this is roughly double that -- short enough not to be felt, long enough to
 * cover a loaded machine.
 *
 * There is no event that says "the compositor has finished", which is why this
 * is a wait rather than a signal.
 */
const OVERLAY_SETTLE_MS: u64 = 80;

/**
 * Hide the overlay for the duration of a capture, then put it back.
 *
 * The capture reads the composited screen, so anything drawn over the game ends
 * up in the image -- including this app's own overlay. A screenshot of a vista
 * with a sample counter stamped across it is not the screenshot the commander
 * wanted.
 *
 * Restores on **every** path, including a failed capture: an overlay left
 * hidden because a screenshot errored would look like the overlay had broken.
 *
 * Only this app's overlay can be hidden. Another application's overlay (Discord,
 * Steam, a recorder) is outside our control and will still appear.
 */
struct OverlayHidden<R: tauri::Runtime> {
    window: Option<tauri::WebviewWindow<R>>,
}

impl<R: tauri::Runtime> OverlayHidden<R> {
    fn hide(app: &tauri::AppHandle<R>) -> Self {
        use tauri::Manager;

        let window = app.get_webview_window(crate::overlay::OVERLAY_LABEL).filter(|w| {
            // Only hide what is actually on screen. The overlay may already be
            // hidden -- switched off, or auto-hidden while the game is not
            // focused -- and showing it afterwards would turn a capture into a
            // way of summoning it.
            w.is_visible().unwrap_or(false)
        });

        if let Some(w) = &window {
            let _ = w.hide();
            std::thread::sleep(std::time::Duration::from_millis(OVERLAY_SETTLE_MS));
        }

        Self { window }
    }
}

impl<R: tauri::Runtime> Drop for OverlayHidden<R> {
    fn drop(&mut self) {
        if let Some(w) = &self.window {
            let _ = w.show();
        }
    }
}

#[tauri::command]
pub fn capture_screenshot<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    staging_dir: String,
    // `true` keeps this app's overlay in the image. Absent means omit it, which
    // is what a commander photographing a vista wants.
    include_overlay: Option<bool>,
) -> Result<CaptureResult, String> {
    // Held across the capture; `Drop` restores the overlay however this returns.
    let _hidden = if include_overlay.unwrap_or(false) {
        None
    } else {
        Some(OverlayHidden::hide(&app))
    };

    let (bgra, width, height, source) = imp::grab()?;
    let looks_blank = uniform(&bgra);

    let dir = PathBuf::from(&staging_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|_| "Could not create the folder for the captured image.".to_string())?;

    // A monotonic-ish name; the staging file is transient and is renamed almost
    // immediately, so this only has to be unique within a session.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("capture-{stamp}.png"));

    write_png(&path, &bgra_to_rgb(&bgra), width, height)?;

    Ok(CaptureResult {
        path: path.to_string_lossy().to_string(),
        width,
        height,
        source: source.to_string(),
        looks_blank,
    })
}

fn write_png(path: &Path, rgb: &[u8], width: u32, height: u32) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|_| "Could not write the captured image.".to_string())?;
    let writer = std::io::BufWriter::new(file);

    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = encoder
        .write_header()
        .map_err(|_| "Could not start the image file.".to_string())?;
    writer
        .write_image_data(rgb)
        .map_err(|_| "Could not finish writing the image file.".to_string())?;
    Ok(())
}

/// The Pictures folder, through the known-folder API.
///
/// Not built by appending "Pictures" to the user profile: the folder is
/// relocatable, and on a machine where it has been moved to another drive a
/// string-built path is simply wrong.
#[cfg(windows)]
fn pictures() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Pictures, KF_FLAG_DEFAULT};

    unsafe {
        let raw: PWSTR = SHGetKnownFolderPath(&FOLDERID_Pictures, KF_FLAG_DEFAULT, None).ok()?;
        let value = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        value
    }
}

#[cfg(not(windows))]
fn pictures() -> Option<String> {
    None
}

#[tauri::command]
pub fn pictures_dir() -> Option<String> {
    pictures()
}

/// Move the staged capture to its final name.
///
/// Rename first, copy-then-delete as a fallback: a rename across volumes fails,
/// and the commander's chosen folder may well be on a different drive from the
/// temporary one.
///
/// **The staged file is left alone if anything fails.** Losing a screenshot
/// because its destination was unavailable would be the worst outcome this
/// feature could produce.
#[tauri::command]
pub fn commit_screenshot(from: String, to: String) -> Result<String, String> {
    commit_file(&from, &to)
}

/// The logic behind `commit_screenshot`.
///
/// Separate from the command because `#[tauri::command]` shadows the function
/// name, so a test cannot call the wrapper directly.
fn commit_file(from: &str, to: &str) -> Result<String, String> {
    let src = PathBuf::from(from);
    let dst = PathBuf::from(to);

    if !src.is_file() {
        return Err("The captured image is no longer available.".into());
    }
    if dst.exists() {
        // The caller resolves collisions before getting here; refusing is still
        // correct, because silently overwriting somebody's screenshot is not
        // recoverable.
        return Err("A file with that name already exists.".into());
    }

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Could not create the destination folder.".to_string())?;
    }

    match std::fs::rename(&src, &dst) {
        Ok(()) => Ok(dst.to_string_lossy().to_string()),
        Err(_) => {
            std::fs::copy(&src, &dst)
                .map_err(|_| "Could not move the image to the destination folder.".to_string())?;
            // Best effort: a leftover staging file is untidy, not harmful.
            let _ = std::fs::remove_file(&src);
            Ok(dst.to_string_lossy().to_string())
        }
    }
}

/// Whether a path exists, for collision resolution.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/**
 * Which of these paths are still there.
 *
 * Batched because the catalog checks every row at once, and three hundred
 * separate IPC round trips to ask three hundred one-word questions would make
 * opening the screen feel broken.
 *
 * Returns a flag per input, in order. A path that cannot be examined at all
 * reports `false` the same as a missing one: from here "the drive is
 * disconnected" and "the file was deleted" are the same answer, which is
 * exactly why the caller marks rather than deletes.
 */
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

/// Whether a folder can actually be written to.
///
/// Checked by writing, not by reading permissions: a folder on a disconnected
/// network drive or a removed SD card reads as plausible and fails on use, and
/// §22 requires failing clearly rather than saving somewhere unexpected.
#[tauri::command]
pub fn folder_writable(path: String) -> bool {
    let dir = PathBuf::from(&path);
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let probe = dir.join(".edfm-write-test");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Delete an image the commander explicitly asked to delete.
///
/// Separate from removing a catalog row on purpose: §16 requires the two to be
/// distinguishable, because one is reversible and the other is not.
#[tauri::command]
pub fn delete_screenshot_file(path: String) -> Result<(), String> {
    std::fs::remove_file(Path::new(&path))
        .map_err(|_| "Could not delete the image file.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uniform_buffer_is_recognised() {
        // What exclusive fullscreen looks like through a GDI read.
        let black = vec![0u8; 64 * 4];
        assert!(uniform(&black));
    }

    #[test]
    fn a_buffer_with_any_variation_is_not_uniform() {
        let mut buf = vec![0u8; 64 * 4];
        buf[40] = 9;
        assert!(!uniform(&buf));
    }

    #[test]
    fn bgra_becomes_rgb_in_the_right_order() {
        // Blue, green, red, undefined alpha -> red, green, blue.
        let bgra = vec![1u8, 2, 3, 255];
        assert_eq!(bgra_to_rgb(&bgra), vec![3, 2, 1]);
    }

    #[test]
    fn the_undefined_alpha_byte_is_dropped() {
        /*
         * BitBlt from the screen leaves alpha undefined rather than opaque, so
         * carrying it into the PNG would make some viewers render the whole
         * image transparent.
         */
        let bgra = vec![10u8, 20, 30, 0];
        assert_eq!(bgra_to_rgb(&bgra).len(), 3);
    }

    /// Capture really works on this machine.
    ///
    /// Asserted rather than assumed: the whole feature rests on `BitBlt` from
    /// the screen DC returning real pixels, and a module that compiles proves
    /// nothing about that. Tolerant of a session with no desktop -- it reports
    /// the skip rather than failing a headless run.
    #[cfg(windows)]
    #[test]
    fn captures_real_pixels_from_the_desktop() {
        let Ok((bgra, w, h, source)) = imp::grab() else {
            eprintln!("no desktop available; capture not exercised");
            return;
        };
        assert!(w > 0 && h > 0, "captured {w}x{h}");
        assert_eq!(bgra.len(), (w as usize) * (h as usize) * 4);
        assert!(
            ["elite-window", "primary-monitor"].contains(&source),
            "unexpected source {source}"
        );
        // A real desktop is not one flat colour. If this fails on a machine with
        // a genuinely uniform screen it is a false alarm, but it is the only
        // cheap evidence that pixels were actually read rather than a zeroed
        // buffer returned.
        assert!(!uniform(&bgra), "captured image was entirely one colour");
    }

    #[test]
    fn the_overlay_is_restored_by_drop_rather_than_inline() {
        /*
         * The restore must survive every exit from `capture_screenshot`,
         * including the `?` on a failed grab and any future early return. A
         * `Drop` impl cannot be skipped; a `show()` call written after the
         * capture can be, and an overlay left hidden because a screenshot
         * errored would look like the overlay itself had broken.
         *
         * A source guard, as in credentials.rs. `concat!` so this test does not
         * match its own text.
         */
        let src = include_str!("screenshot.rs");
        assert!(
            src.contains(concat!("impl<R: tauri::Runtime> ", "Drop for OverlayHidden<R>")),
            "the overlay restore is no longer tied to Drop"
        );
        assert!(
            src.contains(concat!("let _hidden = if include_overlay")),
            "the guard is no longer held across the capture"
        );
    }

    #[test]
    fn an_already_hidden_overlay_is_left_alone() {
        /*
         * Only a visible overlay is hidden and restored. The overlay may be
         * switched off, or auto-hidden because the game is not focused, and
         * showing it afterwards would turn taking a screenshot into a way of
         * summoning it.
         */
        let src = include_str!("screenshot.rs");
        assert!(src.contains(concat!("w.is_visible()", ".unwrap_or(false)")));
    }

    #[test]
    fn writes_a_real_png() {
        let dir = std::env::temp_dir().join("edfm-shot-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.png");
        let _ = std::fs::remove_file(&path);

        write_png(&path, &[255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3], 2, 2).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        // The PNG signature, so this asserts a real encode rather than a file
        // that merely exists.
        assert_eq!(&bytes[0..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn committing_refuses_to_overwrite() {
        let dir = std::env::temp_dir().join("edfm-shot-test-2");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.png");
        let dst = dir.join("dst.png");
        std::fs::write(&src, b"a").unwrap();
        std::fs::write(&dst, b"b").unwrap();

        let err = commit_file(&src.to_string_lossy(), &dst.to_string_lossy()).unwrap_err();
        assert!(err.contains("already exists"));
        // The staged capture survives the refusal.
        assert!(src.is_file());
        assert_eq!(std::fs::read(&dst).unwrap(), b"b");

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn committing_a_missing_capture_reports_rather_than_panicking() {
        let err = commit_file("Z:/nope/missing.png", "Z:/nope/out.png").unwrap_err();
        assert!(err.contains("no longer available"));
    }

    #[test]
    fn errors_never_contain_the_path() {
        /*
         * §21: a screenshot path can name a commander's account folder, and
         * these strings reach logs and the UI. They describe what failed, never
         * where.
         */
        let secret = std::env::temp_dir().join("CMDR-Private-Folder").join("x.png");
        let err = commit_file(&secret.to_string_lossy(), "Z:/nope/out.png").unwrap_err();
        assert!(!err.contains("CMDR-Private-Folder"));
    }
}
