/**
 * Live exobiology replayed against the real corpus.
 *
 * The design rests on measurements — that a sample run is
 * `Log, Sample, Sample, Analyse` and not three events, and that a surface scan's
 * genus list can be matched to what gets sampled — so those are asserted against
 * what the game actually wrote rather than only against fixtures shaped by the
 * same belief that produced the code.
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
import { LiveActivityTracker, SAMPLES_REQUIRED, rowStatus } from '../src/live.js';
import type { ActivityEntry } from '../src/types.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

interface Replay {
  readonly completedRuns: number[][];
  readonly analyseCount: number;
  readonly logCount: number;
  readonly sampleCount: number;
  readonly entries: ActivityEntry[];
  readonly entriesFromIntermediateScans: number;
  readonly everExceededRequired: boolean;
  readonly biggestRoster: number;
  readonly bodiesWithUnscanned: number;
  readonly bodiesFullyDone: number;
  readonly rowsMissingGenus: number;
  /** Rows shown as unscanned that nonetheless carried a species name. */
  readonly unscannedWithSpecies: number;
}

/**
 * Replay, persisting nothing.
 *
 * The tracker asks for stored rows on arrival; there is no store here, so every
 * body starts from what the journal itself says. That is the harder case and the
 * one worth testing.
 */
async function replay(maxFiles = 80): Promise<Replay> {
  const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0).slice(-maxFiles);

  const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
  const live = new LiveActivityTracker({ commanderFid: 'F-TEST' });

  const completedRuns: number[][] = [];
  const perGenusStages = new Map<string, number[]>();
  let analyseCount = 0;
  let logCount = 0;
  let sampleCount = 0;
  let entriesFromIntermediateScans = 0;
  let everExceededRequired = false;
  let biggestRoster = 0;
  let rowsMissingGenus = 0;
  let unscannedWithSpecies = 0;
  const bodiesUnscanned = new Set<string>();
  const bodiesDone = new Set<string>();
  const entries: ActivityEntry[] = [];

  for (const file of files) {
    const result = await replayFile(file.fullPath);
    for (const event of result.events) {
      const produced = engine.observe(event);
      entries.push(...produced);

      live.observe(event, engine.bodyNameMap);
      // Drained as the app does, so nothing accumulates unboundedly.
      live.takeHydrationRequest();
      live.takeDirtyRows();

      const raw = event.source.raw as Record<string, unknown>;
      if (event.source.event === 'ScanOrganic') {
        const scanType = raw['ScanType'];
        if (scanType === 'Log') logCount += 1;
        if (scanType === 'Sample') sampleCount += 1;
        if (scanType === 'Analyse') analyseCount += 1;

        // The invariant: a step toward a specimen never becomes history.
        if (scanType === 'Log' || scanType === 'Sample') {
          entriesFromIntermediateScans += produced.length;
        }

        const e = live.state?.exobiology;
        const genus = raw['Genus'];
        if (e && typeof genus === 'string') {
          const key = `${e.systemAddress}|${e.bodyId}|${genus}`;
          const r = e.rows.find((x) => x.genusToken === genus);
          if (r) {
            if (r.samplesTaken !== null && r.samplesTaken > r.samplesRequired) {
              everExceededRequired = true;
            }
            if (scanType === 'Log') perGenusStages.set(key, []);
            const list = perGenusStages.get(key) ?? [];
            if (r.samplesTaken !== null && r.samplesTaken > 0) list.push(r.samplesTaken);
            perGenusStages.set(key, list);
            if (r.completed) {
              completedRuns.push([...list]);
              perGenusStages.delete(key);
            }
          }
        }
      }

      const e = live.state?.exobiology;
      if (e) {
        biggestRoster = Math.max(biggestRoster, e.rows.length);
        const key = `${e.systemAddress}|${e.bodyId}`;
        if (e.unscannedCount > 0) bodiesUnscanned.add(key);
        if (e.total > 0 && e.completedCount === e.total) bodiesDone.add(key);
        for (const r of e.rows) {
          if (!r.genus) rowsMissingGenus += 1;
          if (rowStatus(r) === 'unscanned' && r.species !== null) unscannedWithSpecies += 1;
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
    biggestRoster,
    bodiesWithUnscanned: bodiesUnscanned.size,
    bodiesFullyDone: bodiesDone.size,
    rowsMissingGenus,
    unscannedWithSpecies,
  };
}

suite('live exobiology against the real corpus', () => {
  it('every completed specimen climbs 1, 2, 3 and stops', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return; // this commander has never completed a scan

    expect(r.completedRuns.length).toBeGreaterThan(0);
    for (const stages of r.completedRuns) {
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
     * The measurement the whole design rests on. If the sequence were
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

  it('writes no durable entry for an intermediate stage', async () => {
    const r = await replay();
    if (r.analyseCount === 0) return;

    /*
     * The durable record stays concise: one entry per completed specimen, none
     * for the steps. Measured, this suppresses 243 of the 323 scans.
     */
    expect(r.entriesFromIntermediateScans).toBe(0);
    expect(r.logCount + r.sampleCount).toBeGreaterThan(0);

    const completed = r.entries.filter((e) => e.subtype === 'sample-completed');
    expect(completed).toHaveLength(r.analyseCount);
  }, 120_000);

  it('still records other activity that happens during a run', async () => {
    /*
     * The complement. Surface-scanning another body while a run is open is a
     * separate accomplishment, and three of them occur in this corpus.
     */
    const r = await replay();
    if (r.analyseCount === 0) return;
    expect(r.entries.filter((e) => e.subtype === 'signals-detected').length).toBeGreaterThan(0);
  }, 120_000);

  it('builds rosters from real surface scans, within bounds', async () => {
    const r = await replay();
    expect(r.biggestRoster).toBeGreaterThan(0);
    // The largest genus list measured on one body was 8.
    expect(r.biggestRoster).toBeLessThanOrEqual(16);
    expect(r.rowsMissingGenus).toBe(0);
  }, 120_000);

  it('finds both bodies still owing work and bodies finished', async () => {
    /*
     * Both states this feature exists to show. Of 60 bodies with a genus list in
     * the corpus, 47 were finished, 6 partially worked and 7 untouched.
     */
    const r = await replay();
    expect(r.bodiesWithUnscanned).toBeGreaterThan(0);
    expect(r.bodiesFullyDone).toBeGreaterThan(0);
  }, 120_000);

  it('never names a species on a row nothing has been collected from', async () => {
    // A surface scan reports a genus and nothing finer.
    const r = await replay();
    expect(r.unscannedWithSpecies).toBe(0);
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
