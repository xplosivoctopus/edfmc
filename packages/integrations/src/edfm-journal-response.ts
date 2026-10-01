/**
 * Reading what the EDFM journal server says back.
 *
 * **Every response here is untrusted input.** The rule the spec sets and this
 * module enforces: an entry is synchronised when the server *acknowledged that
 * entry*, never because the HTTP status was 2xx. A 200 with a malformed body
 * acknowledges nothing, and treating it as success would silently drop the
 * commander's activity.
 *
 * Shapes transcribed from the deployed `StatusHandler` and `BatchHandler`.
 */

/** Per-entry outcomes the server reports. */
export type EntryStatus = 'created' | 'updated' | 'unchanged' | 'rejected';

export interface EntryResult {
  readonly index: number;
  /** Null when the validator could not recover an id from the submitted entry. */
  readonly id: string | null;
  readonly status: EntryStatus;
  /** Present only on `rejected`. */
  readonly code?: string;
  readonly message?: string;
}

export interface BatchOutcome {
  readonly apiVersion: number;
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly summary: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly rejected: number;
  };
  readonly results: readonly EntryResult[];
}

export interface JournalStatus {
  readonly apiVersion: number;
  readonly schemaVersion: number;
  readonly scope: string;
  readonly visibility: string;
  readonly entryCount: number;
  /**
   * MediaWiki timestamp `YYYYMMDDHHMMSS`, or null.
   *
   * **Not RFC 3339.** Parsing it as an ISO string yields an invalid date, so it
   * is converted explicitly where it is displayed.
   */
  readonly lastSync: string | null;
  readonly allowedCategories: readonly string[];
  readonly limits: {
    readonly maxBatchEntries: number;
    readonly maxRequestBytes: number;
    readonly maxEntryDataBytes: number;
  };
  readonly serverTime: string;
}

/** Why a request did not produce a usable answer, in terms a commander reads. */
export type FailureKind =
  | 'invalid-credential'
  | 'rate-limited'
  | 'server-unavailable'
  | 'network-unavailable'
  | 'malformed-response'
  | 'profile-missing'
  | 'rejected-request';

