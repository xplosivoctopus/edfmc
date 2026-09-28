import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  applyEvent,
  initialState,
  isKnown,
  normalize,
  parseLine,
  type CommanderState,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  BUNDLED_RULES,
  ContextResolver,
  evaluate,
  pageUrl,
  resourceUrl,
  sanitise,
  type ContextRuleSet,
} from '../src/index.js';

let offset = 0;
const ctx = new JournalSessionContext();

function ev(line: string): NormalizedEvent {
  const r = parseLine(line, 'J.log', (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

/** Verbatim from the validation corpus. */
const PROSPECTED =
  '{ "timestamp":"2026-08-20T12:00:00Z", "event":"ProspectedAsteroid", "Materials":[ { "Name":"Painite", "Proportion":22.5 } ], "Content":"$AsteroidMaterialContent_High;", "Content_Localised":"Material Content: High", "Remaining":100.000000 }';

const DOCKED_ENGINEER =
  '{ "timestamp":"2026-09-01T13:46:58Z", "event":"Docked", "StationName":"Farseer Inc", "StationType":"Outpost", "Taxi":false, "Multicrew":false, "StarSystem":"Deciat", "SystemAddress":6681123623626, "MarketID":128000000, "StationFaction":{ "Name":"F" }, "StationGovernment":"$government_Cooperative;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "engineer", "missions", "refuel", "stationMenu" ], "StationEconomy":"$economy_Colony;", "StationEconomies":[], "DistFromStarLS":1.0, "LandingPads":{ "Small":1, "Medium":1, "Large":0 } }';

const SCAN_ORGANIC =
  '{ "timestamp":"2026-08-29T18:48:28Z", "event":"ScanOrganic", "ScanType":"Log", "Genus":"$Codex_Ent_Fonticulus_Genus_Name;", "Genus_Localised":"Fonticulua", "Species":"$Codex_Ent_Fonticulus_02_Name;", "Species_Localised":"Fonticulua Campestris", "WasLogged":false, "SystemAddress":9480469554737, "Body":24 }';

const MUSIC = '{ "timestamp":"2026-09-01T13:28:26Z", "event":"Music", "MusicTrack":"NoTrack" }';

/**
 * Verbatim service list from the commander's own Fleet Carrier.
 *
 * Note it contains `engineer` — which is exactly why that token cannot be used to
 * mean "at an Engineer".
 */
const DOCKED_FLEET_CARRIER =
  '{ "timestamp":"2026-09-01T20:00:00Z", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe JO-G c24-27", "SystemAddress":7506361389778, "MarketID":3703420416, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "crewlounge", "rearm", "refuel", "repair", "engineer", "flightcontroller", "stationoperations", "stationMenu", "carriermanagement", "carrierfuel", "socialspace", "exploration", "vistagenomics", "voucherredemption" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":1000.0, "LandingPads":{ "Small":4, "Medium":4, "Large":8 } }';

/** The periodic full-summary form — 277 of 338 in the corpus. Means nothing happened. */
const ENGINEER_PROGRESS_SUMMARY =
  '{ "timestamp":"2026-09-01T18:59:53Z", "event":"EngineerProgress", "Engineers":[ { "Engineer":"The Sarge", "EngineerID":300040, "Progress":"Invited" }, { "Engineer":"Professor Palin", "EngineerID":300220, "Progress":"Unlocked", "RankProgress":0, "Rank":5 } ] }';

/** The single-change form — a real progress change. */
const ENGINEER_PROGRESS_CHANGE =
  '{ "timestamp":"2026-08-10T12:00:00Z", "event":"EngineerProgress", "Engineer":"Felicity Farseer", "EngineerID":300100, "Progress":"Unlocked", "RankProgress":0, "Rank":1 }';

const ENGINEER_CRAFT =
  '{ "timestamp":"2026-08-15T10:00:00Z", "event":"EngineerCraft", "Slot":"PowerPlant", "Module":"int_powerplant_size6_class5", "Ingredients":[ { "Name":"iron", "Count":1 } ], "Engineer":"Felicity Farseer", "EngineerID":300100, "BlueprintID":128673738, "BlueprintName":"PowerPlant_Armoured", "Level":1, "Quality":0.412000 }';

/**
 * Verbatim Docked at Ray Gateway, which has both a material trader and a tech
 * broker. Note what StationServices does NOT say: which kind of trader it is.
 */
const DOCKED_TRADER_STATION =
  '{ "timestamp":"2026-06-20T22:48:43Z", "event":"Docked", "StationName":"Ray Gateway", "StationType":"Coriolis", "Taxi":false, "Multicrew":false, "StarSystem":"Diaguandri", "SystemAddress":670417429889, "MarketID":3223343616, "StationFaction":{ "Name":"EXO" }, "StationGovernment":"$government_Democracy;", "StationServices":[ "dock", "autodock", "blackmarket", "commodities", "contacts", "exploration", "missions", "outfitting", "crewlounge", "rearm", "refuel", "repair", "shipyard", "tuning", "engineer", "missionsgenerated", "flightcontroller", "stationoperations", "powerplay", "searchrescue", "materialtrader", "techBroker", "stationMenu", "shop" ], "StationEconomy":"$economy_HighTech;", "StationEconomies":[], "DistFromStarLS":20.0 }';

/** Verbatim MaterialTrade at that same MarketID. This is the only thing that names the kind. */
const MATERIAL_TRADE_ENCODED =
  '{ "timestamp":"2026-06-20T22:53:15Z", "event":"MaterialTrade", "MarketID":3223343616, "TraderType":"encoded", "Paid":{ "Material":"adaptiveencryptors", "Category":"Encoded", "Quantity":2 }, "Received":{ "Material":"disruptedwakeechoes", "Category":"Encoded", "Quantity":27 } }';

/** Verbatim ScanOrganic. Only ScanType "Analyse" completes a specimen. */
const SCAN_ANALYSE =
  '{ "timestamp":"2026-09-18T03:00:00Z", "event":"ScanOrganic", "ScanType":"Analyse", "Genus":"$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised":"Bacterium", "Species":"$Codex_Ent_Bacterial_05_Name;", "Species_Localised":"Bacterium Informem", "SystemAddress":1213084977515, "Body":12 }';

const SCAN_SAMPLE =
  '{ "timestamp":"2026-09-18T02:00:00Z", "event":"ScanOrganic", "ScanType":"Sample", "Genus":"$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised":"Bacterium", "Species":"$Codex_Ent_Bacterial_05_Name;", "Species_Localised":"Bacterium Informem", "SystemAddress":1213084977515, "Body":12 }';

/** Verbatim SellOrganicData. BioData length is the only quantity reported. */
const SELL_ORGANIC_ONE =
  '{ "timestamp":"2026-09-18T04:06:39Z", "event":"SellOrganicData", "MarketID":3703420416, "BioData":[ { "Genus":"$Codex_Ent_Bacterial_Genus_Name;", "Species":"$Codex_Ent_Bacterial_05_Name;", "Value":1000000, "Bonus":0 } ] }';

const DIED = '{ "timestamp":"2026-09-18T05:00:00Z", "event":"Died" }';

const UNDOCKED =
  '{ "timestamp":"2026-09-18T07:00:00Z", "event":"Undocked", "StationName":"Bering port", "StationType":"Coriolis", "MarketID":3223343616, "Taxi":false, "Multicrew":false }';

const FSD_JUMP =
  '{ "timestamp":"2026-09-18T07:05:00Z", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"Diaguandri", "SystemAddress":670417429889, "StarPos":[-41.06,-62.15,-103.25], "SystemAllegiance":"Independent", "JumpDist":8.523, "FuelUsed":0.62, "FuelLevel":31.2 }';

/** Verbatim DSS of a ring: signals are bare commodity names. */
const SAA_RING =
  '{ "timestamp":"2026-08-22T04:26:04Z", "event":"SAASignalsFound", "BodyName":"Wregoe KO-G c24-10 BCD 2 A Ring", "SystemAddress":2833504080594, "BodyID":32, "Signals":[ { "Type":"Serendibite", "Count":2 }, { "Type":"Painite", "Count":1 } ], "Genuses":[] }';

/** Verbatim DSS of a planet. Same event; nothing to do with rings. */
const SAA_PLANET =
  '{ "timestamp":"2026-07-11T02:01:37Z", "event":"SAASignalsFound", "BodyName":"HIP 12099 1 b", "SystemAddress":560216394075, "BodyID":16, "Signals":[ { "Type":"$SAA_SignalType_Other;", "Type_Localised":"Other", "Count":1 }, { "Type":"$SAA_SignalType_Geological;", "Type_Localised":"Geological", "Count":3 } ], "Genuses":[] }';

/** A planet with a surface mining site -- still not a ring. */
const SAA_PLANET_MINING =
  '{ "timestamp":"2026-07-11T03:00:00Z", "event":"SAASignalsFound", "BodyName":"Wregoe KO-G c24-7 16 a", "SystemAddress":2833504080594, "BodyID":21, "Signals":[ { "Type":"$PlanetaryMiningLocation_Name;", "Count":1 } ], "Genuses":[] }';

const INTERDICTED =
  '{ "timestamp":"2026-09-18T06:00:00Z", "event":"Interdicted", "Submitted":false, "Interdictor":"Cory Reynolds", "IsPlayer":false, "Faction":"Sirius Special Forces", "Power":"Li Yong-Rui" }';

function stateWith(line?: string): CommanderState {
  const s = initialState();
  if (line) applyEvent(s, ev(line));
  return s;
}

describe('wiki URLs', () => {
  it('builds canonical EDFM URLs from page titles', () => {
    expect(pageUrl('Mining')).toBe('https://edfieldmanual.com/wiki/Mining');
    expect(pageUrl('Core Mining')).toBe('https://edfieldmanual.com/wiki/Core_Mining');
    expect(pageUrl('How to Use a Refinery')).toBe(
      'https://edfieldmanual.com/wiki/How_to_Use_a_Refinery',
    );
  });

  it('keeps slashes and colons, which are meaningful in titles', () => {
    expect(pageUrl('CMDR Fima/Privacy Policy')).toBe(
      'https://edfieldmanual.com/wiki/CMDR_Fima/Privacy_Policy',
    );
  });

  it('encodes characters that would otherwise break the URL', () => {
    expect(pageUrl('Tod "The Blaster" McQuinn')).toContain('%22');
  });

  it('treats # as a section anchor, not part of the title', () => {
    // MediaWiki forbids # in titles, so this is unambiguous. Percent-encoding it
    // would produce a URL that lands on a nonexistent page instead of a heading.
    expect(pageUrl('Engineering Materials#Material Traders')).toBe(
      'https://edfieldmanual.com/wiki/Engineering_Materials#Material_Traders',
    );
  });

  it('drops an empty fragment rather than emitting a bare #', () => {
    expect(pageUrl('Mining#')).toBe('https://edfieldmanual.com/wiki/Mining');
    expect(pageUrl('Mining#  ')).toBe('https://edfieldmanual.com/wiki/Mining');
  });

  it('refuses non-http schemes from an untrusted rule set', () => {
    // A rule set arrives over the network; it must not be able to hand the shell a
    // file: or custom-scheme URL to open.
    expect(resourceUrl({ url: 'file:///C:/Windows/System32' })).toBeNull();
    expect(resourceUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(resourceUrl({ url: 'https://example.com/x' })).toBe('https://example.com/x');
  });
});

describe('condition evaluation', () => {
  it('matches on event name, including a list', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(evaluate({ kind: 'event', name: 'ProspectedAsteroid' }, input)).toBe(true);
    expect(evaluate({ kind: 'event', name: 'Docked' }, input)).toBe(false);
    expect(evaluate({ kind: 'event', name: ['Docked', 'ProspectedAsteroid'] }, input)).toBe(true);
  });

  it('reads dotted paths out of the raw payload', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(
      evaluate({ kind: 'field', path: 'Materials.0.Name', op: 'eq', value: 'Painite' }, input),
    ).toBe(true);
    expect(evaluate({ kind: 'field', path: 'Remaining', op: 'gt', value: 50 }, input)).toBe(true);
    expect(evaluate({ kind: 'field', path: 'Nope', op: 'exists' }, input)).toBe(false);
  });

  it('matches station services case-insensitively', () => {
    // The raw array genuinely mixes cases (stationMenu, techBroker).
    const input = { event: ev(MUSIC), state: stateWith(DOCKED_ENGINEER) };
    expect(evaluate({ kind: 'service', id: 'engineer' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'stationMenu' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'stationmenu' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'shipyard' }, input)).toBe(false);
  });

  it('treats an unknown service list as no match, not as an empty list', () => {
    const input = { event: ev(MUSIC), state: initialState() };
    expect(evaluate({ kind: 'service', id: 'engineer' }, input)).toBe(false);
  });

  it('combines with all/any/not', () => {
    const input = { event: ev(PROSPECTED), state: stateWith(DOCKED_ENGINEER) };
    expect(
      evaluate(
        { kind: 'all', of: [{ kind: 'event', name: 'ProspectedAsteroid' }, { kind: 'service', id: 'engineer' }] },
        input,
      ),
    ).toBe(true);
    expect(evaluate({ kind: 'not', of: { kind: 'event', name: 'Docked' } }, input)).toBe(true);
    expect(evaluate({ kind: 'all', of: [] }, input)).toBe(false); // vacuous truth is not useful here
  });

  it('refuses prototype-walking paths from an untrusted rule set', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(evaluate({ kind: 'field', path: '__proto__.polluted', op: 'exists' }, input)).toBe(false);
    expect(evaluate({ kind: 'field', path: 'constructor.name', op: 'exists' }, input)).toBe(false);
  });

  it('does not throw on an unrecognised condition kind from a newer server', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    const future = { kind: 'somethingNew', foo: 1 } as never;
    expect(evaluate(future, input)).toBe(false);
  });

  it('bounds recursion depth', () => {
    let nested = { kind: 'event', name: 'ProspectedAsteroid' } as never;
    for (let i = 0; i < 50; i += 1) nested = { kind: 'not', of: nested } as never;
    // Must return, not blow the stack.
    expect(typeof evaluate(nested, { event: ev(PROSPECTED), state: initialState() })).toBe('boolean');
  });
});

