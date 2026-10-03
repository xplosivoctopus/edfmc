/**
 * Tests for the desktop app's pure presentation logic.
 *
 * The app had no test runner, so this logic went unverified while the packages
 * around it were covered. Anything here must stay free of Tauri and DOM: the
 * point is the arithmetic, not the wiring.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  countdownTo,
  liveJournalPanel,
  liveJournalTitle,
  type OverlayExobiologyRow,
  type OverlayLiveExobiology,
} from '../src/lib/overlay.js';

const overlaySrc = readFileSync(
  fileURLToPath(new URL('../src/overlay/Overlay.tsx', import.meta.url)),
  'utf8',
);
const overlayCss = readFileSync(
  fileURLToPath(new URL('../src/overlay/overlay.css', import.meta.url)),
  'utf8',
);
const companionSrc = readFileSync(
  fileURLToPath(new URL('../src/lib/companion.ts', import.meta.url)),
  'utf8',
);

describe('countdownTo', () => {
  // A real DepartureTime, verbatim from the corpus.
  const DEPARTURE = '2026-08-14T00:32:10Z';
  const at = Date.parse(DEPARTURE);

  it('counts down in minutes and seconds', () => {
    expect(countdownTo(DEPARTURE, at - 900_000)).toBe('15:00');
    expect(countdownTo(DEPARTURE, at - 522_000)).toBe('8:42');
    expect(countdownTo(DEPARTURE, at - 59_000)).toBe('0:59');
    expect(countdownTo(DEPARTURE, at - 1_000)).toBe('0:01');
  });

  it('pads seconds so the line does not jitter as it ticks', () => {
    expect(countdownTo(DEPARTURE, at - 61_000)).toBe('1:01');
    expect(countdownTo(DEPARTURE, at - 600_000)).toBe('10:00');
  });

  it('adds an hours field only when there are hours', () => {
    // The longest countdown measured in the corpus was 2641s, so this is reachable.
    expect(countdownTo(DEPARTURE, at - 3_661_000)).toBe('1:01:01');
    expect(countdownTo(DEPARTURE, at - 2_641_000)).toBe('44:01');
  });

  it('returns null once the stated time has passed', () => {
    // The caller says "Departing" instead. A negative or zeroed clock would imply
    // we know the carrier left, and the journal has not said so.
    expect(countdownTo(DEPARTURE, at)).toBeNull();
    expect(countdownTo(DEPARTURE, at + 1_000)).toBeNull();
    expect(countdownTo(DEPARTURE, at + 86_400_000)).toBeNull();
  });

  it('returns null for a timestamp it cannot parse', () => {
    // Rather than rendering NaN over the game.
    expect(countdownTo('not a date', Date.now())).toBeNull();
    expect(countdownTo('', Date.now())).toBeNull();
  });
});

/* --------------------------------------------- live journal vs live activity */

const r = (
  genus: string,
  status: OverlayExobiologyRow['status'],
  samplesTaken: number | null,
  species: string | null = null,
  colour: string | null = null,
): OverlayExobiologyRow => ({
  genus,
  species,
  colour,
  status,
  samplesTaken,
  samplesRequired: 3,
});

/** The body that prompted this: one collected, one partial, one untouched. */
const roster: OverlayLiveExobiology = {
  kind: 'exobiology',
  bodyName: 'Wregoe LS-N b51-0 A 7 g',
  rows: [
    r('Bacterium', 'complete', 3, 'Bacterium Vesicula', 'Gold'),
    r('Aleoida', 'sampling', 2, 'Aleoida Coronamus', 'Turquoise'),
    r('Concha', 'unscanned', 0),
  ],
  completedCount: 1,
  unscannedCount: 1,
  total: 3,
  updatedAt: '2026-09-01T00:00:00Z',
};

/* The kind of entry that made the widget look like Current Context. */
const genericEntry = {
  title: '2 biological signals detected',
  detail: 'Stratum, Bacterium',
  systemName: 'Nervi',
  bodyName: 'Nervi 4 a',
  occurredAt: '2026-09-01T00:00:00Z',
  hereCount: 2,
  sessionCount: 7,
};

