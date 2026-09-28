//! Reading the plugins folder.
//!
//! The webview has no filesystem permission, so this is a narrow command in the
//! same spirit as the journal ones: it reads exactly one directory, returns
//! text, and does nothing else. Parsing and validation happen in TypeScript,
//! where the rule schemas already live.
//!
//! Nothing here executes anything. A plugin is a `plugin.json` file, and the
//! only way it can affect the application is by being valid data that the
//! existing engines already know how to evaluate.
//!
//! ## Failing loudly
//!
//! The hard part is not reading files; it is what happens when reading fails.
//! Two real situations make a plugin vanish for reasons the commander cannot
//! guess:
//!
//! - **OneDrive Files On-Demand.** A redirected Documents folder can hold
//!   `plugin.json` as a cloud placeholder. Reading it while offline fails.
//! - **Linux without xdg-user-dirs.** `document_dir()` can succeed and hand
//!   back a path that does not exist and cannot be created.
//!
//! Both used to be silent `continue`s, which meant "no plugins installed" and
//! "your plugin could not be read" looked identical. Every failure below is
//! now returned so the UI can say which folder failed and why.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct RawPlugin {
    /// Folder name, so a commander can find the one that misbehaved.
    directory: String,
    json: String,
    /// Optional README.md beside the manifest.
    ///
    /// Instructions can also live in the manifest, but a JSON string full of
    /// escaped newlines is a miserable way to write a paragraph, and authors
    /// already reach for a README without being asked.
    readme: Option<String>,
}

#[derive(Serialize)]
pub struct ScanError {
    /// Folder that failed, or the root when the whole scan failed.
    directory: String,
    message: String,
}

#[derive(Serialize)]
pub struct PluginScan {
    /// Absolute path actually used, so the UI never has to guess.
    directory: Option<String>,
    /// `documents`, `app-data`, or `none`.
    source: String,
    /// Set when the preferred location was unusable and why.
    fallback_reason: Option<String>,
    plugins: Vec<RawPlugin>,
    errors: Vec<ScanError>,
}

/// Is this directory genuinely usable, not merely a path we can name?
///
/// `create_dir_all` succeeding is not proof: a read-only home, a stale
/// `user-dirs.dirs` entry pointing at a removed drive, or a permissions problem
/// all produce a path that exists on paper and fails on use. So the check is a
/// real write.
/// Ceilings matching @edfm/plugins PLUGIN_LIMITS, enforced *here*.
///
/// The TypeScript validator has always checked manifest size, but it could only
/// check it after this function had already read the whole file into memory. A
/// two-gigabyte plugin.json was therefore an allocation, not a rejection. A limit
/// only binds in the layer that does the reading.
///
/// Slightly above the validator's limits on purpose: this is the crude "do not
/// read absurd files" guard, and the precise limit, with the message an author
/// can act on, stays in one place over there.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_README_BYTES: u64 = 256 * 1024;

/// Read a file, refusing before allocating if it is larger than `max`.
fn read_bounded(path: &Path, max: u64) -> Result<String, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > max {
        return Err(format!(
            "File is {size} bytes, over the {max}-byte limit for this file; refusing to read it."
        ));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn usable(dir: &Path) -> Result<(), String> {
    if let Err(e) = fs::create_dir_all(dir) {
        return Err(format!("could not create it ({e})"));
    }
    let probe = dir.join(".edfm-write-test");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("it is not writable ({e})")),
    }
}

