/**
 * EDFM Commander Journal: turning Activity Journal entries into what the
 * deployed server accepts, and reading what it says back.
 *
 * ## Written against the real contract, not a guess
 *
 * Every rule here is transcribed from the deployed `EDFMJournal 1.0.0`
 * extension — `EntryValidator`, `BatchHandler`, `StatusHandler`, `TokenService`
 * — rather than inferred from the endpoint's behaviour. Where the server is
 * strict, this is strict in the same place, because the alternative is a batch
 * rejected whole for a field nobody meant to send.
 *
 * ## What measurement showed before any of this was written
 *
 * The local Activity Journal already satisfies the validator. Across 546 real
 * entries rebuilt from the corpus:
 *
 * | Check | Result |
 * |---|---|
 * | `id` matches the server's identifier pattern | 546 of 546, longest 40 of 128 |
 * | `category` in the allowlist | 546 of 546 |
 * | `kind` is a valid slug | 546 of 546 |
 * | `occurredAt` matches the timestamp pattern | 546 of 546 |
 * | `data` within 16,384 canonical bytes | largest 1,110 |
 * | forbidden raw-journal keys present | **none** |
 *
 * So the local entry id is used **directly** as the server's stable client id.
 * The spec allowed deriving one if the formats disagreed; they do not, and a
 * derived id would have been a second identity to keep consistent for no gain.
 *
 * ## Two places the spec and the deployed server disagree
 *
 * Both resolved in favour of the server, which is what actually runs:
 *
 * 1. The spec asks for `clientVersion` and `dataVersion` fields. **They do not
 *    exist in the deployed schema.** Sending either is an unknown field and
 *    rejects the *whole batch* with `400`. The real field is top-level
 *    `companionVersion`.
 * 2. The spec describes per-entry retryable/permanent classification. The
 *    server sends no such flag — only a `code`. Classification therefore lives
 *    here, keyed on the documented codes.
 */

import type { ActivityEntry } from '@edfm/activity';

/** The one schema version the deployed server accepts. Integer, never a string. */
export const EDFM_JOURNAL_SCHEMA_VERSION = 1;

export const EDFM_JOURNAL_BASE = 'https://edfieldmanual.com';
export const EDFM_JOURNAL_STATUS_PATH = '/rest.php/edfm-journal/v1/status';
export const EDFM_JOURNAL_BATCH_PATH = '/rest.php/edfm-journal/v1/batch';

/**
 * Limits as the deployed configuration reports them.
 *
 * Defaults only. `/status` returns the live values and the caller should prefer
 * those: a server that lowers a limit should not start rejecting batches this
 * client keeps building to an outdated number.
 */
export const EDFM_JOURNAL_LIMITS = {
  maxBatchEntries: 100,
  maxRequestBytes: 262_144,
  maxEntryDataBytes: 16_384,
  maxIdChars: 128,
  maxSystemChars: 160,
  maxBodyChars: 192,
  maxSessionLabelChars: 128,
  maxCompanionVersionChars: 64,
  /** Structured data: depth, key count, key length, string length. */
  maxDataDepth: 4,
  maxDataKeys: 64,
  maxDataKeyChars: 64,
  maxDataStringChars: 1024,
} as const;

/** Categories the deployed allowlist contains. */
export const EDFM_JOURNAL_CATEGORIES = [
  'exobiology',
  'exploration',
  'mining',
  'colonisation',
] as const;

/** `^edfmj_v1_<22>.<43>$`, from `TokenCodec`. */
const TOKEN_PATTERN = /^edfmj_v1_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/**
 * Whether a pasted string could be a journal sync token.
 *
 * Checked before anything is stored so an obvious paste accident — a password,
 * a URL, a truncated copy — is caught locally instead of becoming a `401` the
 * commander has to interpret. It proves the *shape* only; whether the token is
 * real, unrevoked and in scope is the server's answer.
 */
export function looksLikeJournalToken(token: string): boolean {
  return TOKEN_PATTERN.test(token.trim());
}

/* ------------------------------------------------------------ identifiers */

/** `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`, from `EntryValidator::identifier`. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
/** `^[a-z][a-z0-9-]*$`, from `EntryValidator::slug`. */
const SLUG = /^[a-z][a-z0-9-]*$/;
/** `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`. UTC only; no offsets. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** `2014-01-01T00:00:00Z`; the server rejects anything earlier. */
const MIN_OCCURRED_UNIX = 1_388_534_400;
/** The server also rejects anything more than a day ahead of its own clock. */
const MAX_FUTURE_SECONDS = 86_400;

