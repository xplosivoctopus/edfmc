//! Secure storage for external service credentials.
//!
//! An EDSM or Inara API key is the commander's account, not a preference. It
//! does not belong in the settings table beside the overlay opacity.
//!
//! ## What was chosen, and what was rejected
//!
//! **Chosen: the OS credential store**, via the `keyring` crate's native Windows
//! backend, which is the Windows Credential Manager. Encrypted at rest by the
//! OS, scoped to the user account, and requires no vault password of its own.
//!
//! **Rejected: `tauri-plugin-stronghold`.** It is a real encrypted vault, but it
//! is unlocked with a password the commander would have to invent and re-enter.
//! For one API key that is worse security in practice, because the password ends
//! up written down or trivial.
//!
//! **Rejected: the settings table.** It is a plain SQLite file. Calling that
//! credential storage would be the sort of claim this project has already had to
//! correct once, in the privacy documentation.
//!
//! ## The boundary that matters more than the storage
//!
//! **There is deliberately no command that reads a secret back out.** The
//! frontend can store one, clear one, and ask whether one exists — never fetch
//! it. A secret that reaches JavaScript can reach a log line, an error message,
//! a crash report or a screenshot, and this codebase has already shipped a
//! privacy claim that did not match its code.
//!
//! The consequence is a design constraint, recorded here so it is not discovered
//! later: **any integration needing a credential must perform its HTTP request
//! in Rust.** EDDN needs none, which is why it is the one implemented first.

use keyring::Entry;

/// Namespace in the OS store. Stable: changing it orphans saved credentials.
const SERVICE: &str = "com.edfieldmanual.companion";

/// Reject obvious nonsense before it reaches the OS store.
///
/// Not validation of the key itself — only this project's own bounds, so a
/// malformed call cannot write something unbounded into the user's credential
/// manager.
fn check(integration: &str, secret: &str) -> Result<(), String> {
    if integration.is_empty() || integration.len() > 32 {
        return Err("Unknown integration.".into());
    }
    if !integration
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Unknown integration.".into());
    }
    if secret.is_empty() {
        return Err("The key is empty.".into());
    }
    if secret.len() > 4096 {
        return Err("That does not look like an API key.".into());
    }
    Ok(())
}

/// Store a credential.
///
/// Errors are deliberately vague about the value. `keyring`'s own messages are
/// about the store, not the secret, but the secret is never interpolated into
/// anything returned from here regardless.
#[tauri::command]
pub fn credential_set(integration: String, secret: String) -> Result<(), String> {
    check(&integration, &secret)?;
    let entry = Entry::new(SERVICE, &integration).map_err(|e| format!("Credential store unavailable: {e}"))?;
    entry
        .set_password(&secret)
        .map_err(|e| format!("Could not save the credential: {e}"))
}

/// Whether a credential exists.
///
/// The only read. Returns a boolean, never the value — see the module note.
#[tauri::command]
pub fn credential_present(integration: String) -> bool {
    let Ok(entry) = Entry::new(SERVICE, &integration) else {
        return false;
    };
    entry.get_password().is_ok()
}

/// Read a stored secret, **for Rust callers only**.
///
/// Deliberately `pub(crate)` and deliberately **not** a `#[tauri::command]`, so
/// it is unreachable from JavaScript. The boundary this module defends is "a
/// secret never reaches the webview", not "no code may ever read one" -- an
/// authenticated request has to be made by somebody.
///
/// Making the request in Rust is the whole point: the token goes from the OS
/// credential store into an `Authorization` header without passing through a
/// renderer where it could reach a log line, an error message, a crash report
/// or a screenshot.
///
/// If this ever needs to become a command, it does not. Move the caller into
/// Rust instead.
pub(crate) fn read_secret(integration: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, integration).ok()?;
    entry.get_password().ok()
}

#[tauri::command]
pub fn credential_clear(integration: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &integration).map_err(|e| format!("Credential store unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Already absent is the desired end state, not a failure.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the credential: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_integration_name_that_is_not_one_of_ours() {
        // The name becomes a key in the user's credential manager, so it is
        // constrained rather than trusted.
        for bad in ["", "Inara", "../../etc", "a b", &"x".repeat(64)] {
            assert!(check(bad, "secret").is_err(), "should reject {bad:?}");
        }
        assert!(check("edsm", "secret").is_ok());
        assert!(check("inara-live", "secret").is_ok());
    }

    #[test]
    fn rejects_an_empty_or_absurd_secret() {
        assert!(check("edsm", "").is_err());
        assert!(check("edsm", &"x".repeat(5000)).is_err());
    }

    #[test]
    fn error_messages_never_contain_the_secret() {
        // The property that matters. An error string can reach a log, a toast or
        // a screenshot, and this project has already shipped one privacy claim
        // that did not match its code.
        let secret = "super-secret-api-key-value";
        for bad_name in ["", "NOPE", "a b"] {
            let err = check(bad_name, secret).unwrap_err();
            assert!(!err.contains(secret), "leaked the secret: {err}");
        }
        let err = check("edsm", &"x".repeat(5000)).unwrap_err();
        assert!(!err.contains("xxxx"), "echoed the secret back: {err}");
    }

    #[test]
    fn there_is_no_way_to_read_a_secret_back() {
        // Enforced by the module's surface rather than by convention: if a getter
        // is ever added, this test is the place that should have stopped it.
        let source = include_str!("credentials.rs");
        // Assembled rather than written out: include_str! pulls in this test
        // too, so a literal needle would match itself and the check would pass
        // no matter what the module actually exposed.
        // The internal reader exists for Rust callers; what must not exist is a
        // way to ask for a secret from the webview. Needles are assembled so
        // this test does not match its own text.
        let command = concat!("#[tauri::", "command]");
        let reader = concat!("fn read_", "secret");
        for (i, _) in source.match_indices(reader) {
            let before = &source[i.saturating_sub(120)..i];
            assert!(
                !before.contains(command),
                "the internal reader became a command and can now be called from JavaScript"
            );
        }
        let getter = concat!("pub fn ", "credential_get");
        assert!(
            !source.contains(getter),
            "a credential getter would let a secret reach JavaScript"
        );
    }
}
