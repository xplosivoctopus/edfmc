/**
 * Tests for live exobiology state.
 *
 * The state machine is exercised with synthetic events shaped exactly like the
 * corpus; the *sequences* are verified against the corpus itself in
 * `live-corpus.test.ts`, because the finding that drove this design — that a run
 * is `Log, Sample, Sample, Analyse` rather than three events — is only visible in
 * real data.
 */

import { describe, expect, it } from 'vitest';

import {
  LiveActivityTracker,
  SAMPLES_REQUIRED,
  rowStatus,
  stageText,
  type SpeciesProgress,
} from '../src/live.js';
import type { NormalizedEvent } from '@edfm/elite-journal';

let seq = 0;

/** A journal event in the shape the corpus actually writes. */
function ev(name: string, raw: Record<string, unknown>, at = '2026-09-01T00:00:00Z'): NormalizedEvent {
  seq += 1;
  return {
    kind: 'unknown',
    known: false,
    data: null,
    source: {
      event: name,
      raw: { event: name, timestamp: at, ...raw },
      provenance: {
        eventId: `Journal.test.log:${seq}`,
        sourceFile: 'Journal.test.log',
        byteOffset: seq,
        timestamp: at,
        timestampMs: Date.parse(at),
        gameVersion: '4.4.0.3',
        build: 'r000/r0 ',
        odyssey: true,
        part: 1,
        commander: 'Sythan',
        fid: 'F-TEST',
      },
    },
  } as NormalizedEvent;
}

const STRATUM = '$Codex_Ent_Stratum_Genus_Name;';
const BACTERIAL = '$Codex_Ent_Bacterial_Genus_Name;';
const CONCHA = '$Codex_Ent_Conchas_Genus_Name;';

/** Verbatim field set from a real ScanOrganic. */
function scan(
  scanType: string,
  over: Record<string, unknown> = {},
  at?: string,
): NormalizedEvent {
  return ev(
    'ScanOrganic',
    {
      ScanType: scanType,
      Genus: STRATUM,
      Genus_Localised: 'Stratum',
      Species: '$Codex_Ent_Stratum_04_Name;',
      Species_Localised: 'Stratum Tectonicas',
      Variant: '$Codex_Ent_Stratum_04_M_Name;',
      Variant_Localised: 'Stratum Tectonicas - Emerald',
      WasLogged: false,
      SystemAddress: 1234,
      Body: 12,
      ...over,
    },
    at,
  );
}

/** A detailed surface scan. */
function dss(genera: readonly (readonly [string, string])[], bodyId = 12, systemAddress = 1234) {
  return ev('SAASignalsFound', {
    BodyName: 'Nervi 4 a',
    SystemAddress: systemAddress,
    BodyID: bodyId,
    Signals: [
      { Type: '$SAA_SignalType_Biological;', Type_Localised: 'Biological', Count: genera.length },
    ],
    Genuses: genera.map(([token, localised]) => ({ Genus: token, Genus_Localised: localised })),
  });
}

const approach = (bodyId = 12, systemAddress = 1234) =>
  ev('ApproachBody', {
    StarSystem: 'Nervi',
    SystemAddress: systemAddress,
    Body: 'Nervi 4 a',
    BodyID: bodyId,
  });

const bodies = new Map([[12, 'Nervi 4 a']]);

function tracker() {
  return new LiveActivityTracker({ commanderFid: 'F-TEST' });
}

/** Arrive at a scanned body, which is the ordinary starting point. */
function atBody(genera: readonly (readonly [string, string])[] = [[STRATUM, 'Stratum']]) {
  const t = tracker();
  t.observe(approach(), bodies);
  t.observe(dss(genera), bodies);
  return t;
}

const row = (t: LiveActivityTracker, genusToken: string): SpeciesProgress =>
  t.state!.exobiology.rows.find((r) => r.genusToken === genusToken)!;

