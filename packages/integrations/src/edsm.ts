/**
 * EDSM journal submission.
 *
 * Your personal flight log on EDSM, tied to your account rather than published
 * anonymously the way EDDN is.
 *
 * ## The contract, and how it was established
 *
 * `www.edsm.net`'s documentation pages sit behind bot protection, so the HTML
 * could not be read programmatically and was not going to be guessed at. What is
 * encoded here came from two sources that are not guesses:
 *
 * 1. **The live API itself.** `GET /api-journal-v1/discard` is public and
 *    machine-readable, and deliberately malformed `POST`s return the real error
 *    envelope.
 * 2. **The published page**, read by the project owner.
 *
 * ## The finding that shapes everything here
 *
 * **EDSM answers `HTTP 200` even when the request failed.**
 *
 * ```
 * POST /api-journal-v1   (no credentials)
 * HTTP 200
 * {"msgnum":201,"msg":"Missing commander name","events":[]}
 * ```
 *
 * So the HTTP status says nothing at all about the outcome: the result is
 * `msgnum`. Classifying on the status code would mark every failure as a
 * success and silently discard the commander's log. Measured codes:
 *
 * | `msgnum` | Meaning |
 * |---|---|
 * | 100 | Accepted |
 * | 201 | Missing commander name |
 * | 202 | Missing API key |
 * | 203 | Commander name / API key not found |
 *
 * 201–203 are all configuration or credential problems. Resending identical
 * bytes produces the identical answer, so none of them is retried; they stop
 * submission and ask the commander to look at their key.
 */

/** Verified by probe, and by the published page. */
export const EDSM_JOURNAL_URL = 'https://www.edsm.net/api-journal-v1';
/** Returns the event names EDSM asks clients not to send. */
export const EDSM_DISCARD_URL = 'https://www.edsm.net/api-journal-v1/discard';

/**
 * `msgnum` 100 is the only value that means the submission was taken.
 *
 * Named rather than inlined because it is checked in two places and getting it
 * wrong in either silently loses a log entry.
 */
export const EDSM_OK = 100;

/**
 * Top-level codes that will never succeed on a retry.
 *
 * All three are statements about the credential or the request shape, not about
 * the server's mood. Retrying them would be pointless traffic and would hide a
 * key the commander needs to fix.
 */
export const EDSM_CREDENTIAL_CODES = new Set([201, 202, 203]);

/** The outcome of one submission, already classified. */
export type EdsmOutcome =
  | { readonly kind: 'accepted'; readonly perEvent: readonly EdsmEventResult[] }
  | { readonly kind: 'credential'; readonly code: number; readonly message: string }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export interface EdsmEventResult {
  readonly index: number;
  readonly msgnum: number;
  readonly msg: string;
  /** Whether EDSM took this entry. */
  readonly accepted: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read a response.
 *
 * Treated as untrusted input throughout: a body that is not the documented
 * shape produces `malformed`, and nothing is marked as submitted. The HTTP
 * status is deliberately not an argument — it carries no information.
 */
export function parseEdsmResponse(body: unknown): EdsmOutcome {
  if (!isRecord(body)) return { kind: 'malformed', reason: 'the reply was not an object' };

  const msgnum = body['msgnum'];
  const msg = typeof body['msg'] === 'string' ? body['msg'] : '';
  if (typeof msgnum !== 'number') {
    return { kind: 'malformed', reason: 'the reply carried no status number' };
  }

  if (EDSM_CREDENTIAL_CODES.has(msgnum)) {
    return { kind: 'credential', code: msgnum, message: msg };
  }

  if (msgnum !== EDSM_OK) {
    /*
     * An unrecognised top-level code. Retried rather than discarded: the known
     * permanent cases are enumerated above, and treating an unknown code as
     * fatal would throw away a log entry over a message this client has simply
     * never seen.
     */
    return { kind: 'retry', reason: msg || `EDSM replied with status ${msgnum}` };
  }

  const rawEvents = body['events'];
  if (!Array.isArray(rawEvents)) {
    return { kind: 'malformed', reason: 'the reply carried no per-event results' };
  }

  const perEvent: EdsmEventResult[] = [];
  rawEvents.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const code = typeof raw['msgnum'] === 'number' ? raw['msgnum'] : -1;
    perEvent.push({
      index,
      msgnum: code,
      msg: typeof raw['msg'] === 'string' ? raw['msg'] : '',
      accepted: code === EDSM_OK,
    });
  });

  return { kind: 'accepted', perEvent };
}

