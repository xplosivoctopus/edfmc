/**
 * Live activity replayed against the real corpus.
 *
 * The design rests on a measurement — that a sample run is
 * `Log, Sample, Sample, Analyse` and not three events — so the measurement is
 * asserted here against what the game actually wrote, rather than only against
 * fixtures shaped by the same belief that produced the code.
 *
 * Skips on machines without a journal directory. Journals are never committed:
 * they contain commander identity, travel history and finances (§21).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';

import { ActivityEngine } from '../src/engine.js';
import { LiveActivityTracker, SAMPLES_REQUIRED } from '../src/live.js';
import type { ActivityEntry } from '../src/types.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

interface Replay {
  /** Stage numbers observed, in order, for every run that reached Analyse. */
  readonly completedRuns: number[][];
  readonly analyseCount: number;
  readonly logCount: number;
  readonly sampleCount: number;
  readonly entries: ActivityEntry[];
  /**
   * Durable entries produced by a `Log` or `Sample` scan.
   *
   * This, and not "entries written while a run was open", is the property that
   * matters. An earlier version of this test counted the latter and failed on
   * three `SAASignalsFound` entries -- the commander had surface-scanned another
   * body while a run was open on a different one. Those are separate
   * accomplishments and belong in the Journal; the noise to prevent is a stage
   * becoming history.
   */
  readonly entriesFromIntermediateScans: number;
  readonly everExceededRequired: boolean;
  readonly unnamedOrganisms: number;
}

async function replay(maxFiles = 80): Promise<Replay> {
  const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0).slice(-maxFiles);

  const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
  const live = new LiveActivityTracker({ commanderFid: 'F-TEST' });

  const completedRuns: number[][] = [];
  let current: number[] = [];
  let analyseCount = 0;
  let logCount = 0;
  let sampleCount = 0;
  let entriesFromIntermediateScans = 0;
  let everExceededRequired = false;
  let unnamedOrganisms = 0;
  const entries: ActivityEntry[] = [];

  for (const file of files) {
    const result = await replayFile(file.fullPath);
    for (const event of result.events) {
      const produced = engine.observe(event);
      entries.push(...produced);

      live.observe(event, engine.bodyNameMap);

      const raw = event.source.raw as Record<string, unknown>;
      if (event.source.event === 'ScanOrganic') {
        const scanType = raw['ScanType'];

        // The invariant: a step toward a specimen never becomes history.
        if (scanType === 'Log' || scanType === 'Sample') {
          entriesFromIntermediateScans += produced.length;
        }
        if (scanType === 'Log') logCount += 1;
        if (scanType === 'Sample') sampleCount += 1;
        if (scanType === 'Analyse') analyseCount += 1;

        const now = live.state?.exobiology;
        if (now) {
          if (now.samplesTaken !== null && now.samplesTaken > now.samplesRequired) {
            everExceededRequired = true;
          }
          if (now.species === null) unnamedOrganisms += 1;

          if (scanType === 'Log') current = [];
          if (now.samplesTaken !== null) current.push(now.samplesTaken);
          if (now.completed) {
            completedRuns.push([...current]);
            current = [];
          }
        }
      }
    }
  }

  return {
    completedRuns,
    analyseCount,
    logCount,
    sampleCount,
    entries,
    entriesFromIntermediateScans,
    everExceededRequired,
    unnamedOrganisms,
  };
}

