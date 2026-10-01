//! EDSM journal submission transport.
//!
//! The same boundary as the EDFM journal sync: the API key never enters
//! JavaScript. It is read from the Windows Credential Manager here and placed
//! into the form body, so a secret cannot reach a log line, an error message or
//! a screenshot.
//!
//! That shapes the command's signature. The frontend hands over the *entries*
//! and the identifying fields; the key is added on this side. A command that
//! took a finished form body would mean the key had already been in a renderer.

use std::time::Duration;

use crate::edfm_journal::HttpOutcome;

const INTEGRATION: &str = "edsm";
const JOURNAL_URL: &str = "https://www.edsm.net/api-journal-v1";
const DISCARD_URL: &str = "https://www.edsm.net/api-journal-v1/discard";
const TIMEOUT: Duration = Duration::from_secs(30);

/// What the frontend supplies. Everything here is already public knowledge:
/// none of it is a secret, which is the point of the split.
#[derive(Debug, serde::Deserialize)]
pub struct EdsmSubmission {
    pub commander_name: String,
    pub software_name: String,
    pub software_version: String,
    pub game_version: Option<String>,
    pub game_build: Option<String>,
    /// A JSON array of journal entries, already built and bounded.
    pub message_json: String,
}

fn client() -> Result<reqwest::Client, HttpOutcome> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("EDFMCompanion/", env!("CARGO_PKG_VERSION")))
        // The key travels in the body, so a redirect to plain HTTP would put it
        // on the wire in clear. Redirects are not followed.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpOutcome::transport_public("client-unavailable"))
}

/// Submit journal entries.
///
/// Never returns `Err`: a transport failure is an outcome to display, not an
/// exception. "EDSM is unreachable" and "the app is broken" look the same to a
/// commander otherwise.
#[tauri::command]
pub async fn edsm_submit(submission: EdsmSubmission) -> HttpOutcome {
    let Some(api_key) = crate::credentials::read_secret(INTEGRATION) else {
        return HttpOutcome::transport_public("no-credential");
    };
    if api_key.trim().is_empty() {
        return HttpOutcome::transport_public("no-credential");
    }

    let http = match client() {
        Ok(c) => c,
        Err(out) => return out,
    };

    // Built here so the key is never assembled anywhere a renderer could see.
    let mut form: Vec<(&str, String)> = vec![
        ("commanderName", submission.commander_name),
        ("apiKey", api_key),
        ("fromSoftware", submission.software_name),
        ("fromSoftwareVersion", submission.software_version),
        ("message", submission.message_json),
    ];
    // Frontier asked that the game version be reported so live and legacy data
    // are not mixed. Omitted rather than faked when it has not been observed.
    if let Some(v) = submission.game_version {
        form.push(("fromGameVersion", v));
    }
    if let Some(b) = submission.game_build {
        form.push(("fromGameBuild", b));
    }

    match http.post(JOURNAL_URL).form(&form).send().await {
        Ok(response) => HttpOutcome::from_response(response).await,
        Err(e) if e.is_timeout() => HttpOutcome::transport_public("timeout"),
        Err(e) if e.is_connect() => HttpOutcome::transport_public("connection-failed"),
        Err(_) => HttpOutcome::transport_public("request-failed"),
    }
}

/// Fetch the list of events EDSM asks clients not to send.
///
/// Unauthenticated, and fetched live rather than hard-coded: the list changes
/// as the game does, and a stale copy would mean sending traffic EDSM has
/// explicitly asked not to receive.
#[tauri::command]
pub async fn edsm_discard() -> HttpOutcome {
    let http = match client() {
        Ok(c) => c,
        Err(out) => return out,
    };
    match http.get(DISCARD_URL).send().await {
        Ok(response) => HttpOutcome::from_response(response).await,
        Err(e) if e.is_timeout() => HttpOutcome::transport_public("timeout"),
        Err(_) => HttpOutcome::transport_public("request-failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_added_here_and_never_taken_from_the_caller() {
        /*
         * The signature is the guarantee. `EdsmSubmission` carries only public
         * fields; a command that accepted a finished form body would mean the
         * key had already passed through a renderer.
         */
        let src = include_str!("edsm.rs");
        assert!(
            !src.contains(concat!("pub api_", "key")),
            "the submission struct gained a field that carries the key"
        );
        assert!(
            src.contains(concat!("read_", "secret(INTEGRATION)")),
            "the key is no longer read from the credential store here"
        );
    }

    #[test]
    fn requests_go_only_to_edsm_over_https() {
        assert!(JOURNAL_URL.starts_with("https://www.edsm.net/"));
        assert!(DISCARD_URL.starts_with("https://www.edsm.net/"));
    }

    #[test]
    fn redirects_are_refused_so_the_key_cannot_leave_in_clear() {
        // The key is in the body, not a header, so a downgrade would expose it.
        let src = include_str!("edsm.rs");
        assert!(src.contains("redirect::Policy::none()"));
    }
}