describe('the measured sample sequence', () => {
  it('Log is the first of three samples', () => {
    const t = atBody();
    expect(t.observe(scan('Log'), bodies)).toBe(true);
    const r = row(t, STRATUM);
    expect(r.samplesTaken).toBe(1);
    expect(r.samplesRequired).toBe(SAMPLES_REQUIRED);
    expect(r.completed).toBe(false);
    expect(stageText(r)).toBe('1 / 3');
  });

  it('the first Sample is the second, not the third', () => {
    /*
     * The heart of it. The intuitive model is Log/Sample/Analyse = 1/2/3, which
     * would make this event 3 of 3 and report the specimen finished one sample
     * early. The corpus says Sample occurs twice.
     */
    const t = atBody();
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(stageText(row(t, STRATUM))).toBe('2 / 3');
    expect(row(t, STRATUM).completed).toBe(false);
  });

  it('the second Sample is the third and still not complete', () => {
    const t = atBody();
    for (const st of ['Log', 'Sample', 'Sample']) t.observe(scan(st), bodies);
    expect(stageText(row(t, STRATUM))).toBe('3 / 3');
    // Three collected, but the data is not aboard until Analyse.
    expect(row(t, STRATUM).completed).toBe(false);
  });

  it('Analyse completes the specimen', () => {
    const t = atBody();
    for (const st of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(st), bodies);
    const r = row(t, STRATUM);
    expect(r.completed).toBe(true);
    expect(r.samplesTaken).toBe(3);
    expect(rowStatus(r)).toBe('complete');
  });

  it('never counts past the required number', () => {
    const t = atBody();
    for (const st of ['Log', 'Sample', 'Sample', 'Sample', 'Sample']) t.observe(scan(st), bodies);
    expect(row(t, STRATUM).samplesTaken).toBe(SAMPLES_REQUIRED);
  });
});

describe('the roster', () => {
  it('lists every genus the surface scan reported', () => {
    const t = atBody([
      [STRATUM, 'Stratum'],
      [BACTERIAL, 'Bacterium'],
      [CONCHA, 'Concha'],
    ]);
    expect(t.state!.exobiology.rows.map((r) => r.genus)).toEqual([
      'Stratum',
      'Bacterium',
      'Concha',
    ]);
    expect(t.state!.exobiology.unscannedCount).toBe(3);
    expect(t.state!.exobiology.total).toBe(3);
  });

  it('shows the genus and no species until one is sampled', () => {
    /*
     * A surface scan reports a genus and nothing finer. "Concha" is what the
     * game said; "Concha Renibus" would be a guess.
     */
    const t = atBody([[CONCHA, 'Concha']]);
    const r = row(t, CONCHA);
    expect(r.genus).toBe('Concha');
    expect(r.species).toBeNull();
    expect(r.speciesToken).toBeNull();
    expect(rowStatus(r)).toBe('unscanned');
    expect(stageText(r)).toBeNull();
  });

  it('fills in species and variant once sampling starts', () => {
    const t = atBody();
    t.observe(scan('Log'), bodies);
    const r = row(t, STRATUM);
    expect(r.species).toBe('Stratum Tectonicas');
    expect(r.colour).toBe('Emerald');
  });

  it('reports a fully worked body as finished', () => {
    const t = atBody([[STRATUM, 'Stratum']]);
    for (const st of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(st), bodies);
    const e = t.state!.exobiology;
    expect(e.completedCount).toBe(1);
    expect(e.unscannedCount).toBe(0);
    expect(e.total).toBe(1);
  });

  it('merges a repeat surface scan rather than duplicating it', () => {
    // Measured: 17 of 60 bodies were scanned more than once.
    const t = atBody([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]);
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    expect(t.state!.exobiology.rows).toHaveLength(2);
  });

  it('shows nothing for a body that was never surface-scanned', () => {
    // With no scan there is no list, and an empty panel is not a claim that
    // nothing is down there.
    const t = tracker();
    t.observe(approach(), bodies);
    expect(t.state).toBeNull();
  });

  it('ignores a surface scan of a body the commander is not at', () => {
    // The DSS is usually done from orbit before arriving -- 99 of 122 had no
    // prior ApproachBody -- so it must not drag the display to another body.
    const t = atBody([[STRATUM, 'Stratum']]);
    t.observe(dss([[BACTERIAL, 'Bacterium']], 99), bodies);
    expect(t.state!.exobiology.rows).toHaveLength(1);
    expect(t.state!.exobiology.bodyId).toBe(12);
  });
});

