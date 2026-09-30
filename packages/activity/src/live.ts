/**
 * Live activity: what the commander is doing *right now*.
 *
 * The Activity Journal is a historical record — durable, concise, one entry per
 * thing accomplished. This is the other half: transient operational progress
 * that is interesting while it is happening and worthless afterwards. The two
 * must not be the same data, because the moment progress is written to history
 * the history becomes a stage-by-stage event list, which is the thing the
 * Journal exists not to be.
 *
 * Nothing here is persisted and nothing here becomes an entry.
 *
 * ## The measured ScanOrganic sequence
 *
 * This was measured against the local corpus (303 files, 289,725 events, 323
 * `ScanOrganic`) before any of it was written, and **the obvious reading of the
 * event names is wrong**:
 *
 * ```
 * Log  ->  Sample  ->  Sample  ->  Analyse        80 of 83 runs
 * Log                                              3 of 83 runs (abandoned)
 * ```
 *
 * Four events, not three. `Sample` occurs **twice**, so a stage number cannot be
 * derived from `ScanType` alone — the same value means "2 of 3" the first time
 * and "3 of 3" the second. Counting is the only correct way to do it.
 *
 * `Analyse` is **not** the third sample; it is the completion event that follows
 * it. Measured: `Analyse` was directly preceded by a `Sample` of the same species
 * in 80 of 80 cases, and every one of the 24 completed species took exactly 3
 * samples. So three samples then an analysis, uniformly.
 *
 * `WasLogged` is present on all 323 scans and was `false` on every one of them.
 * A field with no observed variation carries no information, so nothing here
 * reads it.
 *
 * ## Why reset rules are so narrow
 *
 * This is the finding that matters most, because the intuitive rules are
 * actively wrong. Measuring what appears *between* the stages of a single
 * organism shows that ordinary sampling is full of events that look like
 * interruptions:
 *
 * | Between stages of one organism | Runs |
 * |---|---|
 * | `Touchdown`, `Liftoff` | 74 + 68 |
 * | `Embark`, `Disembark` | ~140 |
 * | `SuitLoadout`, `Music`, `BackpackChange`, `DockSRV` | most |
 * | `Fileheader`, `LoadGame`, `Location`, `Shutdown` | 4 |
 *
 * Commanders fly between plants. They land, get out, sample, get back in, take
 * off, land again — that *is* the activity. Resetting on boarding the ship, on
 * changing suit, or on landing would break the feature for nearly every run.
 *
 * Even a **game restart** appears mid-run four times, so quitting to the menu
 * does not abandon a sample either.
 *
 * `FSDJump` never once appears between the stages of a run (0 of 83), which is
 * what makes leaving the system a safe abandonment signal rather than a guess.
 *
 * Time is not a signal either: the longest gap between two stages of the same
 * organism was 50,313 seconds — about fourteen hours — so nothing here expires.
 *
 * ## The genus roster
 *
 * A detailed surface scan reports which genera are present on a body, so the
 * overlay can say what is still unsampled rather than only what is in hand. That
 * this works at all is a measurement, not an assumption:
 *
 * - `SAASignalsFound.Genuses[].Genus` and `ScanOrganic.Genus` use the **same
 *   tokens**. All 11 sampled genera were DSS-listed, and **zero** genera were
 *   ever sampled that the body's scan had not listed — so the list is complete
 *   enough to base "unscanned" on.
 * - The body identifiers line up: `SAASignalsFound.BodyID` matches
 *   `ScanOrganic.Body`, on all 54 sampled bodies.
 * - The biological signal **count equals the number of genera listed**, in 119 of
 *   119 cases, so the count needs no separate display.
 * - Partial bodies are ordinary: of 60 bodies with a genus list, 47 were finished,
 *   **6 partially done and 7 untouched**. "Unscanned" is a frequent real state.
 * - 17 of 60 bodies were scanned more than once, so a repeat scan must merge
 *   rather than duplicate.
 *
 * Matching is on the **raw token**, not the localised name. The two agreed on all
 * 11 genera, but the token is the language-independent identifier and the
 * localised string is a display concern.
 *
 * What the scan does **not** give is the species — `Genuses` carries only a genus.
 * So an unsampled entry can say "Bacterium" and must not guess which bacterium.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import { splitVariant } from './exobiology.js';

/**
 * Samples required for one specimen.
 *
 * Measured, not assumed: all 24 species that reached `Analyse` in the corpus
 * took exactly three. Named rather than inlined so a future species that needs a
 * different count has one place to become a per-species lookup.
 */
