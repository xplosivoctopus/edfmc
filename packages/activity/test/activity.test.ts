import { describe, expect, it } from 'vitest';
import { JournalSessionContext, normalize, parseLine } from '@edfm/elite-journal';

import {
  ActivityEngine,
  groupActivity,
  linksFor,
  organismTitle,
  resolveEdfmPage,
  splitVariant,
  type ActivityEntry,
} from '../src/index.js';

const ctx = new JournalSessionContext();
let offset = 0;

function ev(line: string) {
  const parsed = parseLine(line, 'Journal.2026-09-28T120000.01.log', (offset += 100), ctx);
  if (!parsed?.ok) throw new Error('fixture failed to parse');
  return normalize(parsed.event);
}

/* Verbatim shapes from the corpus. */
const FSD_JUMP =
  '{ "timestamp":"2026-09-28T12:00:00Z", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe KO-G c24-10", "SystemAddress":2833504080594, "StarPos":[1,2,3], "JumpDist":8.5, "FuelUsed":0.6, "FuelLevel":31.2 }';

const SCAN_BODY =
  '{ "timestamp":"2026-09-28T12:01:00Z", "event":"Scan", "ScanType":"Detailed", "BodyName":"Wregoe KO-G c24-10 A 5", "BodyID":25, "StarSystem":"Wregoe KO-G c24-10", "SystemAddress":2833504080594, "DistanceFromArrivalLS":900.1, "WasDiscovered":false, "WasMapped":false, "WasFootfalled":false, "Landable":true }';

const SAA_BIO =
  '{ "timestamp":"2026-09-28T12:02:00Z", "event":"SAASignalsFound", "BodyName":"Wregoe KO-G c24-10 A 5", "SystemAddress":2833504080594, "BodyID":25, "Signals":[ { "Type":"$SAA_SignalType_Biological;", "Type_Localised":"Biological", "Count":2 } ], "Genuses":[ { "Genus":"$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised":"Stratum" }, { "Genus":"$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised":"Bacterium" } ] }';

const TOUCHDOWN =
  '{ "timestamp":"2026-09-28T12:03:00Z", "event":"Touchdown", "PlayerControlled":true, "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe KO-G c24-10", "SystemAddress":2833504080594, "Body":"Wregoe KO-G c24-10 A 5", "BodyID":25, "OnStation":false, "OnPlanet":true, "Latitude":-14.2, "Longitude":83.1 }';

const scanOrganic = (type: string) =>
  `{ "timestamp":"2026-09-28T12:0${type === 'Analyse' ? 6 : 4}:00Z", "event":"ScanOrganic", "ScanType":"${type}", "Genus":"$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised":"Stratum", "Species":"$Codex_Ent_Stratum_01_Name;", "Species_Localised":"Stratum Excutitus", "Variant":"$Codex_Ent_Stratum_01_K_Name;", "Variant_Localised":"Stratum Excutitus - Lime", "WasLogged":false, "SystemAddress":2833504080594, "Body":25 }`;

const SELL_ORGANIC =
  '{ "timestamp":"2026-09-28T13:00:00Z", "event":"SellOrganicData", "MarketID":3703420416, "BioData":[ { "Genus":"$G;", "Genus_Localised":"Stratum", "Species":"$S;", "Species_Localised":"Stratum Excutitus", "Variant":"$V;", "Variant_Localised":"Stratum Excutitus - Lime", "Value":1000000, "Bonus":4000000 } ] }';

function engine(fid = 'F0000000'): ActivityEngine {
  return new ActivityEngine({ commanderFid: fid });
}

describe('variant naming', () => {
  it('splits the colour out of the variant the game reports', () => {
    // Variant_Localised is "Species - Colour" on 100% of 275 measured scans.
    expect(splitVariant('Stratum Excutitus - Lime', 'Stratum Excutitus')).toEqual({
      species: 'Stratum Excutitus',
      colour: 'Lime',
    });
  });

  it('leaves the colour unknown when the variant is just the species', () => {
    // Brain trees report the species as the variant. Inventing a colour would be
    // exactly the kind of guess this project refuses.
    expect(splitVariant('Roseum Brain Tree', 'Roseum Brain Tree')).toEqual({
      species: 'Roseum Brain Tree',
      colour: null,
    });
  });

  it('renders the title a commander would recognise', () => {
    expect(organismTitle('Stratum Excutitus', 'Lime')).toBe('Stratum Excutitus — Lime');
    expect(organismTitle('Roseum Brain Tree', null)).toBe('Roseum Brain Tree');
    expect(organismTitle(null, null)).toBe('Unknown organism');
  });
});