/**
 * Keys the server refuses, after stripping non-alphanumerics and lowercasing.
 *
 * This is the server enforcing the same boundary this app already keeps: raw
 * Frontier journal material never leaves the machine. Checked here too so a bad
 * key is dropped locally rather than rejecting an entry that was otherwise
 * fine.
 */
const RAW_KEYS = new Set([
  'event',
  'events',
  'fulljournal',
  'journalblob',
  'journalline',
  'raw',
  'rawjournal',
  'rawjournalline',
]);

function normaliseKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/* ------------------------------------------------------------ the payload */

/** One entry, in exactly the shape `EntryValidator` accepts. */
export interface EdfmJournalEntry {
  readonly id: string;
  readonly category: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly sessionId?: string | null;
  readonly sessionLabel?: string | null;
  readonly system?: string | null;
  readonly body?: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EdfmJournalBatch {
  readonly schemaVersion: number;
  readonly companionVersion: string;
  readonly entries: readonly EdfmJournalEntry[];
}

/** Why an entry was not sent. Local, before the request is built. */
export interface SkippedEntry {
  readonly id: string;
  readonly reason: string;
}

export interface BuildResult {
  readonly batch: EdfmJournalBatch | null;
  /** Entries this client refused to send, with the reason. */
  readonly skipped: readonly SkippedEntry[];
}

/**
 * Trim structured data to what the server will accept.
 *
 * Returns null when the value cannot be made acceptable. Dropping a key is
 * better than losing the entry: the activity is the point, and one oversized
 * field is not worth refusing the record of what the commander did.
 */
function sanitiseData(
  value: unknown,
  depth: number,
  budget: { keys: number },
): unknown {
  if (depth > EDFM_JOURNAL_LIMITS.maxDataDepth) return undefined;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const clean = sanitiseData(item, depth + 1, budget);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.length < 1 || key.length > EDFM_JOURNAL_LIMITS.maxDataKeyChars) continue;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(key)) continue;
      // The raw-journal boundary, enforced before the server has to.
      if (RAW_KEYS.has(normaliseKey(key))) continue;
      if (budget.keys >= EDFM_JOURNAL_LIMITS.maxDataKeys) break;
      budget.keys += 1;
      const clean = sanitiseData(child, depth + 1, budget);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }

  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    if (/\u0000/.test(value)) return undefined;
    return value.length > EDFM_JOURNAL_LIMITS.maxDataStringChars
      ? value.slice(0, EDFM_JOURNAL_LIMITS.maxDataStringChars)
      : value;
  }

  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;

  // undefined, functions, symbols, bigint: nothing the server models.
  return undefined;
}

