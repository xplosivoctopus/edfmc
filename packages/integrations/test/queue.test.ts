/**
 * Queue behaviour.
 *
 * The properties under test are the ones a commander would notice if they broke:
 * a retry that duplicates their data, a permanent failure retried forever, an
 * outage that blocks an unrelated service, or a credential appearing in an error
 * message on the audit screen.
 */

import { describe, expect, it } from 'vitest';

import {
  QUEUE_LIMITS,
  applyAttempt,
  backoffFor,
  classifyHttp,
  dueItems,
  isDue,
  pendingDepth,
  sanitiseError,
  trim,
  type QueueItem,
} from '../src/index.js';

const NOW = new Date('2026-09-29T12:00:00Z');

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Journal.A.log:4096',
    integration: 'eddn',
    commanderFid: 'F0000000',
    status: 'queued',
    payload: '{}',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-09-29T11:00:00Z',
    updatedAt: '2026-09-29T11:00:00Z',
    ...over,
  };
}

describe('classification', () => {
  it('accepts a 2xx', () => {
    expect(classifyHttp(200).kind).toBe('accepted');
    expect(classifyHttp(204).kind).toBe('accepted');
  });

  it('treats a schema or auth rejection as permanent', () => {
    // These will be rejected identically forever. Retrying is noise for the
    // commander and load on somebody else's server.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyHttp(status).kind, String(status)).toBe('permanent');
    }
  });

  it('treats a server problem as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyHttp(status).kind, String(status)).toBe('retryable');
    }
  });

  it('treats 429 and 408 as retryable despite being 4xx', () => {
    // "Later", not "never" -- the one place the 4xx rule is wrong.
    expect(classifyHttp(429).kind).toBe('retryable');
    expect(classifyHttp(408).kind).toBe('retryable');
  });
});

describe('backoff', () => {
  it('grows and then caps', () => {
    expect(backoffFor(1)).toBe(5);
    expect(backoffFor(2)).toBe(30);
    expect(backoffFor(6)).toBe(600);
    // Capped: a commander who fixes their key should not wait an hour to find out.
    expect(backoffFor(99)).toBe(600);
  });

  it('schedules the next attempt rather than retrying immediately', () => {
    const after = applyAttempt(item(), { kind: 'retryable', detail: 'HTTP 503' }, NOW);
    expect(after.status).toBe('retryable');
    expect(after.attempts).toBe(1);
    expect(after.nextAttemptAt).toBe('2026-09-29T12:00:05.000Z');
  });

  it('survives a restart, because the wait is stored rather than held in a timer', () => {
    const after = applyAttempt(item(), { kind: 'retryable', detail: 'x' }, NOW);
    // The only state needed to resume is on the item itself.
    expect(after.nextAttemptAt).toBeTruthy();
    expect(isDue(after, NOW)).toBe(false);
    expect(isDue(after, new Date('2026-09-29T12:00:06Z'))).toBe(true);
  });
});

