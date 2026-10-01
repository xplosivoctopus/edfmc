/**
 * EDDN sanitisation.
 *
 * EDDN is public and permanent. A forbidden field that slips through is not a
 * bug that can be fixed later — it is a published fact about a person. So these
 * tests are written as adversarially as the schema allows: every forbidden key,
 * nested inside arrays, and the privacy manifest checked against the code rather
 * than the other way round.
 *
 * No network. The spec also requires the `/test` schema form whenever
 * EDDN-handling code is exercised, which is asserted here too.
 */

import { describe, expect, it } from 'vitest';

import {
  EDDN_FORBIDDEN_KEYS,
  EDDN_JOURNAL_EVENTS,
  EDDN_UPLOAD_URL,
  INTEGRATIONS,
  auditEddnMessage,
  buildEddnJournalMessage,
  integrationStatus,
  mayTransmit,
  sanitiseForEddn,
  type EddnAugmentation,
  type EddnIdentity,
} from '../src/index.js';

const IDENTITY: EddnIdentity = {
  uploaderID: 'Sythan',
  softwareName: 'EDFM Companion',
  softwareVersion: '0.1.0',
  gameversion: '4.4.0.3',
  gamebuild: 'r330683/r0 ',
};

const AUGMENT: EddnAugmentation = {
  starSystem: 'Wregoe KO-G c24-10',
  starPos: [-41.06, -62.15, -103.25],
  systemAddress: 2833504080594,
};

/** A Docked event shaped like the real thing, carrying things EDDN forbids. */
function docked(): Record<string, unknown> {
  return {
    timestamp: '2026-09-29T12:00:00Z',
    event: 'Docked',
    StationName: 'Ray Gateway',
    StationType: 'Coriolis',
    StarSystem: 'Wregoe KO-G c24-10',
    SystemAddress: 2833504080594,
    MarketID: 3223343616,
    StationGovernment: '$government_Democracy;',
    StationGovernment_Localised: 'Democracy',
    ActiveFine: true,
    Wanted: true,
    CockpitBreach: false,
    StationFaction: { Name: 'EXO', FactionState: 'Expansion' },
    Factions: [
      {
        Name: 'EXO',
        Influence: 0.4,
        MyReputation: 100,
        HappiestSystem: true,
        HomeSystem: false,
        SquadronFaction: true,
        FactionState: 'Expansion',
      },
    ],
  };
}

describe('sanitisation', () => {
  it('removes every key the schema forbids', () => {
    const clean = sanitiseForEddn(docked()) as Record<string, unknown>;
    for (const key of ['ActiveFine', 'Wanted', 'CockpitBreach']) {
      expect(clean[key], key).toBeUndefined();
    }
  });

  it('removes forbidden keys nested inside arrays', () => {
    // The one most likely to be missed: Factions is an array of objects with its
    // own forbidden fields, so a top-level sweep would publish MyReputation for
    // every faction in the system.
    const clean = sanitiseForEddn(docked()) as Record<string, unknown>;
    const factions = clean['Factions'] as Array<Record<string, unknown>>;
    expect(factions).toHaveLength(1);
    for (const key of ['MyReputation', 'HappiestSystem', 'HomeSystem', 'SquadronFaction']) {
      expect(factions[0]![key], key).toBeUndefined();
    }
    // And keeps what EDDN is actually for.
    expect(factions[0]!['Name']).toBe('EXO');
    expect(factions[0]!['Influence']).toBe(0.4);
  });

  it('removes every _Localised key', () => {
    const clean = sanitiseForEddn(docked()) as Record<string, unknown>;
    expect(clean['StationGovernment_Localised']).toBeUndefined();
    expect(clean['StationGovernment']).toBe('$government_Democracy;');
  });

  it('strips planetary coordinates, which say where a person was standing', () => {
    const clean = sanitiseForEddn({
      timestamp: 't',
      event: 'Location',
      Latitude: -14.2,
      Longitude: 83.1,
      Body: 'X 1 a',
    }) as Record<string, unknown>;
    expect(clean['Latitude']).toBeUndefined();
    expect(clean['Longitude']).toBeUndefined();
    expect(clean['Body']).toBe('X 1 a');
  });

  it('leaves values that are not objects alone', () => {
    expect(sanitiseForEddn('x')).toBe('x');
    expect(sanitiseForEddn(7)).toBe(7);
    expect(sanitiseForEddn(null)).toBeNull();
  });
});