/** Trim an optional string to the server's limit, or drop it if it is empty. */
function optional(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  const clean = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
  if (clean.length === 0) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

/**
 * Turn one Activity Journal entry into a server entry, or explain why not.
 *
 * `title` and `detail` travel inside `data`. They are derived Activity Journal
 * content — the human-readable half of the entry — and the server stores `data`
 * free-form, so sending them is what lets the website render the activity as
 * something a person reads rather than a category and a slug.
 */
export function toJournalEntry(
  entry: ActivityEntry,
  now: Date,
): { entry: EdfmJournalEntry } | { skip: string } {
  if (!IDENTIFIER.test(entry.id)) return { skip: 'the local id is not a valid stable id' };
  if (!EDFM_JOURNAL_CATEGORIES.includes(entry.category as (typeof EDFM_JOURNAL_CATEGORIES)[number])) {
    return { skip: `the category ${entry.category} is not enabled on the server` };
  }
  if (!SLUG.test(entry.subtype) || entry.subtype.length < 2 || entry.subtype.length > 64) {
    return { skip: 'the activity kind is not a valid slug' };
  }
  if (!TIMESTAMP.test(entry.occurredAt)) return { skip: 'the timestamp is not UTC RFC 3339' };

  const unix = Math.floor(Date.parse(entry.occurredAt) / 1000);
  if (!Number.isFinite(unix)) return { skip: 'the timestamp is not a real instant' };
  if (unix < MIN_OCCURRED_UNIX) return { skip: 'the timestamp predates the accepted range' };
  if (unix > Math.floor(now.getTime() / 1000) + MAX_FUTURE_SECONDS) {
    return { skip: 'the timestamp is too far in the future' };
  }

  const budget = { keys: 0 };
  const data = sanitiseData(
    {
      ...entry.data,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    },
    0,
    budget,
  ) as Record<string, unknown>;

  // `data` must be an object. An entry whose data sanitised away still has a
  // category, a kind and a time, which is a real record of activity.
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  return {
    entry: {
      id: entry.id,
      category: entry.category,
      kind: entry.subtype,
      occurredAt: entry.occurredAt,
      system: optional(entry.systemName, EDFM_JOURNAL_LIMITS.maxSystemChars),
      body: optional(entry.bodyName, EDFM_JOURNAL_LIMITS.maxBodyChars),
      data: payload,
    },
  };
}

/**
 * Build one batch.
 *
 * Bounded by **three** of the server's limits at once: the entry count, the
 * encoded request size, and each entry's canonical data size. A batch that
 * exceeds any of them is rejected whole, so entries are added only while they
 * all still hold.
 */
export function buildBatch(
  entries: readonly ActivityEntry[],
  companionVersion: string,
  options: {
    readonly now?: Date;
    readonly maxEntries?: number;
    readonly maxRequestBytes?: number;
    readonly maxEntryDataBytes?: number;
  } = {},
): BuildResult {
  const now = options.now ?? new Date();
  const maxEntries = options.maxEntries ?? EDFM_JOURNAL_LIMITS.maxBatchEntries;
  const maxBytes = options.maxRequestBytes ?? EDFM_JOURNAL_LIMITS.maxRequestBytes;
  const maxDataBytes = options.maxEntryDataBytes ?? EDFM_JOURNAL_LIMITS.maxEntryDataBytes;

  const version = companionVersion.slice(0, EDFM_JOURNAL_LIMITS.maxCompanionVersionChars);
  const skipped: SkippedEntry[] = [];
  const accepted: EdfmJournalEntry[] = [];

  for (const entry of entries) {
    if (accepted.length >= maxEntries) break;

    const result = toJournalEntry(entry, now);
    if ('skip' in result) {
      skipped.push({ id: entry.id, reason: result.skip });
      continue;
    }

    // Canonical size is measured the way the server measures it: the data
    // object alone, with object keys sorted.
    const dataBytes = byteLength(canonicalJson(result.entry.data));
    if (dataBytes > maxDataBytes) {
      skipped.push({ id: entry.id, reason: 'the structured data is larger than the server accepts' });
      continue;
    }

    const next = [...accepted, result.entry];
    if (byteLength(JSON.stringify(envelope(version, next))) > maxBytes) {
      // Full. The rest wait for the next batch rather than being dropped.
      break;
    }
    accepted.push(result.entry);
  }

  if (accepted.length === 0) return { batch: null, skipped };
  return { batch: envelope(version, accepted), skipped };
}

function envelope(companionVersion: string, entries: readonly EdfmJournalEntry[]): EdfmJournalBatch {
  // Exactly these three keys. Any other top-level key rejects the whole batch
  // with `400 unknown_field`.
  return {
    schemaVersion: EDFM_JOURNAL_SCHEMA_VERSION,
    companionVersion,
    entries,
  };
}

/** UTF-8 byte length, which is what the server's `strlen` counts. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * JSON with object keys sorted, matching the server's canonicalisation.
 *
 * The server sorts keys before measuring and before digesting, so measuring any
 * other way would let an entry through that the server then rejects for size.
 * List order is preserved, as it is there.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/* -------------------------------------------------- the Phase 1 boundary */

/**
 * Whether an entry falls inside what Phase 1 synchronises.
 *
 * **New activity only.** Connecting an account must not silently upload a
 * commander's entire back catalogue: that is a decision with its own weight —
 * how much, how far back, what it costs them in time and in what becomes
 * visible — and §9 reserves it for an explicit Phase 2 action.
 *
 * The boundary is a watermark recorded when sync was switched on. An entry
 * counts when it happened at or after that moment.
 *
 * Comparing `occurredAt` rather than when the row was written is deliberate: the
 * reader resumes from a byte offset, so a file read after connecting can still
 * contain activity from before it, and the commander's question is "did this
 * happen while sync was on", not "when did the app get round to recording it".
 *
 * An unparseable watermark admits nothing. Failing closed keeps the history
 * unsent, which is recoverable; failing open uploads it, which is not.
 */
export function isWithinPhaseOne(occurredAt: string, watermark: string | null): boolean {
  if (watermark === null) return false;
  const at = Date.parse(occurredAt);
  const from = Date.parse(watermark);
  if (!Number.isFinite(at) || !Number.isFinite(from)) return false;
  return at >= from;
}
