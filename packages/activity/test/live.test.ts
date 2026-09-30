/**
 * Tests for live activity state.
 *
 * The state machine is exercised with synthetic events shaped exactly like the
 * corpus; the *sequences* are verified against the corpus itself in
 * `live-corpus.test.ts`, because the finding that drove this design — that a run
 * is `Log, Sample, Sample, Analyse` rather than three events — is only visible
 * in real data.
 */

import { describe, expect, it } from 'vitest';

import {
  LiveActivityTracker,
  SAMPLES_REQUIRED,
  sampleStageText,
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

/** Verbatim field set from a real ScanOrganic. */
function scan(scanType: string, over: Record<string, unknown> = {}, at?: string): NormalizedEvent {
  return ev(
    'ScanOrganic',
    {
      ScanType: scanType,
      Genus: '$Codex_Ent_Stratum_Genus_Name;',
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

const bodies = new Map([[12, 'Nervi 4 a']]);

function tracker() {
  return new LiveActivityTracker({ commanderFid: 'F-TEST' });
}

describe('the measured sample sequence', () => {
  it('Log is the first of three samples', () => {
    const t = tracker();
    expect(t.observe(scan('Log'), bodies)).toBe(true);
    const live = t.state?.exobiology;
    expect(live?.samplesTaken).toBe(1);
    expect(live?.samplesRequired).toBe(SAMPLES_REQUIRED);
    expect(live?.completed).toBe(false);
    expect(sampleStageText(live!)).toBe('1 / 3');
  });

  it('the first Sample is the second, not the third', () => {
    /*
     * The heart of it. The intuitive model is Log/Sample/Analyse = 1/2/3, which
     * would make this event 3 of 3 and report the specimen as finished one
     * sample early. The corpus says Sample occurs twice.
     */
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(sampleStageText(t.state!.exobiology)).toBe('2 / 3');
    expect(t.state!.exobiology.completed).toBe(false);
  });

  it('the second Sample is the third and still not complete', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(sampleStageText(t.state!.exobiology)).toBe('3 / 3');
    // Three samples taken, but the data is not aboard until Analyse.
    expect(t.state!.exobiology.completed).toBe(false);
  });

  it('Analyse completes the specimen', () => {
    const t = tracker();
    for (const s of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(s), bodies);
    const live = t.state!.exobiology;
    expect(live.completed).toBe(true);
    expect(live.samplesTaken).toBe(3);
    expect(sampleStageText(live)).toBe('3 / 3');
  });

  it('never counts past the required number', () => {
    const t = tracker();
    for (const s of ['Log', 'Sample', 'Sample', 'Sample', 'Sample']) t.observe(scan(s), bodies);
    expect(t.state!.exobiology.samplesTaken).toBe(SAMPLES_REQUIRED);
  });
});

describe('identity', () => {
  it('carries genus, species and variant colour', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    const live = t.state!.exobiology;
    expect(live.genus).toBe('Stratum');
    expect(live.species).toBe('Stratum Tectonicas');
    expect(live.colour).toBe('Emerald');
  });

  it('resolves the body name through the engine map rather than guessing', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.bodyName).toBe('Nervi 4 a');
    expect(t.state!.exobiology.bodyId).toBe(12);
  });

  it('leaves the body name null when nothing has named it', () => {
    // Honest absence. Substituting the current location would be wrong the
    // moment the commander's state moved on from where they scanned.
    const t = tracker();
    t.observe(scan('Log'), new Map());
    expect(t.state!.exobiology.bodyName).toBeNull();
  });

  it('fills in a body name that arrives later', () => {
    const t = tracker();
    t.observe(scan('Log'), new Map());
    expect(t.resolveBodyName(bodies)).toBe(true);
    expect(t.state!.exobiology.bodyName).toBe('Nervi 4 a');
  });

  it('treats the same species on a different body as a different run', () => {
    // Measured: 9 of 25 species were sampled on more than one body, so identity
    // cannot be the species alone.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Log', { Body: 13 }), bodies);
    expect(t.state!.exobiology.bodyId).toBe(13);
    expect(t.state!.exobiology.samplesTaken).toBe(1);
  });

  it('a different organism replaces an unfinished run', () => {
    // Measured: each of the three runs that never completed was followed by a
    // different species' Log.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(
      scan('Log', {
        Species: '$Codex_Ent_Bacterial_01_Name;',
        Species_Localised: 'Bacterium Aurasus',
        Variant_Localised: 'Bacterium Aurasus - Gold',
      }),
      bodies,
    );
    expect(t.state!.exobiology.species).toBe('Bacterium Aurasus');
    expect(t.state!.exobiology.samplesTaken).toBe(1);
  });
});