describe('which panel the Live Journal widget shows', () => {
  it('prefers the exobiology roster over the newest recorded entry', () => {
    /*
     * The decision the whole change turns on. "2 biological signals detected" is
     * already what Current Context says; where the commander got to on each
     * organism is not said anywhere else on screen.
     */
    const panel = liveJournalPanel({ liveActivity: roster, liveJournal: genericEntry });
    expect(panel?.kind).toBe('exobiology');
    expect(liveJournalTitle(panel)).toBe('Exobiology');
  });

  it('falls back to the newest entry when the commander is not at a scanned body', () => {
    const panel = liveJournalPanel({ liveActivity: null, liveJournal: genericEntry });
    expect(panel?.kind).toBe('entry');
    expect(liveJournalTitle(panel)).toBe('Field Journal');
  });

  it('falls back rather than showing an empty roster', () => {
    // No surface scan means no list, and a blank panel is worse than the entry.
    const empty: OverlayLiveExobiology = { ...roster, rows: [], total: 0, completedCount: 0, unscannedCount: 0 };
    expect(liveJournalPanel({ liveActivity: empty, liveJournal: genericEntry })?.kind).toBe('entry');
  });

  it('shows nothing when there is neither', () => {
    expect(liveJournalPanel({ liveActivity: null, liveJournal: null })).toBeNull();
  });

  it('falls back rather than rendering an activity kind it does not understand', () => {
    /*
     * Forward compatibility. Mining or colonisation progress pushed by a newer
     * build must not produce an empty panel in an older overlay.
     */
    const unknown = { kind: 'mining', rows: [] } as unknown as OverlayLiveExobiology;
    expect(liveJournalPanel({ liveActivity: unknown, liveJournal: genericEntry })?.kind).toBe('entry');
  });
});

describe('the roster does not go stale', () => {
  it('stays regardless of how long ago the last sample was', () => {
    /*
     * Staleness was the wrong model for this panel. It describes the body the
     * commander is standing on rather than an event that happened, so it is
     * current for as long as they are there -- a commander who returns after a
     * week still needs to know which organism they were halfway through.
     */
    const panel = liveJournalPanel({
      liveActivity: roster,
      liveJournal: genericEntry,
      now: Date.parse(roster.updatedAt) + 7 * 24 * 60 * 60 * 1000,
    });
    expect(panel?.kind).toBe('exobiology');
  });

  it('stays when everything on the body is already collected', () => {
    // "Nothing left here" is an answer worth showing, not a reason to hide.
    const done: OverlayLiveExobiology = {
      ...roster,
      rows: roster.rows.map((row) => ({ ...row, status: 'complete' as const, samplesTaken: 3 })),
      completedCount: 3,
      unscannedCount: 0,
    };
    const panel = liveJournalPanel({
      liveActivity: done,
      liveJournal: genericEntry,
      now: Date.parse(done.updatedAt) + 60 * 60 * 1000,
    });
    expect(panel?.kind).toBe('exobiology');
  });
});

describe('a mission whose work is done', () => {
  it('reads Completed instead of a countdown', () => {
    /*
     * Once the work is banked the clock is no longer the thing to act on --
     * going and handing it in is -- and two competing statuses on one line is
     * how a commander reads neither. So it replaces the expiry rather than
     * joining it.
     */
    expect(overlaySrc).toContain('Completed');
    expect(overlaySrc).toMatch(/m\.awaitingTurnIn \? \([\s\S]{0,200}Completed[\s\S]{0,200}\) : \(/);
  });

  it('carries the flag from the mission store rather than re-deriving it', () => {
    // One definition of "done", in the package that owns mission state.
    expect(companionSrc).toContain('awaitingTurnIn: isAwaitingTurnIn(m)');
    expect(overlaySrc).not.toContain('redirected');
    expect(overlaySrc).not.toContain('totalToDeliver');
  });

  it('is not coloured the same as an expiry running out', () => {
    /*
     * Opposites: amber is a deadline closing in, this is work already banked.
     * Reading them as one colour at a glance over the game is the single thing
     * this must not do.
     */
    const urgent = /\.urgent\s*\{[^}]*color:\s*([^;]+);/.exec(overlayCss);
    const done = /\.mission-row-exp\.done\s*\{[^}]*color:\s*([^;]+);/.exec(overlayCss);
    expect(urgent, 'the urgent colour could not be found').toBeTruthy();
    expect(done, 'the completed colour could not be found').toBeTruthy();
    expect(done![1]!.trim()).not.toBe(urgent![1]!.trim());
  });

  it('is not dimmed, because it is still outstanding', () => {
    /*
     * The reward is not paid until it is turned in. Fading the row would read
     * as "dealt with", which is exactly the mission that then gets forgotten.
     */
    const rule = /\.mission-row\.done\s*\{([^}]*)\}/.exec(overlayCss);
    expect(rule, 'the completed row rule could not be found').toBeTruthy();
    expect(rule![1]).not.toMatch(/opacity|filter|text-decoration/);
  });
});
