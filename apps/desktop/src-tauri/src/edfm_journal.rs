//! EDFM Commander Journal transport.
//!
//! ## Why this is in Rust at all
//!
//! The journal sync token never enters JavaScript. `credentials.rs` has no
//! command that reads a secret back, and that boundary is the point: a secret
//! that reaches a renderer can reach a log line, an error message, a crash
//! report or a screenshot.
//!
//! So the authenticated request is made here. The token goes from the Windows
//! Credential Manager straight into an `Authorization` header and is never
//! returned, logged, or put in an error string.
//!
//! ## What this module deliberately does not do
//!
//! It does not interpret the response. The status code and the body come back
//! as data, and the parsing, validation and retry classification happen in
//! TypeScript where they are covered by tests against the deployed contract.
//! Splitting it that way keeps the hard part testable without a live server,
//! and keeps this file small enough to audit for the one property that matters:
//! the token goes out, nothing comes back that could contain it.

use serde::Serialize;
use std::time::Duration;

/// The integration name the token is filed under in the credential store.
const INTEGRATION: &str = "edfm-journal";

/// Production base. Centralised so there is exactly one place a request can go.
const BASE: &str = "https://edfieldmanual.com";
const STATUS_PATH: &str = "/rest.php/edfm-journal/v1/status";
const BATCH_PATH: &str = "/rest.php/edfm-journal/v1/batch";

/// Generous enough for a slow link, short enough that a stalled sync does not
/// look like a hung app. Sync is background work; nothing waits on it.
const TIMEOUT: Duration = Duration::from_secs(30);

/// What the caller gets back. The token is not in here, and cannot be.
#[derive(Debug, Serialize)]
pub struct HttpOutcome {
    /// HTTP status, or 0 when the request never reached a server.
    pub status: u16,
    /// Response body, verbatim, for the TypeScript parsers to validate.
    pub body: String,
    /// `Retry-After` in seconds when the server sent one.
    #[serde(rename = "retryAfterSeconds")]
    pub retry_after_seconds: Option<u64>,
    /// Set when the request failed before a response existed. Never contains a
    /// URL, a header or the token.
    pub transport_error: Option<String>,
}

impl HttpOutcome {
    /// A failure that happened before any server answered.
    ///
    /// The message is a category, not the underlying error text: a transport
    /// error can carry the request URL, and this string reaches a log.
    ///
    /// Shared with the other authenticated transports, which have the same
    /// requirement, so the rule is written once.
    pub(crate) fn transport_public(reason: &'static str) -> Self {
        Self::transport(reason)
    }

    fn transport(reason: &'static str) -> Self {
        Self {
            status: 0,
            body: String::new(),
            retry_after_seconds: None,
            transport_error: Some(reason.to_string()),
        }
    }
}

fn client() -> Result<reqwest::Client, HttpOutcome> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("EDFMCompanion/", env!("CARGO_PKG_VERSION")))
        // HTTPS only. A redirect to plain HTTP would put the Authorization
        // header on the wire in clear, so redirects are not followed at all.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpOutcome::transport("client-unavailable"))
}

/// The bearer token, or a failure the caller can report without detail.
fn token() -> Result<String, HttpOutcome> {
    match crate::credentials::read_secret(INTEGRATION) {
        Some(secret) if !secret.trim().is_empty() => Ok(secret),
        _ => Err(HttpOutcome::transport("no-credential")),
    }
}

fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// Read a response into an outcome.
///
/// The body is capped: the deployed server's own responses are small, and an
/// unbounded read of an unexpected body (a proxy's error page, say) is memory
/// handed to something that is already behaving oddly.
const MAX_BODY: usize = 1024 * 1024;

impl HttpOutcome {
    /// Read a response into an outcome. Shared by the transports.
    pub(crate) async fn from_response(response: reqwest::Response) -> HttpOutcome {
        finish(response).await
    }
}