describe('exobiology activity', () => {
  it('records a completed sample and nothing for the steps toward it', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    e.observe(ev(SCAN_BODY));

    // Log and Sample are progress, not activity. 183 of 243 measured scans are
    // one of those, and an entry each would bury the completion in its own noise.
    expect(e.observe(ev(scanOrganic('Log')))).toHaveLength(0);
    expect(e.observe(ev(scanOrganic('Sample')))).toHaveLength(0);

    const done = e.observe(ev(scanOrganic('Analyse')));
    expect(done).toHaveLength(1);
    expect(done[0]!.title).toBe('Stratum Excutitus — Lime');
    expect(done[0]!.detail).toBe('Biological sample completed');
    expect(done[0]!.subtype).toBe('sample-completed');
  });

  it('resolves the body name, which ScanOrganic reports only as an id', () => {
    // ScanOrganic.Body is an integer. Without the Scan seen first there is no
    // name to give, and the honest answer is null rather than the current
    // location, which may have moved on.
    const withScan = engine();
    withScan.observe(ev(FSD_JUMP));
    withScan.observe(ev(SCAN_BODY));
    expect(withScan.observe(ev(scanOrganic('Analyse')))[0]!.bodyName).toBe(
      'Wregoe KO-G c24-10 A 5',
    );

    const without = engine();
    without.observe(ev(FSD_JUMP));
    expect(without.observe(ev(scanOrganic('Analyse')))[0]!.bodyName).toBeNull();
  });

  it('records biological signals only when genera are reported', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entries = e.observe(ev(SAA_BIO));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('2 biological signals detected');
    expect(entries[0]!.detail).toBe('Stratum, Bacterium');
  });

  it('records a sale with what was sold', () => {
    const e = engine();
    const entries = e.observe(ev(SELL_ORGANIC));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Sold 1 exobiology sample');
    expect(entries[0]!.data['value']).toBe(1000000);
  });

  it('does not treat the sale bonus as confirmed first discovery', () => {
    // Recorded, not interpreted. Across all 45 sold entries in the corpus Bonus
    // was exactly 4x Value with no counter-example, so the data cannot show that
    // it means first discovery rather than being paid unconditionally.
    const e = engine();
    const entry = e.observe(ev(SELL_ORGANIC))[0]!;
    expect(entry.data['bonus']).toBe(4000000);
    expect(JSON.stringify(entry)).not.toContain('first');
    expect(JSON.stringify(entry)).not.toContain('First');
  });
});

describe('landing', () => {
  it('records a landing on a world', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entries = e.observe(ev(TOUCHDOWN));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Landed');
    expect(entries[0]!.bodyName).toBe('Wregoe KO-G c24-10 A 5');
  });

  it('never claims a first landfall', () => {
    // The finding, pinned. The only footfall field in the journal is
    // Scan.WasFootfalled, which reports the body's state when scanned; nothing
    // reports that the commander achieved one. What was said is recorded; the
    // claim is not made.
    const e = engine();
    e.observe(ev(FSD_JUMP));
    e.observe(ev(SCAN_BODY)); // WasFootfalled: false
    const entry = e.observe(ev(TOUCHDOWN))[0]!;

    expect(entry.data['hadPriorFootfallWhenScanned']).toBe(false);
    expect(entry.title.toLowerCase()).not.toContain('first');
    expect(JSON.stringify(entry.data).toLowerCase()).not.toContain('firstfootfall');
  });

  it('ignores a touchdown that is not on a planet', () => {
    const e = engine();
    const pad = TOUCHDOWN.replace('"OnPlanet":true', '"OnPlanet":false');
    expect(e.observe(ev(pad))).toHaveLength(0);
  });
});