describe('message building', () => {
  it('builds nothing for an event outside the schema enum', () => {
    // Deny by default. Most journal events are simply not EDDN's business.
    for (const event of ['ReceiveText', 'Friends', 'LoadGame', 'ScanOrganic', 'Music']) {
      expect(buildEddnJournalMessage(event, { timestamp: 't', event }, IDENTITY, AUGMENT), event).toBeNull();
    }
  });

  it('builds for every event the schema names', () => {
    for (const event of EDDN_JOURNAL_EVENTS) {
      const msg = buildEddnJournalMessage(event, { timestamp: 't', event }, IDENTITY, AUGMENT, {
        test: true,
      });
      expect(msg, event).not.toBeNull();
    }
  });

  it('supplies the position the schema requires but the event lacks', () => {
    // Scan carries no StarPos, and the schema requires one.
    const msg = buildEddnJournalMessage(
      'Scan',
      { timestamp: 't', event: 'Scan', BodyName: 'X 1', StarSystem: 'X', SystemAddress: 1 },
      IDENTITY,
      AUGMENT,
      { test: true },
    );
    expect(msg!.message['StarPos']).toEqual(AUGMENT.starPos);
  });

  it('sends the mandatory header fields, including game build', () => {
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    expect(msg.header).toEqual({
      uploaderID: 'Sythan',
      softwareName: 'EDFM Companion',
      softwareVersion: '0.1.0',
      gameversion: '4.4.0.3',
      gamebuild: 'r330683/r0 ',
    });
  });

  it('omits the odyssey flag entirely when the game did not say', () => {
    // The spec is emphatic: "No, not with a false value. DO NOT INCLUDE IT."
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    expect('odyssey' in msg.message).toBe(false);
    expect('horizons' in msg.message).toBe(false);

    const withFlags = buildEddnJournalMessage(
      'Docked',
      docked(),
      IDENTITY,
      { ...AUGMENT, odyssey: true, horizons: false },
      { test: true },
    )!;
    expect(withFlags.message['odyssey']).toBe(true);
    expect(withFlags.message['horizons']).toBe(false);
  });

  it('uses the test schema form when testing, as the spec requires', () => {
    const test = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    expect(test.$schemaRef).toBe('https://eddn.edcd.io/schemas/journal/1/test');

    const live = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT)!;
    expect(live.$schemaRef).toBe('https://eddn.edcd.io/schemas/journal/1');
  });

  it('uses the documented endpoint, with its required trailing slash', () => {
    expect(EDDN_UPLOAD_URL).toBe('https://eddn.edcd.io:4430/upload/');
    expect(EDDN_UPLOAD_URL.endsWith('/')).toBe(true);
    expect(EDDN_UPLOAD_URL.startsWith('https://')).toBe(true);
  });
});

describe('the audit before anything leaves the machine', () => {
  it('passes a properly built message', () => {
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    expect(auditEddnMessage(msg)).toEqual([]);
  });

  it('catches a forbidden key that bypassed the sanitiser', () => {
    // Belt and braces, and worth the duplication: this is the last check before
    // something becomes a permanent public record.
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    const tampered = {
      ...msg,
      message: { ...msg.message, Wanted: true, Factions: [{ Name: 'x', MyReputation: 5 }] },
    };
    const problems = auditEddnMessage(tampered);
    expect(problems).toContain('Wanted');
    expect(problems.some((p) => p.includes('MyReputation'))).toBe(true);
  });

  it('catches a missing mandatory header field', () => {
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    const tampered = { ...msg, header: { ...msg.header, gamebuild: '' } };
    expect(auditEddnMessage(tampered)).toContain('header.gamebuild is missing');
  });

  it('never reports a problem for a key EDDN actually wants', () => {
    const msg = buildEddnJournalMessage('Docked', docked(), IDENTITY, AUGMENT, { test: true })!;
    const problems = auditEddnMessage(msg);
    expect(problems.join(' ')).not.toContain('StationName');
    expect(problems.join(' ')).not.toContain('Influence');
  });
});

describe('the privacy manifest is a claim the code must honour', () => {
  it('lists every forbidden key category it promises not to share', () => {
    // The manifest says planetary position and reputation are never shared. If
    // someone removed those from the forbidden list, this fails.
    for (const key of ['Latitude', 'Longitude', 'MyReputation', 'Wanted']) {
      expect(EDDN_FORBIDDEN_KEYS, key).toContain(key);
    }
  });

  it('promises not to share chat or friends, and cannot: they are not sendable events', () => {
    for (const event of ['ReceiveText', 'Friends', 'WingAdd', 'SquadronStartup']) {
      expect(EDDN_JOURNAL_EVENTS).not.toContain(event);
    }
  });
});

