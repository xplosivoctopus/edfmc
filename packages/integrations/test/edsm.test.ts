/**
 * EDSM journal submission.
 *
 * The contract was established from the live API — the docs page is behind bot
 * protection — so these tests pin what was actually observed rather than what a
 * reading of the documentation suggested.
 */

import { describe, expect, it } from 'vitest';

import {
  EDSM_CREDENTIAL_CODES,
  EDSM_JOURNAL_URL,
  EDSM_OK,
  augmentForEdsm,
  buildEdsmSubmission,
  isDiscardedByEdsm,
  parseEdsmDiscard,
  parseEdsmResponse,
} from '../src/edsm.js';

describe('the status is in the body, not the HTTP code', () => {
  it('treats a 200 carrying a failure as a failure', () => {
    /*
     * The finding this module is built around. EDSM answers HTTP 200 even when
     * nothing was accepted:
     *   {"msgnum":201,"msg":"Missing commander name","events":[]}
     * Classifying on the status code would mark every failure as a success and
     * silently discard the commander's log.
     */
    const outcome = parseEdsmResponse({ msgnum: 201, msg: 'Missing commander name', events: [] });
    expect(outcome.kind).toBe('credential');
  });

  it('recognises every credential failure observed from the live API', () => {
    for (const [code, label] of [
      [201, 'Missing commander name'],
      [202, 'Missing API key'],
      [203, 'Commander name/API Key not found'],
    ] as const) {
      const outcome = parseEdsmResponse({ msgnum: code, msg: label, events: [] });
      expect(outcome.kind, label).toBe('credential');
      if (outcome.kind === 'credential') expect(outcome.code).toBe(code);
      expect(EDSM_CREDENTIAL_CODES.has(code)).toBe(true);
    }
  });

  it('accepts only the success code', () => {
    const ok = parseEdsmResponse({ msgnum: EDSM_OK, msg: 'OK', events: [] });
    expect(ok.kind).toBe('accepted');
    expect(EDSM_OK).toBe(100);
  });

  it('retries an unrecognised status rather than discarding the entry', () => {
    /*
     * The known-permanent cases are enumerated. Treating an unknown code as
     * fatal would throw away a log entry over a message this client has simply
     * never seen before.
     */
    const outcome = parseEdsmResponse({ msgnum: 500, msg: 'Something new', events: [] });
    expect(outcome.kind).toBe('retry');
  });
});

describe('per-entry results', () => {
  it('reads each entry outcome separately', () => {
    const outcome = parseEdsmResponse({
      msgnum: 100,
      msg: 'OK',
      events: [
        { msgnum: 100, msg: 'OK' },
        { msgnum: 102, msg: 'Message older than the last one' },
      ],
    });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.perEvent[0]?.accepted).toBe(true);
    expect(outcome.perEvent[1]?.accepted).toBe(false);
    expect(outcome.perEvent[1]?.msgnum).toBe(102);
  });

  it('never marks anything accepted on a reply it cannot read', () => {
    // Same rule as the EDFM sync: acknowledgement comes from the server saying
    // so, not from the absence of an error.
    expect(parseEdsmResponse(null).kind).toBe('malformed');
    expect(parseEdsmResponse('ok').kind).toBe('malformed');
    expect(parseEdsmResponse({ msg: 'no number' }).kind).toBe('malformed');
    expect(parseEdsmResponse({ msgnum: 100, msg: 'OK' }).kind).toBe('malformed');
  });
});

describe('the discard list', () => {
  it('parses the live endpoint reply', () => {
    // A bare JSON array of event names; 141 of them when this was written.
    const set = parseEdsmDiscard(['Market', 'Shipyard', 'Status']);
    expect(set.size).toBe(3);
    expect(isDiscardedByEdsm('Market', set)).toBe(true);
    expect(isDiscardedByEdsm('FSDJump', set)).toBe(false);
  });

  it('filters nothing when the list could not be fetched', () => {
    /*
     * An empty set means the fetch failed. Guessing that an event is unwanted
     * would lose it, so nothing is filtered on that basis.
     */
    const empty = parseEdsmDiscard(null);
    expect(empty.size).toBe(0);
    expect(isDiscardedByEdsm('Market', empty)).toBe(false);
  });
});

describe('augmenting an entry', () => {
  const context = {
    systemName: 'Nervi',
    systemAddress: 1234,
    systemCoordinates: [1, 2, 3] as const,
    stationName: 'Jameson Memorial',
    marketId: 99,
    shipId: 7,
  };

  it('sends the event as the game wrote it, with context alongside', () => {
    /*
     * EDSM forwards journal entries. Rewriting the game's own fields would be
     * this client inventing history, so the raw event is preserved and the
     * underscore-prefixed context is added next to it.
     */
    const out = augmentForEdsm({ event: 'Docked', timestamp: '2026-10-02T12:00:00Z' }, context);
    expect(out['event']).toBe('Docked');
    expect(out['timestamp']).toBe('2026-10-02T12:00:00Z');
    expect(out['_systemName']).toBe('Nervi');
    expect(out['_systemAddress']).toBe(1234);
    expect(out['_systemCoordinates']).toEqual([1, 2, 3]);
  });

  it('omits what the game never said', () => {
    // "Not reported" and "empty" are different claims.
    const out = augmentForEdsm(
      { event: 'FSDJump' },
      { ...context, stationName: null, marketId: null, shipId: null },
    );
    expect('_stationName' in out).toBe(false);
    expect('_marketId' in out).toBe(false);
    expect('_shipId' in out).toBe(false);
  });
});

describe('the submission body', () => {
  const base = {
    commanderName: 'Sythan',
    apiKey: 'k'.repeat(40),
    softwareName: 'EDFM Companion',
    softwareVersion: '0.1.0',
    gameVersion: '4.4.0.3',
    gameBuild: 'r000/r0 ',
    entries: [{ event: 'FSDJump' }, { event: 'Docked' }],
  };

  it('is form encoded, with the entries as a JSON array', () => {
    const body = buildEdsmSubmission(base);
    const form = new URLSearchParams(body);
    expect(form.get('commanderName')).toBe('Sythan');
    expect(form.get('fromSoftware')).toBe('EDFM Companion');
    expect(JSON.parse(form.get('message')!)).toHaveLength(2);
  });

  it('reports the game version, so live and legacy data are not mixed', () => {
    const form = new URLSearchParams(buildEdsmSubmission(base));
    expect(form.get('fromGameVersion')).toBe('4.4.0.3');
    expect(form.get('fromGameBuild')).toBe('r000/r0 ');
  });

  it('omits the game version rather than faking one', () => {
    const form = new URLSearchParams(
      buildEdsmSubmission({ ...base, gameVersion: null, gameBuild: null }),
    );
    expect(form.has('fromGameVersion')).toBe(false);
    expect(form.has('fromGameBuild')).toBe(false);
  });

  it('posts to the verified endpoint over https', () => {
    expect(EDSM_JOURNAL_URL).toBe('https://www.edsm.net/api-journal-v1');
  });
});