export const SAMPLES_REQUIRED = 3;

/**
 * One genus on the current body, and how far along it is.
 *
 * `unscanned` is the state this exists for: the detailed surface scan says the
 * genus is down there and nothing has been collected from it.
 */
export interface GenusProgress {
  /** Language-independent identifier from the journal. */
  readonly token: string;
  /** Localised name for display, e.g. `Bacterium`. */
  readonly genus: string;
  readonly status: 'unscanned' | 'sampling' | 'complete';
  /** Only meaningful while `sampling`; null when the count is not established. */
  readonly samplesTaken: number | null;
}

/** A biological sample run in progress, or just completed. */
export interface LiveExobiology {
  readonly systemName: string | null;
  readonly systemAddress: number | null;
  /** `ScanOrganic.Body` is a BodyID integer, never a name. */
  readonly bodyId: number | null;
  /** Resolved from an event that carried both; null when nothing has. */
  readonly bodyName: string | null;

  readonly genus: string | null;
  readonly species: string | null;
  /** The variant colour, e.g. `Emerald`. Null when the variant is just the species. */
  readonly colour: string | null;

  /**
   * How many of the three samples are done.
   *
   * **Null means "in progress, count not established"** — which is a real state,
   * not a bug. The journal reader resumes from a byte offset rather than
   * replaying history, so if the app is started midway through a run the first
   * event it sees is a `Sample` that could be the second or the third. Both are
   * consistent with what was observed, so no number is claimed.
   *
   * A wrong "1 / 3" would be worse than no number: it would tell the commander
   * they have two more to take when they have one.
   */
  readonly samplesTaken: number | null;
  readonly samplesRequired: number;

  /**
   * Every genus the body's surface scan reported, with its progress.
   *
   * Empty when the body has not been surface-scanned, which is honest: without a
   * scan there is no list, and an empty roster is not a claim that nothing is
   * there.
   */
  readonly genera: readonly GenusProgress[];
  /** How many of those have had nothing collected from them. */
  readonly unscannedCount: number;

  /** First event of this run that this process saw. */
  readonly startedAt: string;
  readonly updatedAt: string;
  /** `Analyse` seen: the specimen is finished and the data is aboard. */
  readonly completed: boolean;
}

/**
 * The live state, as a tagged union.
 *
 * One `kind` today. The shape exists so mining, colonisation delivery or carrier
 * operations can be added as further members without the overlay having to grow
 * a second mechanism — the widget switches on `kind` and an unknown one renders
 * nothing rather than crashing.
 */
export type LiveActivity = { readonly kind: 'exobiology'; readonly exobiology: LiveExobiology };

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Identity of a sample run. A species is sampled on more than one body. */
function sameRun(
  a: { systemAddress: number | null; bodyId: number | null; species: string | null },
  b: { systemAddress: number | null; bodyId: number | null; species: string | null },
): boolean {
  return a.systemAddress === b.systemAddress && a.bodyId === b.bodyId && a.species === b.species;
}

/**
 * Tracks live activity across events.
 *
 * Deliberately separate from `ActivityEngine`: that class turns events into
 * durable entries, and mixing "what is happening" into it would make the two
 * lifecycles hard to keep apart. It takes the body-name map from the engine
 * rather than building a second one — there is one body-resolution
 * implementation and this is not another.
 */
/** A system has a few dozen bodies; a body had at most 8 genera in the corpus. */
const MAX_TRACKED_BODIES = 256;
const MAX_GENERA_PER_BODY = 16;

/** `systemAddress|bodyId`. A BodyID is only unique within a system. */
function bodyKey(systemAddress: number | null, bodyId: number | null): string {
  return `${systemAddress ?? '?'}|${bodyId ?? '?'}`;
}

export class LiveActivityTracker {
  private current: LiveActivity | null = null;
  /** Raw `Species` token of the run in progress, for identity comparison. */
  private speciesToken: string | null = null;
  /** Raw `Genus` token of the run in progress. */
  private genusToken: string | null = null;
  private commanderFid: string | null;

  /**
   * Genera each body's surface scan reported, in the order it reported them.
   *
   * Merged on a repeat scan rather than replaced or appended: 17 of 60 bodies in
   * the corpus were scanned more than once, and both duplicating the list and
   * discarding the earlier one would be wrong.
   */
  private readonly bodyGenera = new Map<string, { token: string; genus: string }[]>();

