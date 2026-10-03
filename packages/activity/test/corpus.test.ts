/**
 * Activity reconstruction against the real journal corpus.
 *
 * Fixtures confirm what their author already believed. These replay what the
 * game actually wrote, which is where an activity model that reads well on paper
 * turns out to produce nonsense — or nothing at all — on real data.
 *
 * Skips on machines without a journal directory. Journals are never committed:
 * they contain commander identity, travel history and finances (§21).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';

import { ActivityEngine, groupActivity, type ActivityEntry } from '../src/index.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

/** Replay the corpus once and reuse it; each file is parsed exactly one time. */
async function rebuild(maxFiles = 80): Promise<{
  entries: ActivityEntry[];
  organicAnalyse: number;
  touchdownsOnPlanet: number;
  disembarksOnPlanet: number;
}> {
  const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0).slice(-maxFiles);
  const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
  const entries: ActivityEntry[] = [];
  let organicAnalyse = 0;
  let touchdownsOnPlanet = 0;
  let disembarksOnPlanet = 0;

  for (const file of files) {
    const result = await replayFile(file.fullPath);
    for (const event of result.events) {
      const raw = event.source.raw as Record<string, unknown>;
      if (event.source.event === 'ScanOrganic' && raw['ScanType'] === 'Analyse') organicAnalyse += 1;
      if (
        event.source.event === 'Touchdown' &&
        raw['OnPlanet'] === true &&
        raw['PlayerControlled'] !== false
      ) {
        touchdownsOnPlanet += 1;
      }
      if (
        event.source.event === 'Disembark' &&
        raw['OnPlanet'] === true &&
        raw['OnStation'] !== true
      ) {
        disembarksOnPlanet += 1;
      }
      entries.push(...engine.observe(event));
    }
  }
  return { entries, organicAnalyse, touchdownsOnPlanet, disembarksOnPlanet };
}

suite('activity reconstruction from the real corpus', () => {
  it('produces one entry per completed sample, and none for the steps', async () => {
    const { entries, organicAnalyse } = await rebuild();
    if (organicAnalyse === 0) return; // this commander has never completed a scan

    const completed = entries.filter((e) => e.subtype === 'sample-completed');
    expect(completed).toHaveLength(organicAnalyse);

    // Every one names an organism rather than falling back to Unknown, which
    // would mean the variant split does not survive real data.
    const unnamed = completed.filter((e) => e.title === 'Unknown organism');
    expect(unnamed, `${unnamed.length} samples produced no organism name`).toHaveLength(0);
  }, 120_000);

  it('keeps the journal to milestones rather than every landing', async () => {
    const { entries, touchdownsOnPlanet } = await rebuild();
    if (touchdownsOnPlanet === 0) return;

    // The regression this replaced: an entry per touchdown. Nothing may record
    // a plain landing any more.
    expect(entries.filter((e) => e.subtype === 'landed')).toHaveLength(0);

    // Nor footfall, which was removed at the commander's request.
    expect(entries.filter((e) => e.subtype === 'footfall')).toHaveLength(0);
  }, 120_000);

  it('resolves body names for most real samples', async () => {
    // ScanOrganic reports a BodyID, so a name exists only when something else
    // mentioned that body first. This asserts the resolution is actually working
    // in practice, not merely in a fixture where the Scan was placed first.
    const { entries, organicAnalyse } = await rebuild();
    if (organicAnalyse === 0) return;

    const completed = entries.filter((e) => e.subtype === 'sample-completed');
    const named = completed.filter((e) => e.bodyName !== null);
    expect(named.length).toBeGreaterThan(0);
    // Not asserted as all: a commander who scanned before the app ever saw the
    // body genuinely has no name to show, and null is the honest answer.
  }, 120_000);

  it('gives every entry a unique, replay-stable id', async () => {
    // Deduplication depends entirely on this. A collision would silently merge
    // two real activities; instability would duplicate them on every restart.
    const first = await rebuild(40);
    if (first.entries.length === 0) return;

    const ids = new Set(first.entries.map((e) => e.id));
    expect(ids.size).toBe(first.entries.length);

    const second = await rebuild(40);
    expect(second.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
  }, 180_000);

  it('groups real activity by system and body without exploding', async () => {
    const { entries } = await rebuild(40);
    if (entries.length === 0) return;

    const groups = groupActivity(entries);
    expect(groups.length).toBeGreaterThan(0);
    // Grouping must actually group: one group per entry would mean the system or
    // body association is not working on real data.
    expect(groups.length).toBeLessThan(entries.length);

    for (const g of groups) {
      expect(g.entries.length).toBeGreaterThan(0);
      for (let i = 1; i < g.entries.length; i += 1) {
        expect(g.entries[i]!.occurredAt >= g.entries[i - 1]!.occurredAt).toBe(true);
      }
    }
  }, 120_000);

  it('records biological signals only where genera were actually reported', async () => {
    const { entries } = await rebuild();
    const signals = entries.filter((e) => e.subtype === 'signals-detected');
    for (const s of signals) {
      const genera = s.data['genera'];
      expect(Array.isArray(genera) && genera.length > 0).toBe(true);
    }
  }, 120_000);

  it('never writes commander-identifying content into an entry title', async () => {
    // Titles are the thing most likely to end up in a log line or a screenshot.
    const { entries } = await rebuild(40);
    for (const e of entries) {
      expect(e.title).not.toContain('F-TEST');
      expect(e.title.length).toBeLessThanOrEqual(120);
    }
  }, 120_000);
});
