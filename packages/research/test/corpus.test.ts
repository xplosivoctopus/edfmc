/**
 * The session tracker against the real journal corpus.
 *
 * This is the test that matters. The unit tests prove the tracker does what I
 * told it to; this proves what it does to a real commander's history, and it is
 * how the numbers quoted throughout the project definition were established.
 *
 * Reads the live journal directory rather than committed fixtures: journals
 * carry commander identity, travel history and finances, and §21 forbids
 * redistributing that. Skips automatically where there is no journal directory,
 * so other machines and CI stay green.
 *
 * Override with EDFM_JOURNAL_DIR.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';
import type { CommanderState } from '@edfm/elite-journal';

import { SessionTracker, isPlausible } from '../src/session.js';
import { groupBy, itemTally, summarise } from '../src/quality.js';
import { SETTLEMENT_MATERIALS } from '../src/projects/settlement-materials.js';
import type { ObservedSession } from '../src/types.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

const state = {} as CommanderState;
let cached: ObservedSession[] | null = null;

async function allSessions(): Promise<ObservedSession[]> {
  if (cached !== null) return cached;

  const tracker = new SessionTracker({
    project: SETTLEMENT_MATERIALS,
    companionVersion: 'test',
  });

  const files = await listJournalFiles(DIR);
  for (const file of files) {
    const { events } = await replayFile(file.fullPath);
    for (const event of events) tracker.observe(event, state);
  }
  // Whatever is still open at the end of the corpus is genuinely unfinished.
  tracker.finish();

  cached = [...tracker.sessions()];
  return cached;
}

suite('settlement sessions across the real corpus', () => {
  it('reconstructs settlement visits', async () => {
    const sessions = await allSessions();
    // Cross-checked against an independent pass over the same corpus. That
    // pass initially reported 48, but it re-used a single captured approach
    // indefinitely -- the widest approach-to-disembark gap it accepted was 3.9
    // days. Bounded to the same 30-minute window this tracker uses, it agrees
    // at 30. The number drifts as the commander plays, so this asserts only
    // that sessions are found.
    expect(sessions.length).toBeGreaterThan(10);
    console.log(`sessions: ${sessions.length}`);
  }, 120_000);

  it('links every session to a named settlement', async () => {
    const sessions = await allSessions();
    // The whole point of requiring a body match: a session with no settlement
    // is an ordinary station walk that leaked into the corpus.
    for (const s of sessions) {
      expect(s.context.settlementName).not.toBeNull();
      expect(s.context.systemAddress).not.toBeNull();
    }
  }, 120_000);

  it('never invents a field the game did not report', async () => {
    const sessions = await allSessions();
    // Allegiance is present on 47.8% of ApproachSettlement. If none of the
    // sessions has a null allegiance, something is fabricating it.
    const withNull = sessions.filter((s) => s.context.allegiance === null);
    expect(withNull.length).toBeGreaterThan(0);
    // And economy, at 100% presence, should essentially always be there.
    const missingEconomy = sessions.filter((s) => s.context.economy === null);
    expect(missingEconomy.length).toBe(0);
  }, 120_000);

  it('ends sessions the ways the game actually ends them', async () => {
    const sessions = await allSessions();
    const reasons = new Set(sessions.map((s) => s.endEvent));
    // Measured: 27 Embark, 2 Died, 1 Liftoff. Embark must dominate.
    expect(reasons.has('Embark')).toBe(true);
    const embarks = sessions.filter((s) => s.endEvent === 'Embark').length;
    expect(embarks / sessions.length).toBeGreaterThan(0.5);
    console.log('end events:', [...reasons].join(', '));
  }, 120_000);

  it('does not double-count collections', async () => {
    const sessions = await allSessions();
    const total = sessions.reduce(
      (n, s) => n + s.observations.reduce((m, o) => m + o.count, 0),
      0,
    );
    // 248 observations across 30 sessions when measured. If this were reading
    // BackpackChange as well it would be close to double, since 258 of 281
    // collections appear in both sources. Bounded rather than exact, since the
    // corpus grows.
    expect(total).toBeGreaterThan(0);
    const perSession = total / sessions.length;
    expect(perSession).toBeLessThan(40);
    console.log(`observations: ${total} across ${sessions.length} sessions`);
  }, 120_000);

  it('every observation names a real item and a category', async () => {
    const sessions = await allSessions();
    for (const s of sessions) {
      for (const o of s.observations) {
        expect(o.name).toMatch(/^[a-z0-9_]+$/);
        expect(o.count).toBeGreaterThan(0);
        // Measured: Type is on 100% of CollectItems.
        expect(o.category).not.toBeNull();
        expect(o.sourceEventId).toContain(':');
      }
    }
  }, 120_000);

  it('leaves completeness unknown for every session', async () => {
    const sessions = await allSessions();
    // Nothing infers it, and nothing prompted the commander.
    expect(sessions.every((s) => s.completeness === 'unknown')).toBe(true);
  }, 120_000);
});

suite('what this corpus can and cannot support', () => {
  it('refuses to present rates from a single commander', async () => {
    const sessions = await allSessions();
    const summary = summarise(sessions, SETTLEMENT_MATERIALS);

    console.log(
      `usable ${summary.sampleSize}, commanders ${summary.uniqueCommanders}, ` +
        `settlements ${summary.distinctLocations}, systems ${summary.distinctSystems}`,
    );
    console.log('excluded:', JSON.stringify(summary.excluded));

    // The point of §13, demonstrated on real data: this whole corpus is 26
    // usable sessions across 12 settlements, and the summary refuses to turn
    // that into a percentage rather than drawing a chart from it.
    //
    // Not asserted as one commander: this machine's corpus contains two of them,
    // which is exactly why the field is counted rather than assumed.
    expect(summary.uniqueCommanders).toBeGreaterThanOrEqual(1);
    expect(summary.sufficientForRates).toBe(false);
    expect(summary.caveat).toContain('rates are not');
  }, 120_000);

  it('reports counts per economy without computing a rate', async () => {
    const sessions = await allSessions();
    const groups = groupBy(sessions, SETTLEMENT_MATERIALS, 'economy');
    expect(groups.length).toBeGreaterThan(0);

    for (const g of groups) {
      console.log(
        `${g.group}: ${g.sessions} sessions, ${g.sessionsWithObservations} with items, ` +
          `${g.distinctLocations} settlements`,
      );
      // Raw counts always available; the denominator is never hidden.
      expect(g.sessions).toBeGreaterThan(0);
      expect(g.sessionsWithObservations).toBeLessThanOrEqual(g.sessions);
    }
  }, 120_000);

  it('counts implausible sessions rather than silently dropping them', async () => {
    const sessions = await allSessions();
    const summary = summarise(sessions, SETTLEMENT_MATERIALS);
    const usable = sessions.filter((s) => isPlausible(s, SETTLEMENT_MATERIALS));

    // Measured: 4 of 30 ran under a minute and 2 ended in death. They are
    // excluded from rates but still present in the record, so the exclusion is
    // visible and countable rather than silent.
    expect(usable.length).toBeLessThan(sessions.length);
    expect(summary.excluded.implausiblyShort).toBeGreaterThan(0);
  }, 120_000);

  it('tallies items by session count, not just totals', async () => {
    const sessions = await allSessions();
    const items = itemTally(sessions, SETTLEMENT_MATERIALS);
    for (const item of items.slice(0, 8)) {
      console.log(`${item.name} (${item.category}): ${item.sessions} sessions, ${item.total} total`);
      expect(item.total).toBeGreaterThanOrEqual(item.sessions);
    }
  }, 120_000);
});
