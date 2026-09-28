/**
 * Context rules evaluated against the real journal corpus.
 *
 * Unit tests use fixtures chosen to exercise a rule, which means they confirm what
 * the author already believed. This replays everything the game actually wrote, and
 * is where rules that fire on a *superset* of what their name suggests get caught.
 *
 * Skips automatically on machines without a journal directory. Journals are never
 * committed: they contain commander identity, travel history and finances (§21).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyEvent, initialState, listJournalFiles, replayFile } from '@edfm/elite-journal';
// Registers the Node filesystem adapter. The engine is host-agnostic so the same
// pipeline runs under Tauri; under Node the adapter has to be imported explicitly.
import '@edfm/elite-journal/node';

import { BUNDLED_RULES } from '../src/defaults.js';
import { evaluate } from '../src/evaluate.js';
import { renderTemplate } from '../src/template.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

suite('bundled rules against the real corpus', () => {
  it('fires the ring-scan rule for rings and nothing else', async () => {
    // The regression. SAASignalsFound fires for every detailed surface scan, so a
    // rule keyed on the event name announced "Ring scanned -- hotspot signals
    // found" after DSS-ing a planet. Measured 198 events, 29 of them rings.
    const rule = BUNDLED_RULES.rules.find((r) => r.id === 'mining-ring-scan');
    expect(rule).toBeDefined();

    const files = await listJournalFiles(DIR);
    const state = initialState();

    let rings = 0;
    let planets = 0;
    const wrong: string[] = [];

    for (const f of files.filter((x) => x.sizeBytes > 0)) {
      const result = await replayFile(f.fullPath);
      for (const event of result.events) {
        if (event.source.event !== 'SAASignalsFound') continue;

        const raw = event.source.raw as Record<string, unknown>;
        const body = String(raw['BodyName'] ?? '');
        const isRing = body.endsWith('Ring');
        if (isRing) rings += 1;
        else planets += 1;

        const matched = evaluate(rule!.when, { event, state });
        if (matched !== isRing) wrong.push(`${body} -> matched=${matched}, isRing=${isRing}`);
      }
    }

    if (rings + planets === 0) return; // this commander has never run a DSS

    expect(wrong, `misclassified:\n${wrong.slice(0, 10).join('\n')}`).toHaveLength(0);
    // Both kinds must be present, or the test proves nothing about discrimination.
    expect(rings).toBeGreaterThan(0);
    expect(planets).toBeGreaterThan(0);
  });

  it('classifies every real planet scan the way the payload says', async () => {
    // The planet rules exist because 169 of 198 surface scans are not rings. They
    // are only worth having if they agree with the data on every one of them.
    const bio = BUNDLED_RULES.rules.find((r) => r.id === 'planet-biological-signals');
    const mining = BUNDLED_RULES.rules.find((r) => r.id === 'planet-surface-mining');
    expect(bio).toBeDefined();
    expect(mining).toBeDefined();

    const files = await listJournalFiles(DIR);
    const state = initialState();

    let bioExpected = 0;
    let miningExpected = 0;
    const wrong: string[] = [];

    for (const f of files.filter((x) => x.sizeBytes > 0)) {
      const result = await replayFile(f.fullPath);
      for (const event of result.events) {
        if (event.source.event !== 'SAASignalsFound') continue;

        const raw = event.source.raw as Record<string, unknown>;
        const signals = Array.isArray(raw['Signals']) ? (raw['Signals'] as unknown[]) : [];
        const genuses = Array.isArray(raw['Genuses']) ? (raw['Genuses'] as unknown[]) : [];
        const body = String(raw['BodyName'] ?? '');

        const hasGenera = genuses.length > 0;
        const hasMining = signals.some(
          (sig) => String((sig as Record<string, unknown>)['Type']) === '$PlanetaryMiningLocation_Name;',
        );
        if (hasGenera) bioExpected += 1;
        if (hasMining) miningExpected += 1;

        const gotBio = evaluate(bio!.when, { event, state });
        const gotMining = evaluate(mining!.when, { event, state });
        if (gotBio !== hasGenera) wrong.push(`bio: ${body} -> ${gotBio}, expected ${hasGenera}`);
        if (gotMining !== hasMining) {
          wrong.push(`mining: ${body} -> ${gotMining}, expected ${hasMining}`);
        }
      }
    }

    if (bioExpected + miningExpected === 0) return;
    expect(wrong, 'misclassified: ' + wrong.slice(0, 10).join(' / ')).toHaveLength(0);
    expect(bioExpected).toBeGreaterThan(0);
    expect(miningExpected).toBeGreaterThan(0);
  });

  it('renders a grammatical biological subtitle for every real scan', async () => {
    // 47 of 105 biological scans have exactly one genus, so a fixed plural would
    // read wrongly on nearly half of them. This checks the rendered sentence on
    // every scan the commander has actually made, rather than a chosen fixture.
    const rule = BUNDLED_RULES.rules.find((r) => r.id === 'planet-biological-signals');
    expect(rule?.subtitle).toBeDefined();

    const files = await listJournalFiles(DIR);
    const state = initialState();
    const rendered = new Set<string>();
    let checked = 0;
    let singular = 0;

    for (const f of files.filter((x) => x.sizeBytes > 0)) {
      const result = await replayFile(f.fullPath);
      for (const event of result.events) {
        if (event.source.event !== 'SAASignalsFound') continue;
        if (!evaluate(rule!.when, { event, state })) continue;

        const text = renderTemplate(rule!.subtitle!, { event, state });
        expect(text, `unrenderable for ${String((event.source.raw as Record<string, unknown>)['BodyName'])}`).not.toBeNull();
        rendered.add(text!);
        checked += 1;

        const n = Number(text!.split(' ')[0]);
        expect(Number.isFinite(n)).toBe(true);
        if (n === 1) {
          singular += 1;
          expect(text).toContain(' signal ');
          expect(text).not.toContain(' signals ');
        } else {
          expect(text).toContain(' signals ');
        }
      }
    }

    if (checked === 0) return;
    // Both forms must occur, or the plural handling is untested by this corpus.
    expect(singular).toBeGreaterThan(0);
    expect(checked - singular).toBeGreaterThan(0);
  });

  it('does not end an activity that is about to continue', async () => {
    /*
     * The check that would have caught the Liftoff mistake.
     *
     * `endsOn` names events that mean "the commander has moved on". Whether an
     * event really means that is a claim about how the game is played, and it is
     * easy to get wrong from the name alone: lifting off looks like leaving and
     * is actually how you travel between exobiology patches. Measured, 169 of 196
     * liftoffs after an organic scan were followed by more scanning.
     *
     * So for every rule that declares endsOn, this replays the real corpus and
     * asks: when the context was ended, how often did the very same activity
     * resume shortly afterwards? A rule that is usually wrong about its own
     * ending is a rule that disappears while it is still wanted.
     */
    const RESUME_WINDOW_MS = 5 * 60 * 1000;

    const withEnders = BUNDLED_RULES.rules.filter((r) => (r.endsOn?.length ?? 0) > 0);
    expect(withEnders.length).toBeGreaterThan(0);

    const files = await listJournalFiles(DIR);
    const state = initialState();

    // Flatten the corpus once; every rule is then evaluated over the same list.
    const events: Array<{ at: number; event: (typeof BUNDLED_RULES.rules)[number] extends never ? never : Parameters<typeof evaluate>[1]['event'] }> = [];
    for (const f of files.filter((x) => x.sizeBytes > 0).slice(-60)) {
      const result = await replayFile(f.fullPath);
      for (const event of result.events) {
        const at = event.source.provenance.timestampMs;
        if (at !== null) events.push({ at, event });
      }
    }
    if (events.length === 0) return;

    const verdicts: string[] = [];
    for (const rule of withEnders) {
      let active = false;
      let premature = 0;
      let genuine = 0;

      for (let i = 0; i < events.length; i += 1) {
        const { at, event } = events[i]!;
        if (evaluate(rule.when, { event, state })) {
          active = true;
          continue;
        }
        if (!active || !rule.endsOn!.includes(event.source.event)) continue;

        // Ended. Did the same activity resume soon after?
        active = false;
        let resumed = false;
        for (let j = i + 1; j < events.length; j += 1) {
          const next = events[j]!;
          if (next.at - at > RESUME_WINDOW_MS) break;
          if (evaluate(rule.when, { event: next.event, state })) {
            resumed = true;
            break;
          }
        }
        if (resumed) premature += 1;
        else genuine += 1;
      }

      if (premature + genuine >= 10) {
        verdicts.push(`${rule.id}: ended ${genuine}, premature ${premature}`);
        expect(
          premature,
          `${rule.id} ends on [${rule.endsOn!.join(', ')}] but the activity resumed ` +
            `within 5 minutes ${premature} times against ${genuine} genuine endings`,
        ).toBeLessThanOrEqual(genuine);
      }
    }

    // Informational: shows which rules had enough occurrences to judge.
    expect(verdicts.length).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('never fires a station rule while the commander is not docked', async () => {
    // State-scoped station rules are held open by stationServices, which is cleared
    // on undock. A rule that survived leaving a station would advertise facilities
    // light-years away -- this has happened once already, with Fleet Carriers.
    const stationRules = BUNDLED_RULES.rules.filter((r) => r.id.startsWith('station-'));
    expect(stationRules.length).toBeGreaterThan(0);

    const files = await listJournalFiles(DIR);
    const state = initialState();
    let checked = 0;

    // Only the most recent journals: this walks every event through every rule.
    for (const f of files.filter((x) => x.sizeBytes > 0).slice(-5)) {
      const result = await replayFile(f.fullPath);
      for (const event of result.events) {
        applyEvent(state, event);
        if (state.docking === 'docked') continue;

        for (const rule of stationRules) {
          expect(
            evaluate(rule.when, { event, state }),
            `${rule.id} matched while not docked, after ${event.source.event}`,
          ).toBe(false);
        }
        checked += 1;
      }
    }

    expect(checked).toBeGreaterThan(0);
  });
});
