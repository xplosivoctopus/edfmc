/**
 * Tests for the data-sharing audit.
 *
 * The thing under test is honesty, so most of these assert what the screen must
 * *not* say: no "sent" without a send, no credential in an error message, no
 * universal promise that only holds for some services.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_QUEUE,
  INTEGRATIONS,
  UNIVERSAL_NEVER_SHARES,
  integrationsList,
  sharingAudit,
  sharingRow,
  universalNeverShares,
  type QueueSummary,
  type SharingInput,
} from '../src/index.js';

const base: SharingInput = {
  enabled: false,
  hasCredential: false,
  queue: EMPTY_QUEUE,
  lastSuccessAt: null,
  lastError: null,
};

const queue = (over: Partial<QueueSummary>): QueueSummary => ({ ...EMPTY_QUEUE, ...over });

/** A descriptor that is built, so gate logic can be tested independently. */
const built = { ...INTEGRATIONS.eddn, implemented: true };

describe('transmission state', () => {
  it('reports an unbuilt integration as sending nothing, whatever its switches say', () => {
    const row = sharingRow(INTEGRATIONS.edsm, {
      ...base,
      enabled: true,
      hasCredential: true,
    });
    expect(row.transmission).toBe('not-built');
    expect(row.everSent).toBe(false);
    expect(row.summary).toContain('Nothing has been sent');
  });

  it('separates "nothing to send" from "cannot send"', () => {
    // The distinction that matters: an idle built integration and an unfinished
    // one both have empty queues, and collapsing them would hide unbuilt work
    // behind a reassuring state.
    const neverSent = sharingRow(built, { ...base, enabled: true });
    expect(neverSent.transmission).toBe('never-sent');
    expect(sharingRow(INTEGRATIONS.edsm, { ...base, enabled: true }).transmission).toBe(
      'not-built',
    );
  });

  it('counts pending work rather than describing it vaguely', () => {
    const row = sharingRow(built, {
      ...base,
      enabled: true,
      queue: queue({ queued: 3, attempting: 1 }),
    });
    expect(row.transmission).toBe('pending');
    expect(row.summary).toBe('4 items waiting to be sent.');
  });

  it('says "item" for one and "items" for more', () => {
    const one = sharingRow(built, { ...base, enabled: true, queue: queue({ queued: 1 }) });
    expect(one.summary).toBe('1 item waiting to be sent.');
  });

  it('treats a stored error as failing even when the queue has drained', () => {
    const row = sharingRow(built, { ...base, enabled: true, lastError: 'HTTP 503' });
    expect(row.transmission).toBe('failing');
    expect(row.summary).toBe('The last attempt failed.');
  });

  it('reports idle only once something has actually been accepted', () => {
    const row = sharingRow(built, {
      ...base,
      enabled: true,
      lastSuccessAt: '2026-09-29T10:00:00Z',
    });
    expect(row.transmission).toBe('idle');
    expect(row.everSent).toBe(true);
  });

  it('distinguishes a missing credential from a failure', () => {
    const needsKey = { ...INTEGRATIONS.edsm, implemented: true };
    const row = sharingRow(needsKey, { ...base, enabled: true });
    expect(row.transmission).toBe('needs-credential');
    expect(row.summary).toContain('API key');
  });
});

describe('queue controls', () => {
  it('offers retry only when a retry could actually be attempted', () => {
    // Retryable items exist, but the integration is unbuilt: a retry button here
    // would do nothing and imply otherwise.
    expect(
      sharingRow(INTEGRATIONS.edsm, {
        ...base,
        enabled: true,
        hasCredential: true,
        queue: queue({ retryable: 2 }),
      }).canRetryNow,
    ).toBe(false);

    expect(
      sharingRow(built, { ...base, enabled: true, queue: queue({ retryable: 2 }) }).canRetryNow,
    ).toBe(true);
  });

  it('does not offer retry while switched off', () => {
    expect(
      sharingRow(built, { ...base, enabled: false, queue: queue({ retryable: 2 }) }).canRetryNow,
    ).toBe(false);
  });

  it('offers clearing rejected items only when there are some', () => {
    expect(sharingRow(built, base).canClearRejected).toBe(false);
    expect(sharingRow(built, { ...base, queue: queue({ rejected: 1 }) }).canClearRejected).toBe(
      true,
    );
  });
});