describe('one specimen at a time', () => {
  it('returns a partial row to unscanned when a different genus is started', () => {
    /*
     * Of 80 completed runs every one was contiguous, and the only 3 interrupted
     * runs never completed -- so partial progress does not appear to survive
     * switching organisms.
     */
    const t = atBody([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]);
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(row(t, STRATUM).samplesTaken).toBe(2);

    t.observe(scan('Log', { Genus: BACTERIAL, Genus_Localised: 'Bacterium' }), bodies);
    expect(row(t, STRATUM).samplesTaken).toBe(0);
    expect(rowStatus(row(t, STRATUM))).toBe('unscanned');
    expect(row(t, BACTERIAL).samplesTaken).toBe(1);
  });

  it('never resets a completed specimen', () => {
    // Analyse banked it.
    const t = atBody([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]);
    for (const st of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(st), bodies);
    t.observe(scan('Log', { Genus: BACTERIAL, Genus_Localised: 'Bacterium' }), bodies);
    expect(row(t, STRATUM).completed).toBe(true);
    expect(rowStatus(row(t, STRATUM))).toBe('complete');
  });
});

describe('what must NOT disturb progress', () => {
  /*
   * These are measured. Commanders fly between plants: landing, getting out,
   * sampling, boarding and taking off all appear between the stages of a single
   * organism in most runs.
   */
  const duringNormalSampling = [
    ['Liftoff', { OnPlanet: true, PlayerControlled: true }],
    ['Embark', { SRV: false, Taxi: false }],
    ['Disembark', { SRV: false, Taxi: false }],
    ['SuitLoadout', { SuitName: '$UtilitySuit_Class1_Name;' }],
    ['Music', { MusicTrack: 'Exploration' }],
    ['BackpackChange', {}],
    ['DockSRV', {}],
    ['LaunchSRV', {}],
    ['Fileheader', { gameversion: '4.4.0.3' }],
    ['LoadGame', { Commander: 'Sythan', FID: 'F-TEST' }],
    ['Shutdown', {}],
    ['Died', {}],
  ] as const;

  for (const [name, raw] of duringNormalSampling) {
    it(`${name} leaves progress intact`, () => {
      const t = atBody();
      t.observe(scan('Log'), bodies);
      t.observe(scan('Sample'), bodies);
      t.observe(ev(name, raw as Record<string, unknown>), bodies);
      expect(t.state, name).not.toBeNull();
      expect(row(t, STRATUM).samplesTaken, name).toBe(2);
    });
  }

  it('landing again on the same body keeps the roster', () => {
    const t = atBody();
    t.observe(scan('Log'), bodies);
    t.observe(ev('Touchdown', { OnPlanet: true, PlayerControlled: true, BodyID: 12, SystemAddress: 1234 }), bodies);
    expect(row(t, STRATUM).samplesTaken).toBe(1);
  });
});