describe('what must NOT reset a run', () => {
  /*
   * These are the measured ones, and they are the whole reason this list is
   * short. Commanders fly between plants: landing, getting out, sampling,
   * boarding and taking off all appear between the stages of a single organism
   * in most runs. Resetting on any of them would break the feature for nearly
   * every real run.
   */
  const duringNormalSampling = [
    ['Touchdown', { OnPlanet: true, PlayerControlled: true, Body: 'Nervi 4 a', BodyID: 12 }],
    ['Liftoff', { OnPlanet: true, PlayerControlled: true }],
    ['Embark', { SRV: false, Taxi: false }],
    ['Disembark', { SRV: false, Taxi: false }],
    ['SuitLoadout', { SuitName: '$UtilitySuit_Class1_Name;' }],
    ['Music', { MusicTrack: 'Exploration' }],
    ['BackpackChange', {}],
    ['DockSRV', {}],
    ['LaunchSRV', {}],
    // A game restart appears mid-run four times in the corpus, so quitting to
    // the menu does not abandon a sample either.
    ['Fileheader', { gameversion: '4.4.0.3' }],
    ['LoadGame', { Commander: 'Sythan', FID: 'F-TEST' }],
    ['Shutdown', {}],
  ] as const;

  for (const [name, raw] of duringNormalSampling) {
    it(`${name} leaves the run intact`, () => {
      const t = tracker();
      t.observe(scan('Log'), bodies);
      t.observe(scan('Sample'), bodies);
      t.observe(ev(name, raw as Record<string, unknown>), bodies);
      expect(t.state, name).not.toBeNull();
      expect(t.state!.exobiology.samplesTaken, name).toBe(2);
    });
  }

  it('a Location for the same system leaves the run intact', () => {
    // Restarting the game re-states the current location; that is not travel.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(ev('Location', { SystemAddress: 1234, StarSystem: 'Nervi' }), bodies);
    expect(t.state).not.toBeNull();
  });
});

describe('what does reset a run', () => {
  it('leaving the system abandons it', () => {
    // Measured: FSDJump never appears between the stages of one organism in 83
    // runs, which is what makes this a signal rather than a guess.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    expect(t.observe(ev('FSDJump', { SystemAddress: 9999, StarSystem: 'Sol' }), bodies)).toBe(true);
    expect(t.state).toBeNull();
  });

  it('death abandons an unfinished run', () => {
    // Rests on a single corpus observation, documented as such in live.ts.
    // Clearing is the conservative direction.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    expect(t.observe(ev('Died', {}), bodies)).toBe(true);
    expect(t.state).toBeNull();
  });

  it('death does not discard a completed specimen', () => {
    // Analyse already banked the data.
    const t = tracker();
    for (const s of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(s), bodies);
    t.observe(ev('Died', {}), bodies);
    expect(t.state).not.toBeNull();
    expect(t.state!.exobiology.completed).toBe(true);
  });

  it('selling retires a completed specimen', () => {
    const t = tracker();
    for (const s of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(s), bodies);
    expect(t.observe(ev('SellOrganicData', { BioData: [{ Value: 1 }] }), bodies)).toBe(true);
    expect(t.state).toBeNull();
  });

  it('selling does not disturb a run still in progress', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.observe(ev('SellOrganicData', { BioData: [{ Value: 1 }] }), bodies);
    expect(t.state).not.toBeNull();
  });

  it('a commander switch clears it', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.setCommander('F-OTHER');
    expect(t.state).toBeNull();
  });

  it('re-setting the same commander does not clear it', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    t.setCommander('F-TEST');
    expect(t.state).not.toBeNull();
  });
});