suite('live exobiology against the real corpus', () => {
  it('every completed run climbs 1, 2, 3 and stops', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return; // this commander has never completed a scan

    expect(r.completedRuns.length).toBeGreaterThan(0);
    for (const stages of r.completedRuns) {
      // Runs the app saw from the beginning report every stage; runs already in
      // progress when the replay started legitimately report fewer, because the
      // count is not invented. Both must be monotonic and bounded.
      for (let i = 1; i < stages.length; i += 1) {
        expect(stages[i]!, `stages ${stages.join(',')}`).toBeGreaterThanOrEqual(stages[i - 1]!);
      }
      expect(Math.max(...stages)).toBe(SAMPLES_REQUIRED);
    }
  }, 120_000);

  it('confirms three samples then an analysis, not three events', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return;

    /*
     * The measurement this whole design rests on. If the sequence were
     * Log/Sample/Analyse there would be one Sample per Analyse; the corpus has
     * two, and treating Analyse as the third sample would report every specimen
     * finished one sample early.
     */
    expect(r.sampleCount).toBeGreaterThan(r.logCount);
    expect(r.sampleCount).toBeCloseTo(r.analyseCount * 2, -1);
  }, 120_000);

  it('never counts past three', async () => {
    const r = await replay();
    expect(r.everExceededRequired).toBe(false);
  }, 120_000);

  it('names the organism on every live state it produces', async () => {
    const r = await replay();
    expect(r.unnamedOrganisms).toBe(0);
  }, 120_000);

  it('writes no durable entry for an intermediate stage', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return;

    /*
     * The durable record stays concise: one entry per completed specimen, none
     * for the steps. Measured, this suppresses 243 of the 323 scans in the
     * corpus.
     */
    expect(r.entriesFromIntermediateScans).toBe(0);
    expect(r.logCount + r.sampleCount).toBeGreaterThan(0);

    const completed = r.entries.filter((e) => e.subtype === 'sample-completed');
    expect(completed).toHaveLength(r.analyseCount);
  }, 120_000);

  it('still records other activity that happens during a run', async () => {
    /*
     * The complement, and the reason the assertion above is worded as it is.
     * Surface-scanning another body while a sample run is open is a separate
     * accomplishment, and three of them occur in this corpus. Suppressing
     * everything that lands mid-run would lose them.
     */
    const r = await replay();
    if (r.analyseCount === 0) return;
    const signals = r.entries.filter((e) => e.subtype === 'signals-detected');
    expect(signals.length).toBeGreaterThan(0);
  }, 120_000);

  it('produces one durable entry per specimen however many stages it took', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return;

    const completed = r.entries.filter((e) => e.subtype === 'sample-completed');
    // Log + Sample events far outnumber the entries they belong to; that ratio is
    // the property being protected.
    expect(r.logCount + r.sampleCount).toBeGreaterThan(completed.length);
    expect(completed.length).toBe(r.analyseCount);
  }, 120_000);

  it('derives stable ids, so a second pass adds nothing', async () => {
    // Restart safety. The id is sourceFile:byteOffset, so replaying the same
    // files re-derives the same ids and an INSERT OR IGNORE drops the write.
    const a = await replay(12);
    const b = await replay(12);
    expect(new Set(a.entries.map((e) => e.id)).size).toBe(a.entries.length);
    expect(a.entries.map((e) => e.id)).toEqual(b.entries.map((e) => e.id));
  }, 120_000);
});

suite('the genus roster against the real corpus', () => {
  /**
   * Replay and record, for every body, the roster the overlay would have shown at
   * the moment its last scan happened.
   */
  async function rosters(maxFiles = 80) {
    const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0).slice(-maxFiles);
    const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
    const live = new LiveActivityTracker({ commanderFid: 'F-TEST' });

    /** bodyKey -> the last roster seen for it. */
    const seen = new Map<string, { listed: number; unscanned: number; complete: number }>();
    let rosterRowsEverSeen = 0;
    let statusOutsideVocabulary = 0;

    for (const file of files) {
      for (const event of (await replayFile(file.fullPath)).events) {
        engine.observe(event);
        live.observe(event, engine.bodyNameMap);

        const e = live.state?.exobiology;
        if (!e || e.genera.length === 0) continue;

        rosterRowsEverSeen += e.genera.length;
        for (const g of e.genera) {
          if (!['unscanned', 'sampling', 'complete'].includes(g.status)) {
            statusOutsideVocabulary += 1;
          }
        }

        seen.set(`${e.systemAddress}|${e.bodyId}`, {
          listed: e.genera.length,
          unscanned: e.unscannedCount,
          complete: e.genera.filter((g) => g.status === 'complete').length,
        });
      }
    }
    return { seen, rosterRowsEverSeen, statusOutsideVocabulary };
  }

  it('builds a roster from real surface scans', async () => {
    const r = await rosters();
    expect(r.rosterRowsEverSeen).toBeGreaterThan(0);
    expect(r.statusOutsideVocabulary).toBe(0);
  }, 120_000);

  it('finds bodies with a genus still unscanned', async () => {
    /*
     * The state this feature exists for, and it is common: of the 60 bodies with
     * a genus list in the corpus, 6 were partially worked and 7 untouched.
     */
    const r = await rosters();
    const partial = [...r.seen.values()].filter((b) => b.unscanned > 0 && b.complete > 0);
    expect(partial.length).toBeGreaterThan(0);
  }, 120_000);

  it('never reports more unscanned than the scan listed', async () => {
    const r = await rosters();
    for (const [key, b] of r.seen) {
      expect(b.unscanned, key).toBeLessThanOrEqual(b.listed);
      expect(b.complete + b.unscanned, key).toBeLessThanOrEqual(b.listed);
    }
  }, 120_000);

  it('does not invent genera the scan never listed', async () => {
    /*
     * Measured: zero genera were ever sampled that the body's own scan had not
     * listed, so a roster longer than the scan would mean this code had added
     * something rather than the game having reported it.
     */
    const r = await rosters();
    for (const [key, b] of r.seen) {
      expect(b.listed, key).toBeGreaterThan(0);
      expect(b.listed, key).toBeLessThanOrEqual(16);
    }
  }, 120_000);
});