/// Where plugins live, with the reason if it is not the preferred location.
///
/// `Documents/EDFM Companion/plugins` first, because installing a plugin means
/// a person putting a folder somewhere they can find. App data second, so a
/// machine with no usable Documents folder still has plugins rather than a
/// broken feature — which is the common case on a minimal Linux install with no
/// `xdg-user-dirs` package.
fn resolve(app: &tauri::AppHandle) -> (Option<PathBuf>, &'static str, Option<String>) {
    let documents = app
        .path()
        .document_dir()
        .ok()
        .map(|d| d.join("EDFM Companion").join("plugins"));

    if let Some(dir) = documents {
        match usable(&dir) {
            Ok(()) => return (Some(dir), "documents", None),
            Err(why) => {
                // Fall through, but remember why: "we put your plugins
                // somewhere else" is only helpful with the reason attached.
                if let Ok(app_data) = app.path().app_data_dir() {
                    let alt = app_data.join("plugins");
                    if usable(&alt).is_ok() {
                        return (
                            Some(alt),
                            "app-data",
                            Some(format!("Documents could not be used: {why}")),
                        );
                    }
                }
                return (None, "none", Some(format!("Documents could not be used: {why}")));
            }
        }
    }

    // No Documents folder at all. Normal on a headless or minimal Linux system.
    match app.path().app_data_dir() {
        Ok(app_data) => {
            let alt = app_data.join("plugins");
            match usable(&alt) {
                Ok(()) => (
                    Some(alt),
                    "app-data",
                    Some("This system has no Documents folder.".to_string()),
                ),
                Err(why) => (None, "none", Some(format!("No usable folder: {why}"))),
            }
        }
        Err(e) => (None, "none", Some(format!("No usable folder ({e})"))),
    }
}

fn plugins_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    resolve(app).0
}

#[tauri::command]
pub fn plugins_dir(app: tauri::AppHandle) -> Option<String> {
    plugins_path(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Is this file a cloud placeholder rather than real local content?
///
/// OneDrive's Files On-Demand leaves a stub with the offline / recall
/// attributes set; opening it triggers a download that fails when the machine
/// is offline or the account is signed out. Worth naming explicitly, because
/// "permission denied" or "incomplete" tells a commander nothing actionable
/// while "OneDrive is holding this online-only" tells them exactly what to fix.
#[cfg(target_os = "windows")]
fn cloud_placeholder(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x0000_1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    fs::metadata(path)
        .map(|m| m.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0)
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn cloud_placeholder(_path: &Path) -> bool {
    false
}

/// Every `plugin.json` directly inside a subfolder of the plugins directory.
///
/// One level deep only. Recursing would let a plugin hide manifests inside
/// another plugin's folder, which makes "which plugin contributed this" a
/// question with no clear answer.
#[tauri::command]
pub fn plugins_read(app: tauri::AppHandle) -> PluginScan {
    let (root, source, fallback_reason) = resolve(&app);

    let Some(root) = root else {
        return PluginScan {
            directory: None,
            source: source.to_string(),
            fallback_reason,
            plugins: Vec::new(),
            errors: Vec::new(),
        };
    };

    let mut plugins = Vec::new();
    let mut errors = Vec::new();

    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) => {
            errors.push(ScanError {
                directory: root.to_string_lossy().into_owned(),
                message: format!("Could not read the plugins folder: {e}"),
            });
            return PluginScan {
                directory: Some(root.to_string_lossy().into_owned()),
                source: source.to_string(),
                fallback_reason,
                plugins,
                errors,
            };
        }
    };

    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let manifest = entry.path().join("plugin.json");

        // A folder without a manifest is not an error: authors leave notes,
        // screenshots and version-control directories lying around.
        if !manifest.exists() {
            continue;
        }

        match read_bounded(&manifest, MAX_MANIFEST_BYTES) {
            Ok(json) => {
                // Missing or unreadable is simply "no readme": an author who
                // wrote no instructions is not an error, and one whose readme
                // is a cloud placeholder should still get their plugin loaded.
                let readme = read_bounded(&entry.path().join("README.md"), MAX_README_BYTES).ok();
                plugins.push(RawPlugin {
                    directory: name,
                    json,
                    readme,
                });
            }
            Err(e) => {
                // The file is there and we cannot read it. Never silent: this
                // is the case that makes a plugin appear uninstalled.
                let message = if cloud_placeholder(&manifest) {
                    "OneDrive is storing this plugin online-only, so it could not be read. \
                     Right-click the folder and choose \"Always keep on this device\", \
                     or reconnect and try again."
                        .to_string()
                } else {
                    format!("Could not read plugin.json: {e}")
                };
                errors.push(ScanError {
                    directory: name,
                    message,
                });
            }
        }

        // Bounded here as well as in TypeScript: reading ten thousand files to
        // then discard them is still ten thousand file reads.
        if plugins.len() >= 64 {
            break;
        }
    }

    PluginScan {
        directory: Some(root.to_string_lossy().into_owned()),
        source: source.to_string(),
        fallback_reason,
        plugins,
        errors,
    }
}