describe('the count it refuses to invent', () => {
  it('reports no stage number when the run began before the app was watching', () => {
    /*
     * The reader resumes from a byte offset rather than replaying history, so
     * starting the app midway through a run means the first event seen is a
     * Sample that could be the second or the third.
     *
     * A wrong "1 / 3" would tell the commander they have two samples left when
     * they have one, so no number is claimed at all.
     */
    const t = tracker();
    t.observe(scan('Sample'), bodies);
    const live = t.state!.exobiology;
    expect(live.samplesTaken).toBeNull();
    expect(sampleStageText(live)).toBeNull();
    // It still knows what is being sampled, which is most of the value.
    expect(live.species).toBe('Stratum Tectonicas');
    expect(live.completed).toBe(false);
  });

  it('keeps the count unestablished across further samples', () => {
    const t = tracker();
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Sample'), bodies);
    expect(t.state!.exobiology.samplesTaken).toBeNull();
  });

  it('recovers a definite count on Analyse', () => {
    // Analyse is proof of three samples regardless of what was observed before.
    const t = tracker();
    t.observe(scan('Sample'), bodies);
    t.observe(scan('Analyse'), bodies);
    expect(t.state!.exobiology.samplesTaken).toBe(3);
    expect(sampleStageText(t.state!.exobiology)).toBe('3 / 3');
  });
});

describe('timing', () => {
  it('keeps the start time of the run across its stages', () => {
    const t = tracker();
    t.observe(scan('Log', {}, '2026-09-01T00:00:00Z'), bodies);
    t.observe(scan('Sample', {}, '2026-09-01T00:05:00Z'), bodies);
    expect(t.state!.exobiology.startedAt).toBe('2026-09-01T00:00:00Z');
    expect(t.state!.exobiology.updatedAt).toBe('2026-09-01T00:05:00Z');
  });

  it('does not expire on its own', () => {
    // Measured: the longest gap between two stages of the same organism was
    // 50,313 seconds -- about fourteen hours -- so time is not a signal.
    const t = tracker();
    t.observe(scan('Log', {}, '2026-09-01T00:00:00Z'), bodies);
    t.observe(scan('Sample', {}, '2026-09-01T14:00:00Z'), bodies);
    expect(t.state!.exobiology.samplesTaken).toBe(2);
  });
});

/* ------------------------------------------------------------ genus roster */

const BACTERIAL = '$Codex_Ent_Bacterial_Genus_Name;';
const STRATUM = '$Codex_Ent_Stratum_Genus_Name;';