describe('errors reaching the screen', () => {
  it('sanitises a stored error again before display', () => {
    /*
     * Defence in depth. The queue sanitises on write; this sanitises on read,
     * because the audit screen is the last point before a string becomes a
     * screenshot, and a leaked credential cannot be recalled.
     */
    const row = sharingRow(built, {
      ...base,
      enabled: true,
      lastError: 'POST https://example.test/api?apiKey=SECRET123 failed',
    });
    expect(row.lastError).not.toContain('SECRET123');
    expect(row.lastError).not.toContain('apiKey=');
  });

  it('leaves a clean error readable', () => {
    const row = sharingRow(built, { ...base, enabled: true, lastError: 'HTTP 429 rate limited' });
    expect(row.lastError).toContain('429');
  });
});

describe('the whole audit', () => {
  it('states plainly that nothing has ever been sent, when nothing has', () => {
    const audit = sharingAudit({
      descriptors: integrationsList(),
      state: {},
      commanderName: 'Sythan',
      commanderFid: 'F123',
    });
    expect(audit.nothingEverSent).toBe(true);
    expect(audit.totalPending).toBe(0);
    expect(audit.rows).toHaveLength(4);
  });

  it('stops claiming that as soon as one service has sent something', () => {
    const audit = sharingAudit({
      descriptors: integrationsList(),
      state: { eddn: { ...base, enabled: true, lastSuccessAt: '2026-09-29T10:00:00Z' } },
      commanderName: 'Sythan',
      commanderFid: 'F123',
    });
    expect(audit.nothingEverSent).toBe(false);
  });

  it('surfaces items whose owner could not be established', () => {
    // These are never sent. Reporting them as simply "not queued" would be true
    // and misleading; they exist on disk and the commander should know.
    const audit = sharingAudit({
      descriptors: integrationsList(),
      state: { eddn: { ...base, queue: queue({ unattributed: 5 }) } },
      commanderName: null,
      commanderFid: null,
    });
    expect(audit.totalUnattributed).toBe(5);
  });

  it('defaults every integration to off when there is no stored state', () => {
    const audit = sharingAudit({
      descriptors: integrationsList(),
      state: {},
      commanderName: null,
      commanderFid: null,
    });
    for (const row of audit.rows) {
      expect(row.enabled, row.id).toBe(false);
      expect(row.everSent, row.id).toBe(false);
    }
  });
});

describe('the universal promise', () => {
  it('is backed by every manifest, not asserted beside them', () => {
    const universal = universalNeverShares(integrationsList());
    expect(universal.length).toBeGreaterThan(0);
    for (const guarantee of UNIVERSAL_NEVER_SHARES) {
      expect(universal, guarantee).toContain(guarantee);
    }
  });

  it('covers the things the commander was promised stay local', () => {
    const universal = universalNeverShares(integrationsList()).join(' | ');
    expect(universal).toMatch(/Activity Journal/);
    expect(universal).toMatch(/notes/);
    expect(universal).toMatch(/switched off/);
  });

  it('would be empty if one service dropped a guarantee', () => {
    // Proves the intersection is doing work rather than returning the first
    // list. This is what previously made the documented claim unfounded.
    const weakened = integrationsList().map((d, i) =>
      i === 2
        ? { ...d, privacy: { ...d.privacy, neverShares: ['Chat, friends, wings or squadrons'] } }
        : d,
    );
    expect(universalNeverShares(weakened)).toEqual(['Chat, friends, wings or squadrons']);
  });
});
