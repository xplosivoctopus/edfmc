/**
 * EDFM Commander Journal: contract compliance.
 *
 * Every rule asserted here is transcribed from the deployed `EDFMJournal 1.0.0`
 * extension. The tests are mostly about *refusal* — the batch is rejected whole
 * for one stray top-level key, and an entry is lost for one bad field, so the
 * places this must be strict are the places it is cheapest to get wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  EDFM_JOURNAL_CATEGORIES,
  EDFM_JOURNAL_LIMITS,
  EDFM_JOURNAL_SCHEMA_VERSION,
  buildBatch,
  byteLength,
  canonicalJson,
  isWithinPhaseOne,
  looksLikeJournalToken,
  toJournalEntry,
} from '../src/edfm-journal.js';
import {
  applyBatchOutcome,
  classifyFailure,
  isAcknowledged,
  isPermanentRejection,
  parseBatchOutcome,
  parseMediaWikiTimestamp,
  parseStatus,
} from '../src/edfm-journal-response.js';
import type { ActivityEntry } from '@edfm/activity';

const NOW = new Date('2026-10-02T12:00:00Z');

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'Journal.2026-09-30T120000.01.log:12345',
    commanderFid: 'F123',
    occurredAt: '2026-09-30T14:22:18Z',
    category: 'exobiology',
    subtype: 'sample-completed',
    systemName: 'Wregoe UC-L c24-1',
    systemAddress: 1234,
    bodyName: 'Wregoe UC-L c24-1 A',
    bodyId: 12,
    locationName: null,
    title: 'Stratum Tectonicas — Emerald',
    detail: 'Biological sample completed',
    data: { genus: 'Stratum', species: 'Stratum Tectonicas', colour: 'Emerald' },
    sources: ['Journal.2026-09-30T120000.01.log:12345'],
    ...over,
  };
}

describe('the token shape', () => {
  it('accepts the documented form', () => {
    // `^edfmj_v1_<22>.<43>$`, from TokenCodec.
    const token = `edfmj_v1_${'A'.repeat(22)}.${'b'.repeat(43)}`;
    expect(looksLikeJournalToken(token)).toBe(true);
    expect(looksLikeJournalToken(`  ${token}  `)).toBe(true);
  });

  it('rejects the things people paste by mistake', () => {
    /*
     * Caught locally so an obvious slip is a clear message rather than a 401
     * the commander has to interpret.
     */
    expect(looksLikeJournalToken('')).toBe(false);
    expect(looksLikeJournalToken('my-edfm-password')).toBe(false);
    expect(looksLikeJournalToken('https://edfieldmanual.com/token')).toBe(false);
    // Right prefix, truncated secret.
    expect(looksLikeJournalToken(`edfmj_v1_${'A'.repeat(22)}.${'b'.repeat(20)}`)).toBe(false);
    // Wrong prefix.
    expect(looksLikeJournalToken(`edfmj_v2_${'A'.repeat(22)}.${'b'.repeat(43)}`)).toBe(false);
  });
});

describe('the batch envelope', () => {
  it('sends exactly the three keys the server accepts', () => {
    /*
     * The server rejects the WHOLE batch with `400 unknown_field` for any other
     * top-level key, so this is the single most expensive thing to get wrong.
     */
    const { batch } = buildBatch([entry()], '0.1.0', { now: NOW });
    expect(Object.keys(batch!).sort()).toEqual(['companionVersion', 'entries', 'schemaVersion']);
  });

  it('never sends clientVersion or dataVersion', () => {
    /*
     * The brief asked for both. Neither exists in the deployed schema, and
     * sending either rejects the whole batch. The real field is
     * `companionVersion`.
     */
    const { batch } = buildBatch([entry()], '0.1.0', { now: NOW });
    const json = JSON.stringify(batch);
    expect(json).not.toContain('clientVersion');
    expect(json).not.toContain('dataVersion');
    expect(batch!.companionVersion).toBe('0.1.0');
  });

  it('sends schemaVersion as an integer, not a string', () => {
    // `"1"` is rejected with `unsupported_schema`.
    const { batch } = buildBatch([entry()], '0.1.0', { now: NOW });
    expect(batch!.schemaVersion).toBe(EDFM_JOURNAL_SCHEMA_VERSION);
    expect(typeof batch!.schemaVersion).toBe('number');
  });

  it('bounds companionVersion to the server limit', () => {
    const { batch } = buildBatch([entry()], 'v'.repeat(200), { now: NOW });
    expect(batch!.companionVersion.length).toBe(EDFM_JOURNAL_LIMITS.maxCompanionVersionChars);
  });
});