describe('identity and commander scoping', () => {
  it('derives a stable id from the source event, so replay cannot duplicate', () => {
    // The whole deduplication strategy. eventId is `sourceFile:byteOffset`,
    // already guaranteed stable across restart and replay.
    const line = scanOrganic('Analyse');

    /** Parse the same line at the same offset twice, as a replay would. */
    function once(): string {
      const parsed = parseLine(line, 'Journal.A.log', 4096, new JournalSessionContext());
      if (!parsed?.ok) throw new Error('fixture failed to parse');
      const entries = new ActivityEngine({ commanderFid: 'F1' }).observe(normalize(parsed.event));
      return entries[0]!.id;
    }

    const first = once();
    expect(once()).toBe(first);
    expect(first).toContain('Journal.A.log');
  });

  it('records nothing before a commander is known', () => {
    const e = new ActivityEngine({ commanderFid: null });
    e.observe(ev(FSD_JUMP));
    expect(e.observe(ev(scanOrganic('Analyse')))).toHaveLength(0);
  });

  it('scopes entries to the commander', () => {
    const e = engine('F1234567');
    e.observe(ev(FSD_JUMP));
    expect(e.observe(ev(scanOrganic('Analyse')))[0]!.commanderFid).toBe('F1234567');
  });

  it('forgets body names when the commander changes', () => {
    // Two people on one machine must not inherit each other's history, and a
    // BodyID learned under one is meaningless under the other.
    const e = engine('F1');
    e.observe(ev(FSD_JUMP));
    e.observe(ev(SCAN_BODY));
    e.setCommander('F2');
    expect(e.observe(ev(scanOrganic('Analyse')))[0]!.bodyName).toBeNull();
  });

  it('forgets body names on leaving the system, since ids are system-local', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    e.observe(ev(SCAN_BODY));
    e.observe(ev(FSD_JUMP.replace('2833504080594', '999').replace('Wregoe KO-G c24-10', 'Elsewhere')));
    expect(e.observe(ev(scanOrganic('Analyse')))[0]!.bodyName).toBeNull();
  });
});

describe('grouping', () => {
  it('gathers activity by system and body, newest first', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    e.observe(ev(SCAN_BODY));
    const entries: ActivityEntry[] = [
      ...e.observe(ev(SAA_BIO)),
      ...e.observe(ev(TOUCHDOWN)),
      ...e.observe(ev(scanOrganic('Analyse'))),
    ];

    const groups = groupActivity(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.systemName).toBe('Wregoe KO-G c24-10');
    expect(groups[0]!.bodyName).toBe('Wregoe KO-G c24-10 A 5');
    expect(groups[0]!.entries).toHaveLength(3);
    // Within a group, oldest first: it reads as a sequence of what happened.
    expect(groups[0]!.entries[0]!.subtype).toBe('signals-detected');
  });
});

describe('links', () => {
  it('does not link a species page, because none exists', () => {
    // Checked against the live wiki: all 25 species and 11 genera in the corpus
    // are absent. Linking them would produce authoritative-looking 404s.
    expect(resolveEdfmPage('Stratum Tectonicas')).toBeNull();
    expect(resolveEdfmPage('Bacterium')).toBeNull();
  });

  it('falls back to a page that does exist', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entry = e.observe(ev(scanOrganic('Analyse')))[0]!;
    const links = linksFor(entry);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe('https://edfieldmanual.com/wiki/Exobiology');
    expect(links[0]!.kind).toBe('edfm');
  });

  it('adds no external link without a configured provider', () => {
    // The journal is useful offline, and no provider's deep-link format has been
    // verified here. An unverified template is the broken link again.
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entry = e.observe(ev(scanOrganic('Analyse')))[0]!;
    expect(linksFor(entry).some((l) => l.kind === 'external')).toBe(false);
  });

  it('uses a provider when one is configured', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entry = e.observe(ev(scanOrganic('Analyse')))[0]!;
    const links = linksFor(entry, { name: 'Example', systemUrl: 'https://example.com/s/{system}' });
    const external = links.find((l) => l.kind === 'external');
    expect(external?.url).toBe('https://example.com/s/Wregoe%20KO-G%20c24-10');
  });

  it('refuses a provider template that is not https', () => {
    const e = engine();
    e.observe(ev(FSD_JUMP));
    const entry = e.observe(ev(scanOrganic('Analyse')))[0]!;
    const links = linksFor(entry, { name: 'Bad', systemUrl: 'javascript:alert(1)' });
    expect(links.some((l) => l.kind === 'external')).toBe(false);
  });
});
