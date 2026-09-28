/**
 * Outbound HTTP for the desktop client.
 *
 * Every request to the EDFM API goes through Tauri's HTTP plugin rather than the
 * WebView's own `fetch`. Three reasons, in order of weight:
 *
 *  1. **The WebView's CSP would otherwise have to name the API.** Tauri applies
 *     `app.security.csp` to the webview, and it only ever appends `script-src` and
 *     `style-src` hashes of its own — `connect-src` is the developer's to provide.
 *     With none present it falls back to `default-src 'self'`, which blocks the
 *     API outright in a packaged build. Widening the CSP would fix that by opening
 *     the web layer; this fixes it by not using the web layer.
 *
 *  2. **The API would otherwise have to relax CORS.** A WebView request carries an
 *     app origin, so the server would need `Access-Control-Allow-Origin` for it.
 *     That weakens the API for every client in order to serve this one. Going
 *     through Rust keeps it same-origin-only from any browser's point of view.
 *
 *  3. **The allowlist becomes enforceable rather than advisory.** The permitted
 *     URLs live in `src-tauri/capabilities/default.json` and are checked natively,
 *     so a bug in frontend code cannot reach an origin the capability does not
 *     name. A CSP string is a weaker and less auditable place for that boundary.
 *
 * Requests are still shaped exactly like `fetch`, so the injection seams the
 * verification package already exposes (`fetchImpl`) take this unchanged.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * `fetch`, routed through the native layer.
 *
 * Typed as the DOM `fetch` so it drops into the existing `fetchImpl` seams. The
 * plugin implements the same contract; what differs is who performs the request
 * and who is allowed to authorise it.
 */
export const httpFetch: typeof fetch = tauriFetch as typeof fetch;

/**
 * Whether the native HTTP layer is available.
 *
 * False under plain Vite in a browser tab, where there is no Tauri runtime. The
 * app is not usable there anyway — journal access, SQL and the overlay are all
 * native — but tests and the dev server should degrade rather than throw at
 * module load.
 */
export function hasNativeHttp(): boolean {
  return typeof tauriFetch === 'function';
}