describe('ContextResolver', () => {
  function resolver(now: () => number) {
    return new ContextResolver(BUNDLED_RULES, { now, maxActive: 3 });
  }

  it('activates a context from a real prospecting event', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(true);

    const active = r.current();
    expect(active.map((a) => a.rule.id)).toContain('mining-prospecting');
    expect(active[0]!.triggerEvent).toBe('ProspectedAsteroid');
  });

  it('activates engineering from actual engineering activity', () => {
    const r = resolver(() => 1000);
    r.observe(ev(ENGINEER_CRAFT), initialState());
    expect(r.current().map((a) => a.rule.id)).toContain('engineering-activity');
  });

  it('ignores the periodic EngineerProgress summary', () => {
    // Regression. 277 of 338 EngineerProgress events in the corpus carry an
    // `Engineers` array: a full progress summary emitted at startup and
    // periodically through a session, regardless of what the commander is doing.
    // Keying on the event name alone made "Engineering" appear while parked on a
    // Fleet Carrier.
    const r = resolver(() => 1000);
    r.observe(ev(ENGINEER_PROGRESS_SUMMARY), stateWith(DOCKED_FLEET_CARRIER));
    expect(r.current().map((a) => a.rule.id)).not.toContain('engineering-activity');
  });

  it('accepts a single real EngineerProgress change', () => {
    const r = resolver(() => 1000);
    r.observe(ev(ENGINEER_PROGRESS_CHANGE), initialState());
    expect(r.current().map((a) => a.rule.id)).toContain('engineering-activity');
  });

  it('does NOT claim "at an Engineer" merely because a station reports the service', () => {
    // Regression. The `engineer` service token appears at 227 of 242 distinct
    // stations in the corpus, including all 17 Fleet Carriers, so it says nothing
    // about being at an Engineer. A rule keyed on it reported "At an Engineer"
    // while the commander was docked at their own carrier.
    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), stateWith(DOCKED_FLEET_CARRIER));

    const ids = r.current().map((a) => a.rule.id);
    expect(ids).not.toContain('engineering-activity');
    expect(ids).toContain('fleet-carrier'); // what it should say instead
  });

  it('drops a station context the moment the commander leaves', () => {
    // Regression. Fleet Carrier services has a 30-minute TTL, so after undocking
    // and flying to an orbital station it kept offering carrier links from a
    // Coriolis. A state-scoped rule is true exactly while its condition holds.
    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), stateWith(DOCKED_FLEET_CARRIER));
    expect(r.current().map((a) => a.rule.id)).toContain('fleet-carrier');

    // Same instant — well inside the TTL — but docked somewhere else.
    expect(r.observe(ev(MUSIC), stateWith(DOCKED_ENGINEER))).toBe(true);
    expect(r.current().map((a) => a.rule.id)).not.toContain('fleet-carrier');
  });

  it('keeps an event-triggered context after the event has passed', () => {
    // The counterpart: prospecting is a moment, not a situation, so it must
    // survive subsequent unrelated events for its full TTL.
    const r = resolver(() => 1000);
    r.observe(ev(PROSPECTED), initialState());
    r.observe(ev(MUSIC), initialState());
    expect(r.current().map((a) => a.rule.id)).toContain('mining-prospecting');
  });

  it('ranks by priority so the commander is not shown ten links at once', () => {
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_FLEET_CARRIER);
    r.observe(ev(ENGINEER_CRAFT), state); // engineering-activity (75)
    r.observe(ev(SCAN_ORGANIC), state); // exobiology-scan (80)
    r.observe(ev(PROSPECTED), state); // mining-prospecting (70)

    const ids = r.current().map((a) => a.rule.id);
    expect(ids[0]).toBe('exobiology-scan'); // highest priority wins
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it('expires contexts once their TTL passes', () => {
    let now = 1000;
    const r = resolver(() => now);
    r.observe(ev(PROSPECTED), initialState());
    expect(r.current().length).toBe(1);

    now += 901 * 1000; // mining-prospecting ttl is 900s
    expect(r.current().length).toBe(0);
  });

  it('refreshing an active context does not report a change', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(true);
    // Re-matching only extends expiry; forcing a re-render for that would be noise.
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(false);
  });

  it('reports no change for the thousands of events that match nothing', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(MUSIC), initialState())).toBe(false);
    expect(r.current()).toEqual([]);
  });

  it('drops active contexts when the rule set is replaced', () => {
    const r = resolver(() => 1000);
    r.observe(ev(PROSPECTED), initialState());
    expect(r.current().length).toBe(1);

    // Carrying contexts across a rule change would show guidance the new set does
    // not actually endorse.
    r.setRuleSet({ version: 2, updatedAt: 'x', source: 'remote', rules: [] });
    expect(r.current()).toEqual([]);
    expect(r.version).toBe(2);
  });
});