describe('off means off', () => {
  it('refuses transmission while disabled', () => {
    // Tested on a built descriptor, because `implemented: false` would satisfy
    // this assertion for the wrong reason and keep passing if the switch itself
    // broke.
    const built = { ...INTEGRATIONS.eddn, implemented: true };
    expect(mayTransmit(built, { enabled: false, hasCredential: true })).toBe(false);
    expect(integrationStatus(built, { enabled: false, hasCredential: true })).toBe('disabled');
  });

  it('permits transmission without a credential when none is required', () => {
    const built = { ...INTEGRATIONS.eddn, implemented: true };
    expect(built.privacy.requiresCredential).toBe(false);
    expect(mayTransmit(built, { enabled: true, hasCredential: false })).toBe(true);
  });

  it('permits transmission for EDDN once it is switched on', () => {
    /*
     * This replaces a tripwire that asserted EDDN was unbuilt. It was there to
     * fail the moment the submission loop was connected, so that marking it
     * built could not happen quietly -- which is exactly what it did.
     *
     * EDDN needs no credential: it is anonymous community sharing, so being
     * enabled is the whole gate.
     */
    expect(INTEGRATIONS.eddn.implemented).toBe(true);
    expect(INTEGRATIONS.eddn.privacy.requiresCredential).toBe(false);
    expect(mayTransmit(INTEGRATIONS.eddn, { enabled: true, hasCredential: false })).toBe(true);
    expect(mayTransmit(INTEGRATIONS.eddn, { enabled: false, hasCredential: false })).toBe(false);
  });

  it('refuses an integration that is not built, however it is configured', () => {
    /*
     * The important one: a switch that appears to work while nothing is sent is
     * worse than one that says so.
     *
     * The subject is synthetic rather than whichever integration is currently
     * unfinished, because all four are now built -- and when this test named
     * one of them, finishing it removed the only coverage of this rule.
     */
    const unbuilt = { ...INTEGRATIONS.eddn, implemented: false, pendingReason: 'Not built yet.' };
    expect(mayTransmit(unbuilt, { enabled: true, hasCredential: true })).toBe(false);
    expect(integrationStatus(unbuilt, { enabled: true, hasCredential: true })).toBe(
      'not-implemented',
    );
  });

  it('has a reason on record for every integration still unbuilt', () => {
    // So an unfinished one can never present as merely idle. Vacuous today,
    // by design: it starts enforcing again the moment one is added.
    for (const service of Object.values(INTEGRATIONS)) {
      if (service.implemented) continue;
      expect(service.pendingReason, service.id).toBeTruthy();
    }
  });

  it('distinguishes "needs your API key" from "broken"', () => {
    const needsKey = { ...INTEGRATIONS.edsm, implemented: true };
    expect(integrationStatus(needsKey, { enabled: true, hasCredential: false })).toBe(
      'needs-configuration',
    );
    expect(mayTransmit(needsKey, { enabled: true, hasCredential: false })).toBe(false);
    expect(integrationStatus(needsKey, { enabled: true, hasCredential: true })).toBe('ready');
  });

  it('gives every integration both halves of a privacy manifest', () => {
    for (const d of Object.values(INTEGRATIONS)) {
      expect(d.privacy.summary.length, d.id).toBeGreaterThan(0);
      expect(d.privacy.neverShares.length, d.id).toBeGreaterThan(0);
      if (d.privacy.requiresCredential) expect(d.privacy.credentialHelp, d.id).toBeTruthy();
    }
  });

  it('never sends the Activity Journal to a community database', () => {
    /*
     * EDDN, EDSM and Inara receive observations about the galaxy. A
     * commander's record of what they did is not an observation about the
     * galaxy and is not theirs to publish, so it goes to none of them.
     *
     * Scoped to the community four rather than to every integration, because
     * the first-party EDFM sync exists precisely to send that record to the
     * commander's own account. Asserting the old blanket rule while one
     * integration did the opposite would be a privacy claim that was not true.
     */
    for (const id of ['inara'] as const) {
      const d = INTEGRATIONS[id];
      const shares = d.privacy.shares.join(' ').toLowerCase();
      expect(shares, id).not.toContain('note');
      expect(shares, id).not.toContain('activity journal');
      expect(d.privacy.neverShares.join(' '), id).toContain('Activity Journal');
    }
  });

  it('holds the first-party sync to a stricter bargain instead', () => {
    /*
     * It may carry the Activity Journal -- that is its purpose -- so the
     * guarantees that replace the blanket one have to be real: the commander
     * must have chosen it, it must need a credential they created, and it must
     * still refuse the things that are nobody's business.
     */
    const d = INTEGRATIONS['edfm-journal'];

    expect(d.privacy.requiresCredential).toBe(true);
    expect(mayTransmit(d, { enabled: false, hasCredential: true })).toBe(false);
    expect(mayTransmit({ ...d, implemented: true }, { enabled: true, hasCredential: false })).toBe(
      false,
    );

    const never = d.privacy.neverShares.join(' ');
    // Raw game files never leave, whoever the recipient is.
    expect(never).toMatch(/[Rr]aw Frontier/);
    expect(never).toMatch(/password/i);
    expect(never).toMatch(/[Ss]creenshot/);
    // Notes and saved items stay local even here.
    expect(never).toMatch(/notes/i);

    // And it does not contradict itself: it cannot both send and withhold the
    // same thing.
    const shares = d.privacy.shares.join(' ').toLowerCase();
    expect(shares).toContain('activity journal');
    expect(never.toLowerCase()).not.toContain('your activity journal, notes or saved items');
  });
});