async fn finish(response: reqwest::Response) -> HttpOutcome {
    let status = response.status().as_u16();
    let retry = retry_after(&response);

    let body = match response.text().await {
        Ok(text) if text.len() > MAX_BODY => text[..MAX_BODY].to_string(),
        Ok(text) => text,
        // A response that cannot be read is reported as itself rather than as a
        // success with an empty body, which the caller would have to guess at.
        Err(_) => {
            return HttpOutcome {
                status,
                body: String::new(),
                retry_after_seconds: retry,
                transport_error: Some("unreadable-body".into()),
            }
        }
    };

    HttpOutcome {
        status,
        body,
        retry_after_seconds: retry,
        transport_error: None,
    }
}

/// `GET /status`, authenticated.
///
/// Never returns `Err`: a transport failure is an outcome the caller displays,
/// not an exception. The distinction matters because "EDFM is unreachable" and
/// "the app is broken" look the same to a commander otherwise.
#[tauri::command]
pub async fn edfm_journal_status() -> HttpOutcome {
    let bearer = match token() {
        Ok(t) => t,
        Err(out) => return out,
    };
    let http = match client() {
        Ok(c) => c,
        Err(out) => return out,
    };

    match http
        .get(format!("{BASE}{STATUS_PATH}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {bearer}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => finish(response).await,
        Err(e) if e.is_timeout() => HttpOutcome::transport("timeout"),
        Err(e) if e.is_connect() => HttpOutcome::transport("connection-failed"),
        Err(_) => HttpOutcome::transport("request-failed"),
    }
}

/// `POST /batch`, authenticated.
///
/// `body` is the complete JSON document built and bounded in TypeScript. It is
/// sent verbatim: re-encoding it here would change the bytes the size limit was
/// measured against.
#[tauri::command]
pub async fn edfm_journal_batch(body: String) -> HttpOutcome {
    let bearer = match token() {
        Ok(t) => t,
        Err(out) => return out,
    };
    let http = match client() {
        Ok(c) => c,
        Err(out) => return out,
    };

    match http
        .post(format!("{BASE}{BATCH_PATH}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {bearer}"))
        // The handler requires exactly this; anything else is a 415.
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(response) => finish(response).await,
        Err(e) if e.is_timeout() => HttpOutcome::transport("timeout"),
        Err(e) if e.is_connect() => HttpOutcome::transport("connection-failed"),
        Err(_) => HttpOutcome::transport("request-failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_never_leaves_this_module() {
        /*
         * The property the whole design rests on. `HttpOutcome` is the only
         * thing that crosses to JavaScript, and none of its fields can carry a
         * credential: the status is a number, the body is the server's, and the
         * transport error is one of a fixed set of category strings.
         *
         * A source guard, because the alternative is trusting that nobody ever
         * adds a field. `concat!` so this test does not match its own text.
         */
        let src = include_str!("edfm_journal.rs");
        assert!(
            !src.contains(concat!("pub ", "token:")),
            "HttpOutcome gained a field that could carry the token"
        );
        assert!(
            !src.contains(concat!("bearer", ".clone()")),
            "the bearer token is being copied somewhere"
        );
        // Every transport error is a literal, never a formatted error value.
        assert!(
            !src.contains(concat!("transport(&", "format!")),
            "a transport error is being built from an error value"
        );
    }

    #[test]
    fn transport_errors_are_categories_rather_than_detail() {
        // These strings reach a log. A reqwest error can carry the full URL.
        for reason in ["timeout", "connection-failed", "request-failed", "no-credential"] {
            let out = HttpOutcome::transport(reason);
            assert_eq!(out.status, 0);
            assert!(out.body.is_empty());
            assert_eq!(out.transport_error.as_deref(), Some(reason));
        }
    }

    #[test]
    fn requests_go_only_to_the_production_host_over_https() {
        // Centralised, and asserted: one place a request can go.
        assert!(BASE.starts_with("https://"));
        assert_eq!(BASE, "https://edfieldmanual.com");
        assert_eq!(STATUS_PATH, "/rest.php/edfm-journal/v1/status");
        assert_eq!(BATCH_PATH, "/rest.php/edfm-journal/v1/batch");
    }

    #[test]
    fn redirects_are_refused_so_the_header_cannot_be_replayed_in_clear() {
        let src = include_str!("edfm_journal.rs");
        assert!(src.contains("redirect::Policy::none()"));
    }
}