  /** Genus tokens completed on each body, from `Analyse` and from history. */
  private readonly completedGenera = new Map<string, Set<string>>();

  constructor(options: { readonly commanderFid: string | null }) {
    this.commanderFid = options.commanderFid;
  }

  get state(): LiveActivity | null {
    return this.current;
  }

  /**
   * The commander changed.
   *
   * Cleared unconditionally. A sample run belongs to whoever was taking it, and
   * showing one commander's progress to another is the same class of mistake as
   * showing them their missions.
   */
  setCommander(fid: string | null): void {
    if (fid === this.commanderFid) return;
    this.commanderFid = fid;
    this.clear();
  }

  /**
   * Drop the run in progress.
   *
   * What the body's surface scan reported is **not** dropped. It is knowledge
   * about the body rather than about this run, it does not become false when a
   * sample is abandoned, and re-acquiring it would need another scan.
   */
  clear(): void {
    this.current = null;
    this.speciesToken = null;
    this.genusToken = null;
  }

  /**
   * Record genera already completed on a body, from the durable Journal.
   *
   * Without this the roster would call a genus "unscanned" because *this session*
   * had not seen it sampled — the reader resumes from a byte offset rather than
   * replaying history, so a specimen collected last week leaves no trace in
   * memory. Saying "unscanned" about something already done is exactly the kind
   * of confident wrong answer this project avoids.
   */
  seedCompleted(
    systemAddress: number | null,
    bodyId: number | null,
    /**
     * Raw tokens, localised names, or a mix.
     *
     * Both are accepted because the two sources differ: a live `Analyse` carries
     * the token, while an entry already in the durable Journal stored only the
     * localised name. Requiring the token would silently fail to seed exactly the
     * history this exists to read, so matching tries both. The two agreed on all
     * 11 genera measured, so this widens what matches without loosening it.
     */
    genusTokens: readonly string[],
  ): void {
    if (bodyId === null) return;
    const key = bodyKey(systemAddress, bodyId);
    const set = this.completedGenera.get(key) ?? new Set<string>();
    for (const token of genusTokens) set.add(token);
    if (this.completedGenera.size < MAX_TRACKED_BODIES) this.completedGenera.set(key, set);

    // If this is the body on screen, the roster changes immediately.
    const live = this.current;
    if (live !== null && bodyKey(live.exobiology.systemAddress, live.exobiology.bodyId) === key) {
      this.current = { kind: 'exobiology', exobiology: this.withRoster(live.exobiology) };
    }
  }