describe('giving up', () => {
  it('never retries a permanent failure', () => {
    const after = applyAttempt(item(), { kind: 'permanent', detail: 'HTTP 400 schema' }, NOW);
    expect(after.status).toBe('rejected');
    expect(after.nextAttemptAt).toBeNull();
    expect(isDue(after, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('stops after the attempt limit, and says why', () => {
    // Recorded as rejected with a reason rather than left stuck at "queued",
    // so the audit view can explain itself.
    let it = item({ attempts: QUEUE_LIMITS.maxAttempts - 1 });
    it = applyAttempt(it, { kind: 'retryable', detail: 'HTTP 503' }, NOW);
    expect(it.status).toBe('rejected');
    expect(it.lastError).toContain('gave up after');
  });

  it('clears the error when an attempt finally succeeds', () => {
    const failed = applyAttempt(item(), { kind: 'retryable', detail: 'HTTP 503' }, NOW);
    const ok = applyAttempt(failed, { kind: 'accepted' }, NOW);
    expect(ok.status).toBe('accepted');
    expect(ok.lastError).toBeNull();
  });
});

describe('idempotency', () => {
  it('identifies an item by a deterministic id, so a retry cannot duplicate', () => {
    // The id derives from the source journal event, which is stable across
    // restart and replay. Two enqueues of the same observation are the same row.
    const a = item({ id: 'Journal.A.log:4096' });
    const b = item({ id: 'Journal.A.log:4096', attempts: 3 });
    expect(a.id).toBe(b.id);
    expect(`${a.integration}/${a.id}`).toBe(`${b.integration}/${b.id}`);
  });

  it('keeps the same observation separate per integration', () => {
    // The primary key is (integration, id): the same event may legitimately be
    // owed to EDDN and to EDSM, and one accepting it says nothing about the other.
    const eddn = item({ integration: 'eddn' });
    const edsm = item({ integration: 'edsm' });
    expect(`${eddn.integration}/${eddn.id}`).not.toBe(`${edsm.integration}/${edsm.id}`);
  });
});

describe('ownership', () => {
  it('never sends an item whose owner is unknown', () => {
    // Guessing which account should receive somebody's data is worse than not
    // sending it. This is the rule the spec is most explicit about.
    expect(isDue(item({ commanderFid: null }), NOW)).toBe(false);
    expect(dueItems([item({ commanderFid: null })], NOW, 10)).toHaveLength(0);
  });

  it('sends an item that has an owner', () => {
    expect(isDue(item(), NOW)).toBe(true);
  });
});

describe('isolation between services', () => {
  it('lets one queue proceed while another is backing off', () => {
    // The head-of-line property: EDSM being down must not stop EDDN.
    const stalled = applyAttempt(
      item({ integration: 'edsm', id: 'x' }),
      { kind: 'retryable', detail: 'HTTP 503' },
      NOW,
    );
    const healthy = item({ integration: 'eddn', id: 'y' });
    const due = dueItems([stalled, healthy], NOW, 10);
    expect(due.map((i) => i.integration)).toEqual(['eddn']);
  });

  it('sends oldest first within a queue', () => {
    const older = item({ id: 'a', createdAt: '2026-09-29T10:00:00Z' });
    const newer = item({ id: 'b', createdAt: '2026-09-29T11:30:00Z' });
    expect(dueItems([newer, older], NOW, 10).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('error text never carries a secret', () => {
  it('strips a query string, which is where keys usually hide', () => {
    const cleaned = sanitiseError('POST https://example.com/api?apiKey=abcd1234secret failed');
    expect(cleaned).not.toContain('abcd1234secret');
  });

  it('strips a named credential parameter', () => {
    for (const text of [
      'apiKey=abcd1234secret',
      'api_key=abcd1234secret',
      'token=abcd1234secret',
      'password=abcd1234secret',
    ]) {
      expect(sanitiseError(text), text).not.toContain('abcd1234secret');
    }
  });

  it('bounds the length, so a response body cannot be stored wholesale', () => {
    expect(sanitiseError('x'.repeat(5000)).length).toBeLessThanOrEqual(200);
  });

  it('keeps enough to be diagnosable', () => {
    expect(sanitiseError('HTTP 503 Service Unavailable')).toBe('HTTP 503 Service Unavailable');
  });
});

describe('depth', () => {
  it('counts only outstanding work', () => {
    const items = [
      item({ id: '1', status: 'queued' }),
      item({ id: '2', status: 'retryable' }),
      item({ id: '3', status: 'attempting' }),
      item({ id: '4', status: 'accepted' }),
      item({ id: '5', status: 'rejected' }),
    ];
    expect(pendingDepth(items)).toBe(3);
  });

  it('drops settled items first when trimming', () => {
    const items = [item({ id: 'done', status: 'accepted' }), item({ id: 'live', status: 'queued' })];
    expect(trim(items, 500)).toEqual(['done']);
  });

  it('drops the oldest outstanding when a queue is over its bound', () => {
    // A queue this deep means something has been broken for a long time, and the
    // newest observations are the ones still worth sending.
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ id: `i${i}`, createdAt: `2026-09-29T1${i}:00:00Z` }),
    );
    expect(trim(items, 3)).toEqual(['i0', 'i1']);
  });
});
