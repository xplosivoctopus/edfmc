import { describe, expect, it } from 'vitest';

import {
  INARA_ERROR,
  INARA_KEY_PAGE,
  INARA_OK,
  INARA_SET_LOCATION,
  INARA_SOFT_ERROR,
  INARA_URL,
  INARA_WARNING,
  buildInaraBatch,
  isInaraAccepted,
  parseInaraResponse,
  toInaraLocation,
  type InaraLocation,
} from '../src/inara.js';

const AT: InaraLocation = {
  systemName: 'Wregoe KO-G c24-10',
  systemCoords: [12.5, -40.25, 88.0],
  stationName: null,
  marketId: null,
  bodyName: 'Wregoe KO-G c24-10 A 5',
  occurredAt: '2026-09-28T12:03:20Z',
};

describe('the location event', () => {
  it('sends the one event Inara documents for this', () => {
    const e = toInaraLocation(AT)!;
    expect(e.eventName).toBe(INARA_SET_LOCATION);
    expect(e.eventName).toBe('setCommanderTravelLocation');
    expect(e.eventTimestamp).toBe('2026-09-28T12:03:20Z');
  });

  it('spells the fields the way Inara spells them', () => {
    /*
     * Pinned because the casing is irregular and easy to "correct" into
     * something Inara silently ignores: lowercase `system`, uppercase `ID`.
     * Both Inara's documentation and EDMarketConnector's client agree on these.
     */
    const e = toInaraLocation({ ...AT, stationName: 'Jameson Memorial', marketId: 128_666_762 })!;
    expect(Object.keys(e.eventData).sort()).toEqual([
      'marketID',
      'starsystemBodyName',
      'starsystemCoords',
      'starsystemName',
      'stationName',
    ]);
    expect(e.eventData['starsystemName']).toBe('Wregoe KO-G c24-10');
    expect(e.eventData['starsystemCoords']).toEqual([12.5, -40.25, 88.0]);
  });

  it('omits what is not known rather than sending a placeholder', () => {
    const e = toInaraLocation({
      systemName: 'Sol',
      systemCoords: null,
      stationName: null,
      marketId: null,
      bodyName: null,
      occurredAt: AT.occurredAt,
    })!;
    expect(Object.keys(e.eventData)).toEqual(['starsystemName']);
  });

  it('declines without a system name', () => {
    // Inara documents it as required, and empty names are a known way to
    // corrupt a profile.
    expect(toInaraLocation({ ...AT, systemName: null })).toBeNull();
    expect(toInaraLocation({ ...AT, systemName: '   ' })).toBeNull();
  });

  it('never sends a position on a planet surface', () => {
    /*
     * The privacy guarantee, pinned. Inara accepts `starsystemBodyCoords`, so
     * nothing but this test stops it being added later. "Where you are standing
     * on a planet" is in the universal never-shares list.
     */
    const e = toInaraLocation({ ...AT, bodyName: 'Wregoe KO-G c24-10 A 5' })!;
    expect(e.eventData).not.toHaveProperty('starsystemBodyCoords');
    expect(JSON.stringify(e).toLowerCase()).not.toContain('latitude');
    expect(JSON.stringify(e).toLowerCase()).not.toContain('longitude');
  });
});

describe('the envelope', () => {
  it('carries the header fields Inara names', () => {
    const b = buildInaraBatch({
      apiKey: 'not-a-real-key',
      commanderName: 'Jameson',
      commanderFrontierID: 'F8240321',
      appName: 'EDFM Companion',
      appVersion: '1.2.3',
      isBeingDeveloped: false,
      events: [toInaraLocation(AT)!],
    });
    expect(Object.keys(b.header).sort()).toEqual([
      'APIkey',
      'appName',
      'appVersion',
      'commanderFrontierID',
      'commanderName',
      'isBeingDeveloped',
    ]);
  });

  it('omits the Frontier id rather than guessing one', () => {
    const b = buildInaraBatch({
      apiKey: 'k',
      commanderName: 'Jameson',
      commanderFrontierID: null,
      appName: 'a',
      appVersion: 'v',
      isBeingDeveloped: false,
      events: [],
    });
    expect(b.header).not.toHaveProperty('commanderFrontierID');
  });
});

describe('reading a reply', () => {
  it('treats 200, 202 and 204 as handled', () => {
    expect(isInaraAccepted(INARA_OK)).toBe(true);
    expect(isInaraAccepted(INARA_WARNING)).toBe(true);
    expect(isInaraAccepted(INARA_SOFT_ERROR)).toBe(true);
    expect(isInaraAccepted(INARA_ERROR)).toBe(false);
  });

  it('stops rather than retrying when the key is rejected', () => {
    // Retrying a dead key cannot succeed and only hammers the server.
    const out = parseInaraResponse({
      header: { eventStatus: 400, eventStatusText: 'Invalid API key' },
    });
    expect(out.kind).toBe('credential');
  });

  it('reports each event separately', () => {
    const out = parseInaraResponse({
      header: { eventStatus: 200 },
      events: [{ eventStatus: 200 }, { eventStatus: 400, eventStatusText: 'Unknown system' }],
    });
    if (out.kind !== 'accepted') throw new Error(`expected accepted, got ${out.kind}`);
    expect(out.perEvent.map((e) => e.accepted)).toEqual([true, false]);
    expect(out.perEvent[1]!.text).toBe('Unknown system');
  });

  it('never reads success out of a reply it cannot parse', () => {
    for (const body of [null, 'ok', 42, [], {}, { header: {} }, { header: { eventStatus: 200 } }]) {
      expect(parseInaraResponse(body).kind).not.toBe('accepted');
    }
  });
});

describe('where it talks to', () => {
  it('uses Inara over https, and the real key page', () => {
    expect(INARA_URL).toBe('https://inara.cz/inapi/v1/');
    // The page a commander is sent to. An invented path would be a dead end.
    expect(INARA_KEY_PAGE).toBe('https://inara.cz/elite/cmdr-settings-api/');
  });
});