  /**
   * Observe one event.
   *
   * Returns true when the live state changed, so the caller can decide whether
   * to re-render rather than being told on every journal line.
   */
  observe(event: NormalizedEvent, bodyNames: ReadonlyMap<number, string>): boolean {
    const name = event.source.event;
    const raw = event.source.raw as Record<string, unknown>;
    const at = event.source.provenance.timestamp;

    if (name === 'SAASignalsFound') return this.observeSurfaceScan(raw);

    if (name === 'ScanOrganic') return this.observeScan(raw, at, bodyNames);

    /*
     * Leaving the system abandons a run. Measured: `FSDJump` never appears
     * between the stages of a single organism in 83 runs, so unlike landing or
     * boarding the ship this is a signal rather than a guess. The run's body is
     * also unreachable from the new system, and a BodyID is only unique within
     * one.
     */
    if (name === 'FSDJump' || name === 'CarrierJump' || name === 'Location') {
      const address = num(raw, 'SystemAddress');
      if (
        this.current !== null &&
        address !== null &&
        this.current.exobiology.systemAddress !== null &&
        address !== this.current.exobiology.systemAddress
      ) {
        this.clear();
        return true;
      }
      return false;
    }

    /*
     * Death, on a single observation.
     *
     * Stated honestly: there are 18 `Died` events in the corpus and exactly one
     * of them falls near a sample run — a `Log` five minutes earlier, with no
     * further scan of that organism afterwards. That is consistent with death
     * abandoning the run, and it is one data point, so it is not proof.
     *
     * Clearing is the conservative direction: the failure mode is a widget that
     * stops showing progress the commander could have resumed, which they will
     * notice and can re-establish with their next sample. The opposite error
     * asserts progress that no longer exists.
     *
     * Only in-progress runs are cleared. A completed specimen survives death
     * because the data was already banked by `Analyse`.
     */
    if (name === 'Died') {
      if (this.current !== null && !this.current.exobiology.completed) {
        this.clear();
        return true;
      }
      return false;
    }

    /*
     * Selling retires a completed specimen. The data has left the ship, so
     * continuing to show "sample complete" would describe something the
     * commander no longer has.
     */
    if (name === 'SellOrganicData') {
      if (this.current !== null && this.current.exobiology.completed) {
        this.clear();
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * A detailed surface scan: which genera are on this body.
   *
   * Recorded for every body scanned, not only the one being worked, because the
   * commander may scan several before landing on any of them.
   */
  private observeSurfaceScan(raw: Record<string, unknown>): boolean {
    const genuses = Array.isArray(raw['Genuses']) ? (raw['Genuses'] as Record<string, unknown>[]) : [];
    if (genuses.length === 0) return false;

    const systemAddress = num(raw, 'SystemAddress');
    const bodyId = num(raw, 'BodyID');
    if (bodyId === null) return false;

    const key = bodyKey(systemAddress, bodyId);
    const listed = this.bodyGenera.get(key) ?? [];
    let added = false;

    for (const g of genuses) {
      const token = str(g, 'Genus');
      if (token === null) continue;
      if (listed.some((e) => e.token === token)) continue;
      if (listed.length >= MAX_GENERA_PER_BODY) break;
      listed.push({ token, genus: str(g, 'Genus_Localised') ?? token });
      added = true;
    }

    if (added && this.bodyGenera.size < MAX_TRACKED_BODIES) this.bodyGenera.set(key, listed);

    // A scan of the body currently being worked changes what the overlay shows.
    if (added && this.current !== null) {
      const live = this.current.exobiology;
      if (bodyKey(live.systemAddress, live.bodyId) === key) {
        this.current = { kind: 'exobiology', exobiology: this.withRoster(live) };
        return true;
      }
    }
    return added;
  }

  /**
   * Attach the body's genus roster to a state.
   *
   * Computed rather than stored, so it cannot drift from what has been observed.
   * The genus being sampled right now is included even if no scan listed it
   * """ + DASH + """ that never happened in the corpus, but reporting a specimen the commander
   * is visibly holding would be worse than a roster that is one row longer.
   */
  private withRoster(live: LiveExobiology): LiveExobiology {
    const key = bodyKey(live.systemAddress, live.bodyId);
    const listed = this.bodyGenera.get(key) ?? [];
    const done = this.completedGenera.get(key) ?? new Set<string>();

    /*
     * No surface scan, no roster. The specimen being sampled is already the
     * headline of the widget, so a one-row list restating it would be noise --
     * and an empty roster is not a claim that nothing else is down there, which
     * is exactly what an unscanned body cannot support.
     */
    if (listed.length === 0) return { ...live, genera: [], unscannedCount: 0 };

    const rows: GenusProgress[] = listed.map((entry) => {
      if (done.has(entry.token) || done.has(entry.genus)) {
        return { token: entry.token, genus: entry.genus, status: 'complete', samplesTaken: null };
      }
      if (this.genusToken === entry.token && !live.completed) {
        return {
          token: entry.token,
          genus: entry.genus,
          status: 'sampling',
          samplesTaken: live.samplesTaken,
        };
      }
      return { token: entry.token, genus: entry.genus, status: 'unscanned', samplesTaken: null };
    });

    if (this.genusToken !== null && !rows.some((r) => r.token === this.genusToken)) {
      rows.push({
        token: this.genusToken,
        genus: live.genus ?? this.genusToken,
        status: live.completed ? 'complete' : 'sampling',
        samplesTaken: live.completed ? null : live.samplesTaken,
      });
    }

    return {
      ...live,
      genera: rows,
      unscannedCount: rows.filter((r) => r.status === 'unscanned').length,
    };
  }

  private observeScan(
    raw: Record<string, unknown>,
    at: string,
    bodyNames: ReadonlyMap<number, string>,
  ): boolean {
    const scanType = str(raw, 'ScanType');
    if (scanType === null) return false;

    const bodyId = num(raw, 'Body');
    const systemAddress = num(raw, 'SystemAddress');
    const speciesToken = str(raw, 'Species');
    const scanGenusToken = str(raw, 'Genus');

    const { species, colour } = splitVariant(
      str(raw, 'Variant_Localised'),
      str(raw, 'Species_Localised'),
    );

    const identity = { systemAddress, bodyId, species: speciesToken };
    const continuing =
      this.current !== null &&
      sameRun(
        {
          systemAddress: this.current.exobiology.systemAddress,
          bodyId: this.current.exobiology.bodyId,
          species: this.speciesToken,
        },
        identity,
      );

    const base = {
      systemName: this.current?.exobiology.systemName ?? null,
      systemAddress,
      bodyId,
      // Resolved through the engine's map. Null when nothing has named this body
      // yet, which is honest -- the current location would be wrong the moment a
      // commander's state has moved on from where they scanned.
      bodyName: bodyId === null ? null : (bodyNames.get(bodyId) ?? null),
      genus: str(raw, 'Genus_Localised'),
      species,
      colour,
      samplesRequired: SAMPLES_REQUIRED,
      // Replaced by `withRoster` below; present so the shape is complete.
      genera: [] as readonly GenusProgress[],
      unscannedCount: 0,
    };

    if (scanType === 'Analyse') {
      /*
       * Completion. The count is asserted as complete even if this process never
       * saw the earlier stages, because `Analyse` itself is the proof: measured,
       * it followed the third sample in 80 of 80 cases.
       */
      this.speciesToken = speciesToken;
      this.genusToken = scanGenusToken;

      // The genus is now done on this body, which is what lets the roster stop
      // calling it unscanned.
      if (scanGenusToken !== null) {
        this.seedCompleted(systemAddress, bodyId, [scanGenusToken]);
      }

      this.current = {
        kind: 'exobiology',
        exobiology: this.withRoster({
          ...base,
          samplesTaken: SAMPLES_REQUIRED,
          startedAt: continuing ? (this.current?.exobiology.startedAt ?? at) : at,
          updatedAt: at,
          completed: true,
        }),
      };
      return true;
    }

    if (scanType === 'Log') {
      // Always the first sample of a specimen. A `Log` for a different organism
      // replaces whatever was in progress -- measured: the only three runs that
      // never completed were each followed by a different species' `Log`.
      this.speciesToken = speciesToken;
      this.genusToken = scanGenusToken;
      this.current = {
        kind: 'exobiology',
        exobiology: this.withRoster({
          ...base,
          samplesTaken: 1,
          startedAt: at,
          updatedAt: at,
          completed: false,
        }),
      };
      return true;
    }

    if (scanType === 'Sample') {
      const prior = continuing && !this.current!.exobiology.completed
        ? this.current!.exobiology.samplesTaken
        : null;

      this.speciesToken = speciesToken;
      this.genusToken = scanGenusToken;
      this.current = {
        kind: 'exobiology',
        exobiology: this.withRoster({
          ...base,
          // Null propagates: if the count was never established it stays
          // unestablished rather than being invented from this event.
          samplesTaken: prior === null ? null : Math.min(prior + 1, SAMPLES_REQUIRED),
          startedAt: continuing ? (this.current?.exobiology.startedAt ?? at) : at,
          updatedAt: at,
          completed: false,
        }),
      };
      return true;
    }

    // An unrecognised ScanType is preserved as "something happened" rather than
    // being forced into a stage. Nothing in the corpus produces one.
    return false;
  }

  /** Attach a system name once one is known, without disturbing progress. */
  setSystem(systemName: string | null, systemAddress: number | null): void {
    if (this.current === null) return;
    if (systemAddress !== null && this.current.exobiology.systemAddress !== null) {
      if (systemAddress !== this.current.exobiology.systemAddress) return;
    }
    this.current = {
      ...this.current,
      exobiology: { ...this.current.exobiology, systemName },
    };
  }

  /** Fill in a body name that arrived after the scan did. */
  resolveBodyName(bodyNames: ReadonlyMap<number, string>): boolean {
    const live = this.current;
    if (live === null) return false;
    const { bodyId, bodyName } = live.exobiology;
    if (bodyId === null || bodyName !== null) return false;
    const found = bodyNames.get(bodyId);
    if (found === undefined) return false;
    this.current = { ...live, exobiology: { ...live.exobiology, bodyName: found } };
    return true;
  }
}

/**
 * The stage line, as a person would read it.
 *
 * Returns null when the count is not established, so the caller omits the line
 * rather than printing a number nobody can stand behind.
 */
export function sampleStageText(live: LiveExobiology): string | null {
  if (live.completed) return `${live.samplesRequired} / ${live.samplesRequired}`;
  if (live.samplesTaken === null) return null;
  return `${live.samplesTaken} / ${live.samplesRequired}`;
}