/// Openers to try on Linux, in order of how likely they are to exist.
///
/// `xdg-open` alone is not enough: it ships with xdg-utils, which a minimal
/// install may not have, and the same systems that lack it also tend to lack a
/// configured Documents folder. Each is tried in turn, and if none works the
/// error names them so the UI can fall back to showing the path to copy.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_OPENERS: &[&str] = &["xdg-open", "gio", "nautilus", "dolphin", "thunar", "nemo"];

/// Show the plugins folder in the system file manager.
///
/// Installing a plugin means putting a folder here, so the app has to be able
/// to point at where "here" is.
#[tauri::command]
pub fn plugins_open_folder(app: tauri::AppHandle) -> Result<(), String> {
    let path = plugins_path(&app)
        .ok_or_else(|| "There is no usable plugins folder on this system.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for opener in LINUX_OPENERS {
            // `gio` needs its subcommand; the rest take the path directly.
            let mut command = std::process::Command::new(opener);
            if *opener == "gio" {
                command.arg("open");
            }
            if command.arg(&path).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(format!(
            "Could not open a file manager (tried {}). The folder is: {}",
            LINUX_OPENERS.join(", "),
            path.to_string_lossy()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("edfm-plugins-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn usable_accepts_a_directory_it_can_create_and_write() {
        let dir = temp("ok");
        assert!(usable(&dir).is_ok());
        assert!(dir.exists());
        // The probe must not be left behind for the scanner to trip over.
        assert!(!dir.join(".edfm-write-test").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn usable_rejects_a_path_that_cannot_be_a_directory() {
        // A stale user-dirs.dirs entry pointing at a file is exactly the shape
        // of Linux breakage this guards against: the path resolves, and using
        // it fails.
        let blocker = temp("blocked");
        fs::create_dir_all(blocker.parent().unwrap()).unwrap();
        fs::write(&blocker, b"not a directory").unwrap();

        let inside = blocker.join("plugins");
        assert!(usable(&inside).is_err());

        let _ = fs::remove_file(&blocker);
    }

    #[test]
    fn usable_is_idempotent_on_an_existing_folder() {
        let dir = temp("twice");
        assert!(usable(&dir).is_ok());
        assert!(usable(&dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_bounded_refuses_a_file_over_the_limit_without_reading_it() {
        // The point of the limit: a plugin.json larger than the ceiling must be
        // refused rather than allocated. The TypeScript validator could only ever
        // check this after the whole file was already in memory.
        let dir = temp("bounded");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.json");
        fs::write(&path, vec![b'x'; 4096]).unwrap();

        let err = read_bounded(&path, 1024).unwrap_err();
        assert!(err.contains("4096"), "message should name the size: {err}");
        assert!(err.contains("refusing"), "message should say what it did: {err}");

        // The same file is fine under a limit that permits it.
        assert_eq!(read_bounded(&path, 8192).unwrap().len(), 4096);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_bounded_reports_a_missing_file_rather_than_panicking() {
        let missing = temp("bounded-missing").join("nope.json");
        assert!(read_bounded(&missing, 1024).is_err());
    }

    #[test]
    fn an_ordinary_local_file_is_not_a_cloud_placeholder() {
        let dir = temp("cloud");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("plugin.json");
        fs::write(&file, b"{}").unwrap();
        assert!(!cloud_placeholder(&file));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_not_reported_as_a_placeholder() {
        // metadata() fails here; the check must say "no" rather than panic or
        // guess, because the caller only reaches it after a read already failed.
        assert!(!cloud_placeholder(Path::new("no-such-file-anywhere.json")));
    }
}