describe('sanitise', () => {
  const base = { version: 1, updatedAt: 'x', source: 'remote' as const };

  it('drops rules without an id, title or condition', () => {
    const set = sanitise({
      ...base,
      rules: [
        { id: '', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] },
        { id: 'ok', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] },
      ],
    } as ContextRuleSet);
    expect(set.rules.map((r) => r.id)).toEqual(['ok']);
  });

  it('rejects duplicate ids, which would make expiry ambiguous', () => {
    const rule = { id: 'dup', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] };
    const set = sanitise({ ...base, rules: [rule, rule] } as ContextRuleSet);
    expect(set.rules.length).toBe(1);
  });

  it('clamps an absurd or missing TTL so a context cannot pin itself on screen', () => {
    const set = sanitise({
      ...base,
      rules: [
        { id: 'a', title: 't', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1e12, resources: [] },
        { id: 'b', title: 't', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 0, resources: [] },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.ttlSeconds).toBe(24 * 60 * 60);
    expect(set.rules[1]!.ttlSeconds).toBe(300);
  });

  it('keeps actions and note intact when they are within bounds', () => {
    const set = sanitise({
      ...base,
      rules: [
        {
          id: 'a',
          title: 't',
          when: { kind: 'event', name: 'X' },
          priority: 1,
          ttlSeconds: 1,
          resources: [],
          actions: ['Do this first.', 'Then do this.'],
          note: 'Editorial guidance from EDFM.',
        },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.actions).toEqual(['Do this first.', 'Then do this.']);
    expect(set.rules[0]!.note).toBe('Editorial guidance from EDFM.');
  });

  it('truncates an oversized actions list rather than dropping the rule', () => {
    const set = sanitise({
      ...base,
      rules: [
        {
          id: 'a',
          title: 't',
          when: { kind: 'event', name: 'X' },
          priority: 1,
          ttlSeconds: 1,
          resources: [],
          actions: ['one', 'two', 'three', 'four', 'five', 'six'],
        },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.actions!.length).toBe(4);
    expect(set.rules[0]!.actions).toEqual(['one', 'two', 'three', 'four']);
  });

  it('clamps over-long action strings and notes', () => {
    const huge = 'x'.repeat(10_000);
    const set = sanitise({
      ...base,
      rules: [
        {
          id: 'a',
          title: 't',
          when: { kind: 'event', name: 'X' },
          priority: 1,
          ttlSeconds: 1,
          resources: [],
          actions: [huge],
          note: huge,
        },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.actions![0]!.length).toBe(512);
    expect(set.rules[0]!.note!.length).toBe(512);
  });

  it('leaves actions and note absent when a rule has neither', () => {
    const set = sanitise({
      ...base,
      rules: [
        { id: 'a', title: 't', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.actions).toBeUndefined();
    expect(set.rules[0]!.note).toBeUndefined();
  });
});

describe('bundled rule set', () => {
  it('has unique ids and survives sanitising unchanged', () => {
    const ids = BUNDLED_RULES.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sanitise(BUNDLED_RULES).rules.length).toBe(BUNDLED_RULES.rules.length);
  });

  it('only links pages verified to exist on EDFM', () => {
    // Checked against MediaWiki list=allpages on 2026-09-01. A rule pointing at a
    // page that does not exist produces a broken link that looks authoritative,
    // which is worse than showing nothing.
    const VERIFIED_PAGES = new Set([
      'Colonisation', 'Core Mining', 'Engineer Unlock Guide', 'Engineering',
      'Engineering Blueprints', 'Engineering Materials', 'Engineers', 'Exobiology',
      'Fleet Carrier Administration Systems', 'Fleet Carriers',
      'Frame Shift Drive Interdictor', 'How to Find a Mining Hotspot',
      'How to Resolve a Full Refinery', 'How to Use a Prospector Limpet',
      'How to Use a Refinery', 'Laser Mining', 'Mining', 'Mining Hotspot',
      'Pioneer Supplies', 'Planetary Rings', 'Powerplay', 'Refinery',
      'Ship Modules', 'Ships and Equipment', 'Trailblazers',
    ]);

    // Section anchors verified the same way, via action=parse&prop=sections. A
    // fragment pointing at a heading that does not exist silently lands the reader
    // at the top of the page, so it is checked rather than trusted.
    const VERIFIED_SECTIONS = new Set([
      'Engineering Materials#Material Traders',
    ]);

    for (const rule of BUNDLED_RULES.rules) {
      for (const resource of rule.resources) {
        if (!resource.page) continue;
        const hash = resource.page.indexOf('#');
        const title = hash === -1 ? resource.page : resource.page.slice(0, hash);
        const fragment = hash === -1 ? undefined : resource.page.slice(hash + 1);
        expect(VERIFIED_PAGES.has(title), `${rule.id} -> "${title}"`).toBe(true);
        if (fragment !== undefined) {
          expect(
            VERIFIED_SECTIONS.has(resource.page),
            `${rule.id} -> unverified section "${resource.page}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('gives every rule a resolvable URL', () => {
    for (const rule of BUNDLED_RULES.rules) {
      expect(rule.resources.length).toBeGreaterThan(0);
      for (const resource of rule.resources) {
        expect(resourceUrl(resource)).toMatch(/^https:\/\/edfieldmanual\.com\/wiki\//);
      }
    }
  });

  it('only triggers on events observed in the real journal corpus', () => {
    // Every event named here was counted in the 197,164-line corpus. A rule keyed
    // on an event the game never emits is dead weight that looks functional.
    const OBSERVED = new Set([
      'Interdicted', 'ColonisationConstructionDepot', 'ScanOrganic', 'ProspectedAsteroid',
      'SAASignalsFound', 'MiningRefined', 'PowerplayMerits', 'PowerplayCollect',
      'EngineerCraft', 'EngineerProgress', 'EngineerContribution',
      'PowerplayDeliver', 'PowerplayRank',
    ]);

    const names: string[] = [];
    const walk = (c: unknown): void => {
      if (!c || typeof c !== 'object') return;
      const cond = c as { kind: string; name?: string | string[]; of?: unknown };
      if (cond.kind === 'event' && cond.name) {
        names.push(...(Array.isArray(cond.name) ? cond.name : [cond.name]));
      }
      if (Array.isArray(cond.of)) cond.of.forEach(walk);
      else if (cond.of) walk(cond.of);
    };
    BUNDLED_RULES.rules.forEach((r) => walk(r.when));

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(OBSERVED.has(name), name).toBe(true);
  });

  it('assigns distinct priorities to the top contexts so ranking is stable', () => {
    const top = [...BUNDLED_RULES.rules].sort((a, b) => b.priority - a.priority).slice(0, 5);
    expect(new Set(top.map((r) => r.priority)).size).toBe(top.length);
  });
});

describe('Material Trader kind', () => {
  function resolver(now: () => number) {
    return new ContextResolver(BUNDLED_RULES, { now, maxActive: 5 });
  }

  it('does not name a kind before the commander has traded there', () => {
    // StationServices says only `materialtrader` -- measured over 141 docks with no
    // field naming the type. Claiming a kind here would be a guess.
    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), stateWith(DOCKED_TRADER_STATION));

    const ids = r.current().map((a) => a.rule.id);
    expect(ids).toContain('station-material-trader');
    expect(ids).not.toContain('station-material-trader-encoded');
    expect(ids).not.toContain('station-material-trader-raw');
    expect(ids).not.toContain('station-material-trader-manufactured');
  });

  it('names the kind once a MaterialTrade has revealed it', () => {
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));

    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), state);

    const ids = r.current().map((a) => a.rule.id);
    expect(ids).toContain('station-material-trader-encoded');
    // The untyped rule must step aside, or the panel says both at once.
    expect(ids).not.toContain('station-material-trader');
  });

  it('remembers the kind across a later visit', () => {
    // The whole point of persisting it: the trade may have been months ago.
    const first = stateWith(DOCKED_TRADER_STATION);
    applyEvent(first, ev(MATERIAL_TRADE_ENCODED));

    // Undock, then dock at the same station again with no trade this time.
    const second = initialState();
    second.knownTraders = { ...first.knownTraders };
    applyEvent(second, ev(DOCKED_TRADER_STATION));

    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), second);
    expect(r.current().map((a) => a.rule.id)).toContain('station-material-trader-encoded');
  });

  it('does not carry a kind to a different station', () => {
    // Regression risk: knownTraders is keyed by MarketID, and a stale traderType
    // left on state would name the wrong trader at the next station.
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));
    expect(state.traderType).toBe('encoded');

    applyEvent(state, ev(DOCKED_FLEET_CARRIER));
    expect(isKnown(state.traderType)).toBe(false);
  });

  it('links the Material Traders section, not the top of the page', () => {
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));

    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), state);
    const active = r.current().find((a) => a.rule.id === 'station-material-trader-encoded');
    const resource = active?.rule.resources[0];
    expect(resource).toBeDefined();
    expect(resourceUrl(resource!)).toBe(
      'https://edfieldmanual.com/wiki/Engineering_Materials#Material_Traders',
    );
  });
});

describe('Vista Genomics gating', () => {
  function resolver(now: () => number) {
    return new ContextResolver(BUNDLED_RULES, { now, maxActive: 5 });
  }

  function activeAt(state: CommanderState): string[] {
    const r = resolver(() => 1000);
    r.observe(ev(MUSIC), state);
    return r.current().map((a) => a.rule.id);
  }

  it('stays quiet at Vista Genomics with nothing confirmed to sell', () => {
    // The original complaint. `vistagenomics` is at 155 of 295 stations, including
    // carriers, so on its own it fired constantly and told commanders to sell data
    // they did not have.
    const s = stateWith(DOCKED_FLEET_CARRIER); // this carrier has vistagenomics
    expect(s.exobiologyToSell).toBe(0);
    expect(activeAt(s)).not.toContain('station-vista-genomics');
  });

  it('offers it once a specimen has actually been completed', () => {
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SCAN_ANALYSE));
    expect(s.exobiologyToSell).toBe(1);
    expect(activeAt(s)).toContain('station-vista-genomics');
  });

  it('does not count an incomplete sample as sellable data', () => {
    // Log and Sample are progress toward one specimen -- 183 of 243 scans. Counting
    // them would claim data the commander cannot sell.
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SCAN_SAMPLE));
    expect(s.exobiologyToSell).toBe(0);
    expect(activeAt(s)).not.toContain('station-vista-genomics');
  });

  it('stops offering it after the data has been sold', () => {
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SCAN_ANALYSE));
    expect(activeAt(s)).toContain('station-vista-genomics');

    applyEvent(s, ev(SELL_ORGANIC_ONE));
    expect(s.exobiologyToSell).toBe(0);
    expect(activeAt(s)).not.toContain('station-vista-genomics');
  });

  it('keeps offering it when only part of the holding was sold', () => {
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SCAN_ANALYSE));
    applyEvent(s, ev(SCAN_ANALYSE));
    applyEvent(s, ev(SELL_ORGANIC_ONE)); // sells 1 of 2
    expect(s.exobiologyToSell).toBe(1);
    expect(activeAt(s)).toContain('station-vista-genomics');
  });

  it('never goes negative when a sale includes data it never saw', () => {
    // Backfill is bounded, so a sale can legitimately exceed the running count.
    // Zero is the correct lower bound; a negative would make `gt 0` nonsense.
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SELL_ORGANIC_ONE));
    expect(s.exobiologyToSell).toBe(0);
  });

  it('stops claiming held data after a death', () => {
    // Deliberately conservative, not a claim about the mechanic: whether death
    // destroys unsold data could not be established from 18 deaths in the corpus.
    // Withholding a reminder is the better error than sending someone to sell data
    // they may no longer have.
    const s = stateWith(DOCKED_FLEET_CARRIER);
    applyEvent(s, ev(SCAN_ANALYSE));
    applyEvent(s, ev(DIED));
    expect(s.exobiologyToSell).toBe(0);
    expect(activeAt(s)).not.toContain('station-vista-genomics');
  });

  it('still recognises the act of scanning, separately from having data', () => {
    // The exobiology-scan rule is event-scoped and must be unaffected by gating.
    const r = resolver(() => 1000);
    r.observe(ev(SCAN_ANALYSE), initialState());
    expect(r.current().map((a) => a.rule.id)).toContain('exobiology-scan');
  });
});

describe('relevance decay', () => {
  /** Docked at a known Material Trader, as the commander would actually be. */
  function dockedAtTrader(): CommanderState {
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));
    return state;
  }

  it('lets a present station fact overtake a past activity', () => {
    // Reported from the game: docked at a station with a Material Trader, and the
    // overlay showed only "Engineering" -- an activity from another system. The
    // overlay renders current()[0], so a stale context hid a live one entirely.
    let t = 0;
    const r = new ContextResolver(BUNDLED_RULES, { now: () => t, maxActive: 3 });
    const state = dockedAtTrader();

    r.observe(ev(ENGINEER_CRAFT), state);
    expect(r.current()[0]!.rule.id).toBe('engineering-activity');

    // Four minutes later, still docked and not engineering. Engineering (75 over a
    // 900s TTL) has decayed past the trader (58), which has not decayed at all.
    t = 4 * 60 * 1000;
    r.observe(ev(MUSIC), state);
    expect(r.current()[0]!.rule.id).toBe('station-material-trader-encoded');
  });

  it('keeps an activity on top while it is actually still happening', () => {
    // The decay must not punish someone mid-session at an Engineer: every new
    // EngineerCraft refreshes matchedAt and restores full priority.
    let t = 0;
    const r = new ContextResolver(BUNDLED_RULES, { now: () => t, maxActive: 3 });
    const state = dockedAtTrader();

    for (let minute = 0; minute <= 10; minute += 1) {
      t = minute * 60 * 1000;
      r.observe(ev(ENGINEER_CRAFT), state);
      expect(r.current()[0]!.rule.id, `at minute ${minute}`).toBe('engineering-activity');
    }
  });

  it('does not decay a context that describes where the commander is', () => {
    // Being docked at a trader is exactly as true after half an hour as on arrival.
    let t = 0;
    const r = new ContextResolver(BUNDLED_RULES, { now: () => t, maxActive: 3 });
    const state = dockedAtTrader();

    r.observe(ev(MUSIC), state);
    const first = r.current()[0]!.rule.id;
    expect(first).toBe('station-material-trader-encoded');

    t = 30 * 60 * 1000;
    r.observe(ev(MUSIC), state);
    expect(r.current()[0]!.rule.id).toBe(first);
  });

  it('still ranks a fresh high-priority event above a station fact', () => {
    // Decay must not invert the ordering that priority exists to express. Being
    // interdicted right now outranks anything about the station you left.
    let t = 0;
    const r = new ContextResolver(BUNDLED_RULES, { now: () => t, maxActive: 3 });
    const state = dockedAtTrader();

    r.observe(ev(MUSIC), state);
    r.observe(ev(INTERDICTED), state);
    expect(r.current()[0]!.rule.id).toBe('interdicted');
  });
});

describe('an activity ends when the commander moves on', () => {
  function resolver(now: () => number) {
    return new ContextResolver(BUNDLED_RULES, { now, maxActive: 5 });
  }

  it('drops Engineering the moment the commander undocks', () => {
    // The reported case, at its root. Engineering happens docked or landed, so
    // undocking is proof it is over. Previously only the TTL could end it, so it
    // followed the commander across three systems and covered up where they were.
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));

    r.observe(ev(ENGINEER_CRAFT), state);
    expect(r.current().map((a) => a.rule.id)).toContain('engineering-activity');

    // Same instant -- far inside the TTL, and before any decay could matter.
    r.observe(ev(UNDOCKED), state);
    expect(r.current().map((a) => a.rule.id)).not.toContain('engineering-activity');
  });

  it('drops it on a jump too, for an activity left behind in another system', () => {
    const r = resolver(() => 1000);
    r.observe(ev(ENGINEER_CRAFT), initialState());
    expect(r.current().map((a) => a.rule.id)).toContain('engineering-activity');

    r.observe(ev(FSD_JUMP), initialState());
    expect(r.current().map((a) => a.rule.id)).not.toContain('engineering-activity');
  });

  it('leaves the station context alone -- it is not an activity', () => {
    // endsOn must not become a blunt instrument. Where the commander IS is held
    // open by its condition and has no business being ended by an event.
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_TRADER_STATION);
    applyEvent(state, ev(MATERIAL_TRADE_ENCODED));

    r.observe(ev(ENGINEER_CRAFT), state);
    r.observe(ev(UNDOCKED), state);

    // Still reported as docked by this state fixture, so the trader is still true.
    expect(r.current().map((a) => a.rule.id)).toContain('station-material-trader-encoded');
  });

  it('does not end an activity that is still going', () => {
    // MaterialTrade is not in engineering's endsOn list, and must not end it:
    // trading materials at the Engineer is part of engineering, not leaving.
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_TRADER_STATION);

    r.observe(ev(ENGINEER_CRAFT), state);
    r.observe(ev(MATERIAL_TRADE_ENCODED), state);
    expect(r.current().map((a) => a.rule.id)).toContain('engineering-activity');
  });

  it('sanitises endsOn from an untrusted rule set', () => {
    // Rule sets arrive from the server and from plugins.
    const dirty = {
      version: 1,
      updatedAt: '2026-09-18T00:00:00Z',
      source: 'remote' as const,
      rules: [
        {
          id: 'x',
          title: 'X',
          when: { kind: 'event' as const, name: 'Music' },
          priority: 10,
          ttlSeconds: 60,
          resources: [],
          endsOn: [
            'Docked',
            '',
            42 as unknown as string,
            null as unknown as string,
            'a'.repeat(9999),
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
          ],
        },
      ],
    };

    const clean = sanitise(dirty).rules[0]!;
    expect(clean.endsOn).toBeDefined();
    expect(clean.endsOn!.length).toBeLessThanOrEqual(8);
    expect(clean.endsOn).not.toContain('');
    expect(clean.endsOn!.every((e) => typeof e === 'string')).toBe(true);
    expect(clean.endsOn!.every((e) => e.length <= 512)).toBe(true);
  });
});

describe('ring scans are not planet scans', () => {
  function active(line: string): string[] {
    const r = new ContextResolver(BUNDLED_RULES, { now: () => 1000, maxActive: 5 });
    r.observe(ev(line), initialState());
    return r.current().map((a) => a.rule.id);
  }

  it('reports a ring scan for an actual ring', () => {
    expect(active(SAA_RING)).toContain('mining-ring-scan');
  });

  it('says nothing about rings after DSS-ing a planet', () => {
    // Reported from the game. SAASignalsFound fires for every detailed surface
    // scan: 198 in the corpus, only 29 of them rings, so the bare event name was
    // wrong 85% of the time and the overlay claimed hotspots on a planet.
    expect(active(SAA_PLANET)).not.toContain('mining-ring-scan');
  });

  it('still says nothing for a planet that has a surface mining site', () => {
    // The near-miss case. These carry $PlanetaryMiningLocation_Name; and are
    // genuinely mining-related, but they are not rings and have no hotspots.
    expect(active(SAA_PLANET_MINING)).not.toContain('mining-ring-scan');
  });
});