describe('the entry shape', () => {
  it('sends only the keys the validator allows', () => {
    const result = toJournalEntry(entry(), NOW);
    expect('entry' in result).toBe(true);
    if (!('entry' in result)) return;
    for (const key of Object.keys(result.entry)) {
      expect(
        ['id', 'category', 'kind', 'occurredAt', 'sessionId', 'sessionLabel', 'system', 'body', 'data'],
        key,
      ).toContain(key);
    }
  });

  it('uses the local entry id directly as the stable client id', () => {
    /*
     * Measured across 546 real entries: every local id already matches the
     * server's identifier pattern, longest 40 of 128 allowed. A derived id
     * would have been a second identity to keep consistent for no gain.
     */
    const result = toJournalEntry(entry(), NOW);
    if (!('entry' in result)) throw new Error('entry was skipped');
    expect(result.entry.id).toBe('Journal.2026-09-30T120000.01.log:12345');
  });

  it('is idempotent: the same activity always produces the same id', () => {
    const a = toJournalEntry(entry(), NOW);
    const b = toJournalEntry(entry(), new Date('2026-10-02T18:00:00Z'));
    if (!('entry' in a) || !('entry' in b)) throw new Error('skipped');
    expect(a.entry.id).toBe(b.entry.id);
  });

  it('maps subtype to kind and keeps category as-is', () => {
    const result = toJournalEntry(entry(), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect(result.entry.kind).toBe('sample-completed');
    expect(result.entry.category).toBe('exobiology');
    expect(EDFM_JOURNAL_CATEGORIES).toContain(result.entry.category);
  });

  it('carries the human-readable half inside data, where the server allows it', () => {
    // The server stores `data` free-form; title and detail are what let the
    // website render an activity rather than a category and a slug.
    const result = toJournalEntry(entry(), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect(result.entry.data['title']).toBe('Stratum Tectonicas — Emerald');
    expect(result.entry.data['detail']).toBe('Biological sample completed');
  });
});

describe('what it refuses to send', () => {
  it('skips a category the server does not enable', () => {
    const result = toJournalEntry(entry({ category: 'combat' as ActivityEntry['category'] }), NOW);
    expect('skip' in result).toBe(true);
  });

  it('skips a malformed timestamp', () => {
    // Offsets are not accepted; UTC `Z` only.
    expect('skip' in toJournalEntry(entry({ occurredAt: '2026-09-30T14:22:18+01:00' }), NOW)).toBe(true);
    expect('skip' in toJournalEntry(entry({ occurredAt: '2026-09-30' }), NOW)).toBe(true);
  });

  it('skips a timestamp outside the accepted range', () => {
    // Before 2014-01-01, or more than a day ahead of the server clock.
    expect('skip' in toJournalEntry(entry({ occurredAt: '2001-01-01T00:00:00Z' }), NOW)).toBe(true);
    expect('skip' in toJournalEntry(entry({ occurredAt: '2027-01-01T00:00:00Z' }), NOW)).toBe(true);
  });

  it('accepts fractional seconds, which the server allows', () => {
    expect('entry' in toJournalEntry(entry({ occurredAt: '2026-09-30T14:22:18.123Z' }), NOW)).toBe(true);
  });

  it('skips an id the server would reject', () => {
    expect('skip' in toJournalEntry(entry({ id: ' leading-space' }), NOW)).toBe(true);
    expect('skip' in toJournalEntry(entry({ id: 'a'.repeat(200) }), NOW)).toBe(true);
    expect('skip' in toJournalEntry(entry({ id: 'has spaces' }), NOW)).toBe(true);
  });

  it('skips a kind that is not a lowercase slug', () => {
    expect('skip' in toJournalEntry(entry({ subtype: 'Sample-Completed' }), NOW)).toBe(true);
    expect('skip' in toJournalEntry(entry({ subtype: 'x' }), NOW)).toBe(true);
  });
});

describe('raw Frontier data never leaves', () => {
  it('drops a data key the server treats as raw journal material', () => {
    /*
     * The server refuses these outright. Dropping them locally means one bad
     * key costs a field rather than the whole entry -- and it keeps the
     * boundary this app already holds.
     */
    const result = toJournalEntry(
      entry({ data: { genus: 'Stratum', event: 'ScanOrganic', rawJournal: '{"x":1}' } }),
      NOW,
    );
    if (!('entry' in result)) throw new Error('skipped');
    expect(result.entry.data['event']).toBeUndefined();
    expect(result.entry.data['rawJournal']).toBeUndefined();
    expect(result.entry.data['genus']).toBe('Stratum');
  });

  it('catches the normalised spellings too', () => {
    // The server lowercases and strips non-alphanumerics before comparing.
    const result = toJournalEntry(
      entry({ data: { 'Raw_Journal_Line': 'x', 'full journal': 'y', ok: 1 } }),
      NOW,
    );
    if (!('entry' in result)) throw new Error('skipped');
    expect(Object.keys(result.entry.data)).toEqual(['ok', 'title', 'detail']);
  });
});

describe('structured data limits', () => {
  it('truncates an over-long string rather than losing the entry', () => {
    const result = toJournalEntry(entry({ data: { note: 'x'.repeat(5000) } }), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect((result.entry.data['note'] as string).length).toBe(
      EDFM_JOURNAL_LIMITS.maxDataStringChars,
    );
  });

  it('drops values nested deeper than the server accepts', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const result = toJournalEntry(entry({ data: deep }), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect(JSON.stringify(result.entry.data)).not.toContain('too deep');
  });

  it('bounds the number of keys', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) wide[`k${i}`] = i;
    const result = toJournalEntry(entry({ data: wide }), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect(Object.keys(result.entry.data).length).toBeLessThanOrEqual(
      EDFM_JOURNAL_LIMITS.maxDataKeys,
    );
  });

  it('drops a non-finite number, which the server rejects', () => {
    const result = toJournalEntry(entry({ data: { ratio: Number.POSITIVE_INFINITY, ok: 1 } }), NOW);
    if (!('entry' in result)) throw new Error('skipped');
    expect(result.entry.data['ratio']).toBeUndefined();
    expect(result.entry.data['ok']).toBe(1);
  });

  it('measures size the way the server does, with keys sorted', () => {
    // The server sorts keys before measuring, so measuring unsorted could let
    // through an entry it then rejects.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(byteLength('é')).toBe(2);
  });
});

describe('batching', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => entry({ id: `Journal.log:${i}` }));

  it('never exceeds the entry limit', () => {
    const { batch } = buildBatch(many(250), '0.1.0', { now: NOW });
    expect(batch!.entries.length).toBe(EDFM_JOURNAL_LIMITS.maxBatchEntries);
  });

  it('stops before the request size limit, leaving the rest for later', () => {
    const { batch } = buildBatch(many(100), '0.1.0', { now: NOW, maxRequestBytes: 2000 });
    expect(batch!.entries.length).toBeGreaterThan(0);
    expect(byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(2000);
    expect(batch!.entries.length).toBeLessThan(100);
  });

  it('reports what it skipped and why', () => {
    const { batch, skipped } = buildBatch(
      [entry(), entry({ id: 'bad id', occurredAt: '2026-09-30T14:22:18Z' })],
      '0.1.0',
      { now: NOW },
    );
    expect(batch!.entries.length).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/stable id/);
  });

  it('produces no batch when nothing is eligible', () => {
    const { batch, skipped } = buildBatch([entry({ id: 'bad id' })], '0.1.0', { now: NOW });
    expect(batch).toBeNull();
    expect(skipped).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ responses */

const statusBody = {
  apiVersion: 1,
  schemaVersion: 1,
  scope: 'journal:sync',
  journal: { visibility: 'private', entryCount: 7, lastSync: '20261002115959' },
  allowedCategories: ['exobiology', 'exploration', 'mining', 'colonisation'],
  limits: { maxBatchEntries: 100, maxRequestBytes: 262144, maxEntryDataBytes: 16384 },
  serverTime: '2026-10-02T12:00:00Z',
  requestId: 'a'.repeat(32),
};

describe('reading /status', () => {
  it('parses the documented response', () => {
    const status = parseStatus(statusBody);
    expect(status?.scope).toBe('journal:sync');
    expect(status?.entryCount).toBe(7);
    expect(status?.visibility).toBe('private');
    expect(status?.limits.maxBatchEntries).toBe(100);
  });

  it('reads lastSync as a MediaWiki timestamp, not ISO', () => {
    /*
     * `20261002115959` is not RFC 3339. Handing it to `Date.parse` yields an
     * invalid date, which would have shown as "Invalid Date" in the UI.
     */
    const status = parseStatus(statusBody);
    expect(Number.isNaN(Date.parse(status!.lastSync!))).toBe(true);
    const when = parseMediaWikiTimestamp(status!.lastSync);
    expect(when?.toISOString()).toBe('2026-10-02T11:59:59.000Z');
  });

  it('accepts a journal that has never synced', () => {
    const status = parseStatus({ ...statusBody, journal: { ...statusBody.journal, lastSync: null } });
    expect(status?.lastSync).toBeNull();
    expect(parseMediaWikiTimestamp(null)).toBeNull();
  });

  it('refuses anything that is not the documented shape', () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus('ok')).toBeNull();
    expect(parseStatus({})).toBeNull();
    expect(parseStatus({ ...statusBody, journal: 'private' })).toBeNull();
    expect(parseStatus({ ...statusBody, limits: {} })).toBeNull();
    // A plausible-looking body missing one required field.
    const { serverTime, ...missing } = statusBody;
    expect(parseStatus(missing)).toBeNull();
  });
});

describe('reading a batch response', () => {
  const ok = {
    apiVersion: 1,
    schemaVersion: 1,
    requestId: 'b'.repeat(32),
    summary: { created: 1, updated: 0, unchanged: 0, rejected: 0 },
    results: [{ index: 0, id: 'Journal.log:1', status: 'created' }],
  };

  it('parses a 200', () => {
    const outcome = parseBatchOutcome(ok);
    expect(outcome?.summary.created).toBe(1);
    expect(outcome?.results[0]?.status).toBe('created');
    expect(isAcknowledged(outcome!.results[0]!)).toBe(true);
  });

  it('parses a 207 with a mix, keeping every result', () => {
    const mixed = parseBatchOutcome({
      ...ok,
      summary: { created: 1, updated: 0, unchanged: 0, rejected: 1 },
      results: [
        { index: 0, id: 'Journal.log:1', status: 'created' },
        {
          index: 1,
          id: 'Journal.log:2',
          status: 'rejected',
          error: { code: 'invalid_timestamp', message: 'occurredAt must be an RFC 3339 UTC timestamp.' },
        },
      ],
    });
    expect(mixed?.results).toHaveLength(2);
    expect(isAcknowledged(mixed!.results[0]!)).toBe(true);
    expect(isAcknowledged(mixed!.results[1]!)).toBe(false);
    expect(mixed!.results[1]!.code).toBe('invalid_timestamp');
  });

  it('treats created, updated and unchanged as all acknowledged', () => {
    // `unchanged` is what an exact retry returns. It means the server holds it.
    for (const status of ['created', 'updated', 'unchanged'] as const) {
      expect(isAcknowledged({ index: 0, id: 'x', status })).toBe(true);
    }
  });

  it('accepts a rejection whose id the validator could not recover', () => {
    const outcome = parseBatchOutcome({
      ...ok,
      summary: { created: 0, updated: 0, unchanged: 0, rejected: 1 },
      results: [{ index: 0, id: null, status: 'rejected', error: { code: 'invalid_entry', message: 'x' } }],
    });
    expect(outcome?.results[0]?.id).toBeNull();
  });

  it('refuses a malformed response rather than assuming success', () => {
    /*
     * The rule that matters: an entry is synchronised because the server
     * acknowledged THAT ENTRY, never because the status code was 2xx. A body
     * this cannot read acknowledges nothing.
     */
    expect(parseBatchOutcome(null)).toBeNull();
    expect(parseBatchOutcome({ ...ok, results: 'none' })).toBeNull();
    expect(parseBatchOutcome({ ...ok, results: [{ index: 0 }] })).toBeNull();
    expect(parseBatchOutcome({ ...ok, results: [{ index: 0, id: 'x', status: 'teleported' }] })).toBeNull();
    expect(parseBatchOutcome({ ...ok, summary: { created: 1 } })).toBeNull();
  });
});

describe('what is worth retrying', () => {
  it('never retries a rejection about the entry content', () => {
    for (const code of [
      'invalid_id',
      'unsupported_category',
      'invalid_timestamp',
      'data_too_large',
      'raw_journal_not_allowed',
      'unknown_field',
    ]) {
      expect(isPermanentRejection(code), code).toBe(true);
    }
  });

  it('retries a duplicate within one batch, which is our batching mistake', () => {
    /*
     * `duplicate_in_batch` says this client put the same id in one request
     * twice. Sent on its own the entry is accepted, so it is not permanent.
     */
    expect(isPermanentRejection('duplicate_in_batch')).toBe(false);
  });

  it('does not treat an unknown code as permanent', () => {
    // A code from a future server version is not something to give up on.
    expect(isPermanentRejection('something_new')).toBe(false);
    expect(isPermanentRejection(undefined)).toBe(false);
  });
});

describe('classifying a failed request', () => {
  it('stops on an invalid token rather than hammering the server', () => {
    const f = classifyFailure(401, { error: { code: 'invalid_token', message: 'x' } });
    expect(f.kind).toBe('invalid-credential');
    expect(f.retryable).toBe(false);
  });

  it('honours the rate limit, with the delay the server asked for', () => {
    const f = classifyFailure(429, { error: { code: 'rate_limited', message: 'x' } }, 60);
    expect(f.kind).toBe('rate-limited');
    expect(f.retryable).toBe(true);
    expect(f.retryAfterSeconds).toBe(60);
  });

  it('retries a 5xx, and does not quote whatever it said', () => {
    /*
     * The extension defines no 5xx shape, so the body may be MediaWiki's HTML.
     * It is never surfaced.
     */
    const f = classifyFailure(503, '<html>Service Unavailable</html>');
    expect(f.kind).toBe('server-unavailable');
    expect(f.retryable).toBe(true);
    expect(f.message).not.toContain('html');
  });

  it('does not retry a request the server refused on its merits', () => {
    const f = classifyFailure(400, { error: { code: 'unknown_field', message: 'x' } });
    expect(f.retryable).toBe(false);
  });

  it('recognises a missing journal profile', () => {
    const f = classifyFailure(409, { error: { code: 'journal_profile_missing', message: 'x' } });
    expect(f.kind).toBe('profile-missing');
    expect(f.retryable).toBe(false);
  });

  it('never puts a raw server body in a message a commander sees', () => {
    const f = classifyFailure(500, { error: { code: 'x', message: 'Fatal: /var/www/edwiki/secret.php' } });
    expect(f.message).not.toContain('/var/www');
  });
});

describe('the Phase 1 boundary', () => {
  const watermark = '2026-10-02T12:00:00Z';

  it('syncs activity from after sync was switched on', () => {
    expect(isWithinPhaseOne('2026-10-02T12:00:01Z', watermark)).toBe(true);
    // The instant itself counts.
    expect(isWithinPhaseOne('2026-10-02T12:00:00Z', watermark)).toBe(true);
  });

  it('never sweeps up the existing history', () => {
    /*
     * The boundary this feature must not cross. Connecting an account is not
     * consent to upload a back catalogue -- that is its own decision, reserved
     * for an explicit Phase 2 action.
     */
    expect(isWithinPhaseOne('2026-10-02T11:59:59Z', watermark)).toBe(false);
    expect(isWithinPhaseOne('2026-01-01T00:00:00Z', watermark)).toBe(false);
  });

  it('admits nothing when there is no watermark', () => {
    // Not connected, or connected before a watermark was recorded.
    expect(isWithinPhaseOne('2026-10-02T12:00:01Z', null)).toBe(false);
  });

  it('fails closed on an unreadable watermark', () => {
    /*
     * Failing closed leaves history unsent, which is recoverable. Failing open
     * uploads it, which is not.
     */
    expect(isWithinPhaseOne('2026-10-02T12:00:01Z', 'not a date')).toBe(false);
    expect(isWithinPhaseOne('not a date', watermark)).toBe(false);
  });
});

describe('applying a batch outcome to the queue', () => {
  const outcome = (results: Array<Record<string, unknown>>, rejected = 0) =>
    parseBatchOutcome({
      apiVersion: 1,
      schemaVersion: 1,
      requestId: 'c'.repeat(32),
      summary: { created: 0, updated: 0, unchanged: 0, rejected },
      results,
    })!;

  it('removes entries the server acknowledged', () => {
    const applied = applyBatchOutcome(
      ['a', 'b', 'c'],
      outcome([
        { index: 0, id: 'a', status: 'created' },
        { index: 1, id: 'b', status: 'unchanged' },
        { index: 2, id: 'c', status: 'updated' },
      ]),
    );
    expect(applied.acknowledged).toEqual(['a', 'b', 'c']);
    expect(applied.retryable).toEqual([]);
    expect(applied.unanswered).toEqual([]);
  });

  it('separates permanent rejections from retryable ones', () => {
    const applied = applyBatchOutcome(
      ['good', 'bad', 'dup'],
      outcome(
        [
          { index: 0, id: 'good', status: 'created' },
          { index: 1, id: 'bad', status: 'rejected', error: { code: 'invalid_timestamp', message: 'x' } },
          { index: 2, id: 'dup', status: 'rejected', error: { code: 'duplicate_in_batch', message: 'x' } },
        ],
        2,
      ),
    );
    expect(applied.acknowledged).toEqual(['good']);
    expect(applied.permanent.map((p) => p.id)).toEqual(['bad']);
    // Our batching mistake, not a problem with the entry.
    expect(applied.retryable).toEqual(['dup']);
  });

  it('keeps an entry the server never mentioned', () => {
    /*
     * The conservative direction. Re-sending something already held returns
     * `unchanged` and costs nothing; dropping something never received loses
     * the record for good.
     */
    const applied = applyBatchOutcome(
      ['a', 'b'],
      outcome([{ index: 0, id: 'a', status: 'created' }]),
    );
    expect(applied.acknowledged).toEqual(['a']);
    expect(applied.unanswered).toEqual(['b']);
  });

  it('matches by position when the validator could not echo an id', () => {
    const applied = applyBatchOutcome(
      ['first', 'second'],
      outcome(
        [
          { index: 0, id: 'first', status: 'created' },
          { index: 1, id: null, status: 'rejected', error: { code: 'invalid_entry', message: 'x' } },
        ],
        1,
      ),
    );
    expect(applied.permanent.map((p) => p.id)).toEqual(['second']);
  });
});
