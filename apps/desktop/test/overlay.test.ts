/**
 * Tests for the desktop app's pure presentation logic.
 *
 * The app had no test runner, so this logic went unverified while the packages
 * around it were covered. Anything here must stay free of Tauri and DOM: the
 * point is the arithmetic, not the wiring.
 */

import { describe, expect, it } from 'vitest';

import {
  LIVE_COMPLETION_VISIBLE_MS,
  countdownTo,
  liveJournalPanel,
  liveJournalTitle,
  type OverlayLiveExobiology,
} from '../src/lib/overlay.js';

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

const sampling: OverlayLiveExobiology = {
  kind: 'exobiology',
  genus: 'Stratum',
  species: 'Stratum Tectonicas',
  colour: 'Emerald',
  bodyName: 'Nervi 4 a',
  samplesTaken: 1,
  samplesRequired: 3,
  completed: false,
  genera: [{ genus: 'Stratum', status: 'sampling', samplesTaken: 1 }],
  unscannedCount: 0,
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
  it('prefers live sampling progress over the newest recorded entry', () => {
    /*
     * The decision the whole change turns on. "2 biological signals detected" is
     * already what Current Context says; the sample counter is not said anywhere
     * else on screen.
     */
    const panel = liveJournalPanel({ liveActivity: sampling, liveJournal: genericEntry });
    expect(panel?.kind).toBe('exobiology');
    expect(liveJournalTitle(panel)).toBe('Exobiology');
  });

  it('falls back to the newest entry when nothing is in progress', () => {
    const panel = liveJournalPanel({ liveActivity: null, liveJournal: genericEntry });
    expect(panel?.kind).toBe('entry');
    expect(liveJournalTitle(panel)).toBe('Field Journal');
  });

  it('shows nothing when there is neither', () => {
    expect(liveJournalPanel({ liveActivity: null, liveJournal: null })).toBeNull();
  });

  it('keeps showing a completed sample rather than dropping straight to history', () => {
    // The completion is the moment worth seeing, so it holds the panel briefly.
    const done: OverlayLiveExobiology = { ...sampling, completed: true, samplesTaken: 3 };
    const panel = liveJournalPanel({
      liveActivity: done,
      liveJournal: genericEntry,
      now: Date.parse(done.updatedAt) + 1000,
    });
    expect(panel?.kind).toBe('exobiology');
    if (panel?.kind === 'exobiology') expect(panel.live.completed).toBe(true);
  });

  it('falls back rather than rendering an activity kind it does not understand', () => {
    /*
     * Forward compatibility. Mining or colonisation progress pushed by a newer
     * build must not produce an empty panel in an older overlay.
     */
    const unknown = { kind: 'mining', species: null } as unknown as OverlayLiveExobiology;
    const panel = liveJournalPanel({ liveActivity: unknown, liveJournal: genericEntry });
    expect(panel?.kind).toBe('entry');
  });
});

describe('the completion lifecycle', () => {
  const done: OverlayLiveExobiology = { ...sampling, completed: true, samplesTaken: 3 };
  const at = Date.parse(done.updatedAt);

  it('gives way to history once the completion is no longer recent', () => {
    /*
     * A panel still announcing a sample finished half an hour ago is the
     * stale-context problem this project has already fixed once.
     */
    const panel = liveJournalPanel({
      liveActivity: done,
      liveJournal: genericEntry,
      now: at + LIVE_COMPLETION_VISIBLE_MS + 1,
    });
    expect(panel?.kind).toBe('entry');
  });

  it('shows nothing at all when the completion is stale and there is no history', () => {
    expect(
      liveJournalPanel({
        liveActivity: done,
        liveJournal: null,
        now: at + LIVE_COMPLETION_VISIBLE_MS + 1,
      }),
    ).toBeNull();
  });

  it('never expires a run that is still in progress', () => {
    /*
     * The measured constraint. The longest gap between two stages of one organism
     * was about fourteen hours: a commander who lands, samples, flies to the next
     * plant and returns is mid-run the whole time. Timing that out would be wrong
     * on real data, so only completions age.
     */
    const panel = liveJournalPanel({
      liveActivity: sampling,
      liveJournal: genericEntry,
      now: Date.parse(sampling.updatedAt) + 20 * 60 * 60 * 1000,
    });
    expect(panel?.kind).toBe('exobiology');
  });

  it('does not hide a completion whose timestamp cannot be parsed', () => {
    // An odd clock string is not evidence of staleness.
    const odd: OverlayLiveExobiology = { ...done, updatedAt: 'not a date' };
    const panel = liveJournalPanel({ liveActivity: odd, liveJournal: genericEntry, now: at });
    expect(panel?.kind).toBe('exobiology');
  });
});

describe('unfinished business on the body', () => {
  /*
   * The body in the corpus that prompted this: `Wregoe LS-N b51-0 A 7 g`, two
   * genera, one collected and one never touched.
   */
  const oneLeft: OverlayLiveExobiology = {
    ...sampling,
    completed: true,
    samplesTaken: 3,
    genera: [
      { genus: 'Fonticulua', status: 'complete', samplesTaken: null },
      { genus: 'Bacterium', status: 'unscanned', samplesTaken: null },
    ],
    unscannedCount: 1,
  };

  it('keeps the panel up past the completion window while a genus is unscanned', () => {
    /*
     * Once a specimen is finished the useful thing on screen is no longer the
     * completion -- it is that another organism on this body has had nothing
     * collected from it. Hiding that after five minutes throws away the answer to
     * "what else is down here?" while the commander is still standing on it.
     */
    const panel = liveJournalPanel({
      liveActivity: oneLeft,
      liveJournal: genericEntry,
      now: Date.parse(oneLeft.updatedAt) + LIVE_COMPLETION_VISIBLE_MS * 10,
    });
    expect(panel?.kind).toBe('exobiology');
  });

  it('gives way once every genus on the body is collected', () => {
    const allDone: OverlayLiveExobiology = {
      ...oneLeft,
      genera: oneLeft.genera.map((g) => ({ ...g, status: 'complete' as const })),
      unscannedCount: 0,
    };
    const panel = liveJournalPanel({
      liveActivity: allDone,
      liveJournal: genericEntry,
      now: Date.parse(allDone.updatedAt) + LIVE_COMPLETION_VISIBLE_MS + 1,
    });
    expect(panel?.kind).toBe('entry');
  });

  it('still ages out an unscanned body with no roster at all', () => {
    // No surface scan means no list, and an empty roster is not evidence that
    // something remains -- so it must not hold the panel open indefinitely.
    const noRoster: OverlayLiveExobiology = {
      ...oneLeft,
      genera: [],
      unscannedCount: 0,
    };
    const panel = liveJournalPanel({
      liveActivity: noRoster,
      liveJournal: genericEntry,
      now: Date.parse(noRoster.updatedAt) + LIVE_COMPLETION_VISIBLE_MS + 1,
    });
    expect(panel?.kind).toBe('entry');
  });
});