/** A detailed surface scan, in the shape the corpus writes. */
function dss(genera: readonly [string, string][], bodyId = 12, systemAddress = 1234) {
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

describe('the genus roster', () => {
  it('lists an unsampled genus as unscanned alongside a completed one', () => {
    /*
     * The case this exists for, and it is a real one: the corpus body
     * `Wregoe LS-N b51-0 A 7 g` has two genera, one completed and one never
     * touched. Before this, the overlay could only show the finished specimen,
     * so nothing on screen said another organism was still down there.
     */
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    for (const st of ['Log', 'Sample', 'Sample', 'Analyse']) t.observe(scan(st), bodies);

    const live = t.state!.exobiology;
    expect(live.genera.map((g) => [g.genus, g.status])).toEqual([
      ['Stratum', 'complete'],
      ['Bacterium', 'unscanned'],
    ]);
    expect(live.unscannedCount).toBe(1);
  });

  it('marks the genus being sampled right now', () => {
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.observe(scan('Log'), bodies);
    t.observe(scan('Sample'), bodies);

    const rows = t.state!.exobiology.genera;
    expect(rows.find((g) => g.genus === 'Stratum')).toMatchObject({
      status: 'sampling',
      samplesTaken: 2,
    });
    expect(rows.find((g) => g.genus === 'Bacterium')?.status).toBe('unscanned');
  });

  it('keeps the scan order the game reported', () => {
    const t = tracker();
    t.observe(dss([[BACTERIAL, 'Bacterium'], [STRATUM, 'Stratum']]), bodies);
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera.map((g) => g.genus)).toEqual(['Bacterium', 'Stratum']);
  });

  it('merges a repeat surface scan rather than duplicating it', () => {
    // Measured: 17 of 60 bodies were scanned more than once.
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera).toHaveLength(2);
  });

  it('is empty when the body was never surface-scanned', () => {
    // Honest absence: with no scan there is no list, and an empty roster is not a
    // claim that nothing else is down there.
    const t = tracker();
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera).toEqual([]);
    expect(t.state!.exobiology.unscannedCount).toBe(0);
  });

  it('does not borrow another body roster', () => {
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']], 99), bodies);
    t.observe(scan('Log'), bodies); // body 12
    expect(t.state!.exobiology.genera).toEqual([]);
  });

  it('updates the roster when the body is scanned mid-run', () => {
    const t = tracker();
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera).toEqual([]);
    expect(t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies)).toBe(true);
    expect(t.state!.exobiology.genera).toHaveLength(2);
  });

  it('counts every remaining genus, not just one', () => {
    const t = tracker();
    t.observe(
      dss([
        [STRATUM, 'Stratum'],
        [BACTERIAL, 'Bacterium'],
        ['$Codex_Ent_Osseus_Genus_Name;', 'Osseus'],
        ['$Codex_Ent_Tussocks_Genus_Name;', 'Tussock'],
      ]),
      bodies,
    );
    t.observe(scan('Log'), bodies);
    // Three untouched; the fourth is being sampled.
    expect(t.state!.exobiology.unscannedCount).toBe(3);
  });

  it('shows the specimen in hand even if no scan listed its genus', () => {
    // Never observed in the corpus, but reporting a specimen the commander is
    // visibly holding would be worse than a roster one row longer.
    const t = tracker();
    t.observe(dss([[BACTERIAL, 'Bacterium']]), bodies);
    t.observe(scan('Log'), bodies); // Stratum, which the scan did not list
    const rows = t.state!.exobiology.genera;
    expect(rows.map((g) => g.genus)).toContain('Stratum');
    expect(rows.find((g) => g.genus === 'Stratum')?.status).toBe('sampling');
  });
});

describe('what the roster will not claim', () => {
  it('does not call a genus unscanned when history says it was done', () => {
    /*
     * The reader resumes from a byte offset rather than replaying, so a specimen
     * collected in an earlier session leaves no trace in memory. Saying
     * "unscanned" about something already finished would be a confident wrong
     * answer, so completions are seeded from the durable Journal.
     */
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.seedCompleted(1234, 12, [BACTERIAL]);
    t.observe(scan('Log'), bodies);

    const rows = t.state!.exobiology.genera;
    expect(rows.find((g) => g.genus === 'Bacterium')?.status).toBe('complete');
    expect(t.state!.exobiology.unscannedCount).toBe(0);
  });

  it('applies a seed that arrives after the run has started', () => {
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.unscannedCount).toBe(1);
    t.seedCompleted(1234, 12, [BACTERIAL]);
    expect(t.state!.exobiology.unscannedCount).toBe(0);
  });

  it('matches on the journal token, not the localised name', () => {
    /*
     * The two agreed on all 11 genera measured, but the token is the
     * language-independent identifier. A client running in another language must
     * still match.
     */
    const t = tracker();
    t.observe(dss([[BACTERIAL, 'Bakterium']]), bodies);
    t.seedCompleted(1234, 12, [BACTERIAL]);
    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera.find((g) => g.token === BACTERIAL)?.status).toBe('complete');
  });
});

describe('body knowledge outlives a run', () => {
  it('keeps the surface scan when a run is abandoned', () => {
    // What the scan reported is knowledge about the body, not about the run, and
    // it does not become false when a sample is given up. Re-acquiring it would
    // need another scan.
    const t = tracker();
    t.observe(dss([[STRATUM, 'Stratum'], [BACTERIAL, 'Bacterium']]), bodies);
    t.observe(scan('Log'), bodies);
    t.observe(ev('Died', {}), bodies);
    expect(t.state).toBeNull();

    t.observe(scan('Log'), bodies);
    expect(t.state!.exobiology.genera).toHaveLength(2);
  });
});