describe('leaving and coming back', () => {
  it('stops showing the roster once the commander leaves the body', () => {
    // Measured: a visit ends with SupercruiseEntry far more often (471) than
    // with LeaveBody (41), so both are honoured.
    const t = atBody();
    t.observe(scan('Log'), bodies);
    expect(t.observe(ev('SupercruiseEntry', {}), bodies)).toBe(true);
    expect(t.state).toBeNull();
  });

  it('asks for the stored roster when a body is entered', () => {
    const t = tracker();
    t.observe(approach(), bodies);
    const req = t.takeHydrationRequest();
    expect(req?.bodyId).toBe(12);
    expect(req?.systemAddress).toBe(1234);
    // Consumed once, so a caller cannot load the same body repeatedly.
    expect(t.takeHydrationRequest()).toBeNull();
  });

  it('restores progress recorded in an earlier session', () => {
    /*
     * The point of persisting at all: a commander called away mid-run comes back
     * and sees where they stopped instead of guessing.
     */
    const t = tracker();
    t.observe(approach(), bodies);
    const ref = t.takeHydrationRequest()!;
    t.hydrate(ref, [
      {
        genusToken: BACTERIAL,
        genus: 'Bacterium',
        speciesToken: '$sp;',
        species: 'Bacterium Vesicula',
        colour: 'Gold',
        samplesTaken: 3,
        samplesRequired: 3,
        completed: true,
        startedAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:10:00Z',
      },
      {
        genusToken: STRATUM,
        genus: 'Stratum',
        speciesToken: '$sp2;',
        species: 'Aleoida Coronamus',
        colour: 'Turquoise',
        samplesTaken: 2,
        samplesRequired: 3,
        completed: false,
        startedAt: '2026-08-01T00:20:00Z',
        updatedAt: '2026-08-01T00:25:00Z',
      },
      {
        genusToken: CONCHA,
        genus: 'Concha',
        speciesToken: null,
        species: null,
        colour: null,
        samplesTaken: 0,
        samplesRequired: 3,
        completed: false,
        startedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ]);

    const e = t.state!.exobiology;
    expect(e.rows.map((r) => [r.species ?? r.genus, rowStatus(r)])).toEqual([
      ['Bacterium Vesicula', 'complete'],
      ['Aleoida Coronamus', 'sampling'],
      ['Concha', 'unscanned'],
    ]);
    expect(stageText(e.rows[1]!)).toBe('2 / 3');
    expect(e.completedCount).toBe(1);
    expect(e.unscannedCount).toBe(1);
  });

  it('does not let stored rows overwrite something newer from this session', () => {
    // A scan that happened before the read completed must win.
    const t = tracker();
    t.observe(approach(), bodies);
    const ref = t.takeHydrationRequest()!;
    t.observe(dss([[STRATUM, 'Stratum']]), bodies);
    t.observe(scan('Log'), bodies);

    t.hydrate(ref, [
      {
        genusToken: STRATUM,
        genus: 'Stratum',
        speciesToken: null,
        species: null,
        colour: null,
        samplesTaken: 0,
        samplesRequired: 3,
        completed: false,
        startedAt: null,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(row(t, STRATUM).samplesTaken).toBe(1);
  });

  it('ignores a hydration meant for a different body', () => {
    const t = tracker();
    t.observe(approach(12), bodies);
    const ref = t.takeHydrationRequest()!;
    t.observe(ev('SupercruiseEntry', {}), bodies);
    t.observe(approach(13, 1234), bodies);
    t.takeHydrationRequest();

    t.hydrate(ref, [
      {
        genusToken: STRATUM,
        genus: 'Stratum',
        speciesToken: null,
        species: null,
        colour: null,
        samplesTaken: 0,
        samplesRequired: 3,
        completed: false,
        startedAt: null,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(t.state).toBeNull();
  });
});

describe('what the caller must persist', () => {
  it('reports rows that changed, once', () => {
    const t = atBody([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]);
    expect(t.takeDirtyRows().map((r) => r.genusToken).sort()).toEqual(
      [BACTERIAL, STRATUM].sort(),
    );
    expect(t.takeDirtyRows()).toEqual([]);

    t.observe(scan('Log'), bodies);
    expect(t.takeDirtyRows().map((r) => r.genusToken)).toEqual([STRATUM]);
  });

  it('reports a row reset by switching organisms, so the reset is stored too', () => {
    const t = atBody([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]);
    t.takeDirtyRows();
    t.observe(scan('Log'), bodies);
    t.takeDirtyRows();

    t.observe(scan('Log', { Genus: BACTERIAL, Genus_Localised: 'Bacterium' }), bodies);
    const dirty = t.takeDirtyRows().map((r) => r.genusToken).sort();
    expect(dirty).toEqual([BACTERIAL, STRATUM].sort());
  });

  it('names the body those rows belong to', () => {
    const t = atBody();
    expect(t.currentBody?.bodyId).toBe(12);
    expect(t.currentBody?.bodyName).toBe('Nervi 4 a');
  });
});

describe('the count it refuses to invent', () => {
  it('reports no stage number when the run began before the app was watching', () => {
    /*
     * The reader resumes from a byte offset rather than replaying history, so
     * starting the app midway through a run means the first event seen is a
     * Sample that could be the second or the third. A wrong "1 / 3" would say
     * two samples remain when one does.
     */
    const t = atBody();
    t.observe(scan('Sample'), bodies);
    const r = row(t, STRATUM);
    expect(r.samplesTaken).toBeNull();
    expect(stageText(r)).toBeNull();
    expect(rowStatus(r)).toBe('sampling');
    // It still knows what is being sampled, which is most of the value.
    expect(r.species).toBe('Stratum Tectonicas');
  });

  it('keeps the count unestablished across further samples', () => {
    const t = atBody();
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(row(t, STRATUM).samplesTaken).toBeNull();
  });

  it('recovers a definite count on Analyse', () => {
    const t = atBody();
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Analyse'), bodies);
    expect(row(t, STRATUM).samplesTaken).toBe(3);
    expect(stageText(row(t, STRATUM))).toBe('3 / 3');
  });
});

describe('commander separation', () => {
  it('clears everything on a commander switch', () => {
    const t = atBody();
    t.observe(scan('Log'), bodies);
    t.setCommander('F-OTHER');
    expect(t.state).toBeNull();
  });

  it('re-setting the same commander changes nothing', () => {
    const t = atBody();
    t.observe(scan('Log'), bodies);
    t.setCommander('F-TEST');
    expect(t.state).not.toBeNull();
  });
});