export interface Failure {
  readonly kind: FailureKind;
  /** One sentence, safe to show. Never a raw server body. */
  readonly message: string;
  /** Whether trying the same request again could succeed. */
  readonly retryable: boolean;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Parse `/status`.
 *
 * Returns null when the body is not the documented shape. A status screen built
 * on a half-understood response is worse than one that says it could not read
 * the answer.
 */
export function parseStatus(body: unknown): JournalStatus | null {
  if (!isRecord(body)) return null;

  const apiVersion = num(body['apiVersion']);
  const schemaVersion = num(body['schemaVersion']);
  const scope = str(body['scope']);
  const journal = body['journal'];
  const limits = body['limits'];
  const serverTime = str(body['serverTime']);

  if (apiVersion === null || schemaVersion === null || scope === null) return null;
  if (!isRecord(journal) || !isRecord(limits) || serverTime === null) return null;

  const entryCount = num(journal['entryCount']);
  if (entryCount === null) return null;
  const visibility = str(journal['visibility']);
  if (visibility === null) return null;

  const lastSyncRaw = journal['lastSync'];
  if (lastSyncRaw !== null && typeof lastSyncRaw !== 'string') return null;

  const maxBatchEntries = num(limits['maxBatchEntries']);
  const maxRequestBytes = num(limits['maxRequestBytes']);
  const maxEntryDataBytes = num(limits['maxEntryDataBytes']);
  if (maxBatchEntries === null || maxRequestBytes === null || maxEntryDataBytes === null) {
    return null;
  }

  const categories = Array.isArray(body['allowedCategories'])
    ? body['allowedCategories'].filter((c): c is string => typeof c === 'string')
    : [];

  return {
    apiVersion,
    schemaVersion,
    scope,
    visibility,
    entryCount,
    lastSync: lastSyncRaw ?? null,
    allowedCategories: categories,
    limits: { maxBatchEntries, maxRequestBytes, maxEntryDataBytes },
    serverTime,
  };
}

/** `YYYYMMDDHHMMSS` to a Date, or null. The server's format, not ISO. */
export function parseMediaWikiTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * Parse a batch response.
 *
 * Returns null on anything that is not the documented shape, including a 200
 * whose `results` cannot be read. Nothing is marked synchronised from a
 * response this cannot understand.
 */
export function parseBatchOutcome(body: unknown): BatchOutcome | null {
  if (!isRecord(body)) return null;

  const apiVersion = num(body['apiVersion']);
  const schemaVersion = num(body['schemaVersion']);
  const requestId = str(body['requestId']);
  const summary = body['summary'];
  const rawResults = body['results'];

  if (apiVersion === null || schemaVersion === null || requestId === null) return null;
  if (!isRecord(summary) || !Array.isArray(rawResults)) return null;

  const created = num(summary['created']);
  const updated = num(summary['updated']);
  const unchanged = num(summary['unchanged']);
  const rejected = num(summary['rejected']);
  if (created === null || updated === null || unchanged === null || rejected === null) return null;

  const results: EntryResult[] = [];
  for (const raw of rawResults) {
    if (!isRecord(raw)) return null;
    const index = num(raw['index']);
    const status = str(raw['status']);
    if (index === null || status === null) return null;
    if (!['created', 'updated', 'unchanged', 'rejected'].includes(status)) return null;

    const idRaw = raw['id'];
    if (idRaw !== null && typeof idRaw !== 'string') return null;

    const entry: EntryResult = {
      index,
      id: idRaw ?? null,
      status: status as EntryStatus,
    };

    if (status === 'rejected') {
      const error = raw['error'];
      results.push(
        isRecord(error)
          ? { ...entry, code: str(error['code']) ?? 'unknown', message: str(error['message']) ?? '' }
          : { ...entry, code: 'unknown', message: '' },
      );
    } else {
      results.push(entry);
    }
  }

  return {
    apiVersion,
    schemaVersion,
    requestId,
    summary: { created, updated, unchanged, rejected },
    results,
  };
}

/**
 * Per-entry rejection codes that will never succeed, however often they are
 * sent.
 *
 * The server classifies nothing for us — a rejection carries a code and a
 * message and no retry hint — so the classification lives here, keyed on the
 * codes `EntryValidator` can emit. Every one of these is a statement about the
 * content of the entry, which does not change by being resent.
 */
const PERMANENT_ENTRY_CODES = new Set([
  'invalid_entry',
  'unknown_field',
  'invalid_id',
  'invalid_category',
  'unsupported_category',
  'invalid_kind',
  'invalid_timestamp',
  'invalid_session_id',
  'invalid_session_label',
  'invalid_system',
  'invalid_body',
  'invalid_data',
  'data_too_large',
  'data_too_deep',
  'invalid_data_key',
  'raw_journal_not_allowed',
  'invalid_data_value',
]);

/**
 * Whether a rejected entry is worth sending again.
 *
 * `duplicate_in_batch` is the one that is: it means this client put the same id
 * in one request twice, which is a batching mistake rather than a problem with
 * the entry. Sent on its own it will be accepted.
 */
export function isPermanentRejection(code: string | undefined): boolean {
  if (code === undefined) return false;
  if (code === 'duplicate_in_batch') return false;
  return PERMANENT_ENTRY_CODES.has(code);
}

/** Whether a per-entry result means the server now holds this entry. */
export function isAcknowledged(result: EntryResult): boolean {
  return result.status === 'created' || result.status === 'updated' || result.status === 'unchanged';
}

/**
 * Turn an HTTP status and body into a failure a commander can act on.
 *
 * Deliberately never surfaces the server's own message for a 5xx: the extension
 * defines no error shape for those, so whatever arrives is MediaWiki's and may
 * be an HTML page.
 */
export function classifyFailure(status: number, body: unknown, retryAfter?: number): Failure {
  const code = isRecord(body) && isRecord(body['error']) ? str(body['error']['code']) : null;

  if (status === 401) {
    return {
      kind: 'invalid-credential',
      message: 'The journal sync token is no longer valid. Reconnect with a new token.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limited',
      message: 'EDFM asked for fewer requests. Syncing will resume shortly.',
      retryable: true,
      retryAfterSeconds: retryAfter ?? 60,
    };
  }
  if (status === 409 && code === 'journal_profile_missing') {
    return {
      kind: 'profile-missing',
      message: 'Your EDFM journal profile is unavailable. Generating a token on the website creates it.',
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      kind: 'server-unavailable',
      message: 'EDFM is not responding. Your entries are kept and will sync later.',
      retryable: true,
    };
  }
  if (status === 413) {
    return {
      kind: 'rejected-request',
      message: 'The batch was larger than EDFM accepts. It will be split and retried.',
      retryable: true,
    };
  }
  if (status >= 400) {
    // A 4xx the server generated about the request itself. Resending the same
    // bytes gets the same answer.
    return {
      kind: 'rejected-request',
      message: 'EDFM rejected the request. The entries are kept and will not be retried.',
      retryable: false,
    };
  }

  return {
    kind: 'malformed-response',
    message: 'EDFM replied with something this app could not read. Nothing was marked as synced.',
    retryable: true,
  };
}

/* ------------------------------------------------- applying an outcome */

/** What a sync attempt means for the queue rows that were sent. */
export interface AppliedOutcome {
  /** Server holds these. Remove them from the queue. */
  readonly acknowledged: readonly string[];
  /** Will never be accepted. Mark rejected, with the reason. */
  readonly permanent: readonly { readonly id: string; readonly reason: string }[];
  /** Worth sending again. */
  readonly retryable: readonly string[];
  /** Sent but absent from the response; treated as unsent. */
  readonly unanswered: readonly string[];
}

/**
 * Decide what a batch response means for each entry that was sent.
 *
 * The rule the spec sets: an entry is synchronised because the server
 * acknowledged **that entry**, not because the request returned 2xx. So this
 * starts from the ids that were sent and matches results back to them, rather
 * than trusting the summary counts.
 *
 * An id the server did not mention is `unanswered` and stays queued. That is the
 * conservative direction: re-sending something the server already holds returns
 * `unchanged`, which costs nothing, while dropping something it never received
 * loses the record permanently.
 */
export function applyBatchOutcome(
  sentIds: readonly string[],
  outcome: BatchOutcome,
): AppliedOutcome {
  const acknowledged: string[] = [];
  const permanent: { id: string; reason: string }[] = [];
  const retryable: string[] = [];
  const seen = new Set<string>();

  for (const result of outcome.results) {
    // Prefer the id the server echoed; fall back to position when the
    // validator could not recover one from a malformed entry.
    const id = result.id ?? sentIds[result.index] ?? null;
    if (id === null) continue;
    seen.add(id);

    if (isAcknowledged(result)) {
      acknowledged.push(id);
    } else if (isPermanentRejection(result.code)) {
      permanent.push({ id, reason: result.code ?? 'rejected' });
    } else {
      retryable.push(id);
    }
  }

  return {
    acknowledged,
    permanent,
    retryable,
    unanswered: sentIds.filter((id) => !seen.has(id)),
  };
}