/**
 * Fields EDSM asks clients to add to each entry.
 *
 * Most journal events carry no system context of their own, so EDSM cannot
 * place them without this. The leading underscore is theirs, marking the fields
 * as client-supplied rather than from the game.
 */
export interface EdsmContext {
  readonly systemName: string | null;
  readonly systemAddress: number | null;
  readonly systemCoordinates: readonly [number, number, number] | null;
  readonly stationName: string | null;
  readonly marketId: number | null;
  readonly shipId: number | null;
}

/**
 * Augment one journal entry for submission.
 *
 * The entry is sent **as the game wrote it**, with context added alongside.
 * EDSM is a journal-forwarding API: it wants the real event, and rewriting its
 * fields would be this client inventing history.
 *
 * Only what is actually known is added. A null is omitted rather than sent,
 * because "the game did not say" and "the value is empty" are different claims.
 */
export function augmentForEdsm(
  raw: Readonly<Record<string, unknown>>,
  context: EdsmContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  if (context.systemName !== null) out['_systemName'] = context.systemName;
  if (context.systemAddress !== null) out['_systemAddress'] = context.systemAddress;
  if (context.systemCoordinates !== null) out['_systemCoordinates'] = context.systemCoordinates;
  if (context.stationName !== null) out['_stationName'] = context.stationName;
  if (context.marketId !== null) out['_marketId'] = context.marketId;
  if (context.shipId !== null) out['_shipId'] = context.shipId;

  return out;
}

/**
 * Whether EDSM wants this event at all.
 *
 * The discard list is fetched from the live endpoint rather than hard-coded:
 * it changes as the game does, and a stale copy would mean sending traffic
 * EDSM has explicitly asked not to receive. 141 names at the time of writing.
 *
 * An empty list means the fetch failed, and nothing is filtered out on that
 * basis — guessing that an event is unwanted would lose it.
 */
export function isDiscardedByEdsm(event: string, discard: ReadonlySet<string>): boolean {
  return discard.has(event);
}

/** Parse the discard endpoint's reply, which is a bare JSON array of names. */
export function parseEdsmDiscard(body: unknown): ReadonlySet<string> {
  if (!Array.isArray(body)) return new Set();
  return new Set(body.filter((v): v is string => typeof v === 'string'));
}

/**
 * Build the form body.
 *
 * `application/x-www-form-urlencoded`, which is what the endpoint takes, with
 * `message` carrying a JSON array so several entries go in one request.
 */
/**
 * Build the form body EDSM expects.
 *
 * **This is not the production path, and must not be mistaken for it.** The
 * real request is assembled in `edsm.rs`, because the API key is read from the
 * credential store in Rust and may never enter JavaScript -- so the form the
 * app actually sends is built there.
 *
 * What survives here is the field contract: the names, the omissions, and the
 * encoding, exercised by tests that would be awkward to write against Rust.
 * A change to the fields EDSM expects has to be made in **both** places.
 */
export function buildEdsmSubmission(input: {
  readonly commanderName: string;
  readonly apiKey: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  readonly entries: readonly Record<string, unknown>[];
}): string {
  const form = new URLSearchParams();
  form.set('commanderName', input.commanderName);
  form.set('apiKey', input.apiKey);
  form.set('fromSoftware', input.softwareName);
  form.set('fromSoftwareVersion', input.softwareVersion);
  // Frontier asked that the game version be reported, so live and legacy data
  // are not mixed. Omitted rather than faked when the header has not been seen.
  if (input.gameVersion !== null) form.set('fromGameVersion', input.gameVersion);
  if (input.gameBuild !== null) form.set('fromGameBuild', input.gameBuild);
  form.set('message', JSON.stringify(input.entries));
  return form.toString();
}
