/**
 * Live activity: what the commander is doing right now, and where they left off.
 *
 * The Activity Journal is a historical record — durable, concise, one entry per
 * thing accomplished. This is the other half: operational progress, which is
 * interesting while the work is unfinished. The two must not be the same data,
 * because the moment progress is written to history the history becomes a
 * stage-by-stage event list, which is the thing the Journal exists not to be.
 *
 * Progress **is** persisted, but separately and as current state rather than as
 * events: one row per genus per body, overwritten as it changes. Leaving the
 * planet, leaving the system or closing the app must not lose a half-finished
 * specimen — a commander called away mid-run should come back and see exactly
 * where they stopped instead of guessing.
 *
 * ## The measured ScanOrganic sequence
 *
 * Measured against the local corpus (303 files, 289,725 events, 323
 * `ScanOrganic`) before any of this was written, and **the obvious reading of the
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
 * samples.
 *
 * `WasLogged` is present on all 323 scans and was `false` on every one of them.
 * A field with no observed variation carries no information, so nothing here
 * reads it.
 *
 * ## Why reset rules are so narrow
 *
 * Measuring what appears *between* the stages of a single organism shows that
 * ordinary sampling is full of events that look like interruptions:
 *
 * | Between stages of one organism | Runs |
 * |---|---|
 * | `Touchdown`, `Liftoff` | 74 + 68 |
 * | `Embark`, `Disembark` | most |
 * | `SuitLoadout`, `Music`, `BackpackChange`, `DockSRV` | most |
 * | `Fileheader`, `LoadGame`, `Location`, `Shutdown` | 4 |
 *
 * Commanders fly between plants. They land, get out, sample, get back in, take
 * off, land again — that *is* the activity. Resetting on boarding the ship, on
 * changing suit, or on landing would break the feature for nearly every run.
 * Even a **game restart** appears mid-run four times.
 *
 * Time is not a signal: the longest gap between two stages of the same organism
 * was 50,313 seconds — about fourteen hours — so nothing here expires.
 *
 * **Leaving the system no longer discards progress.** An earlier version cleared
 * on `FSDJump`, which was a guess: the corpus contains no case of a commander
 * leaving mid-run, so there was no evidence either way. Persisting is the
 * behaviour that loses nothing, and the display simply follows the body the
 * commander is at.
 *
 * ## One specimen at a time
 *
 * Starting a different genus on the same body returns the previous *partial* row
 * to unscanned. The evidence: of the 80 completed runs, **every one was
 * contiguous** — no run ever resumed after another species intervened — and the
 * only 3 interrupted runs never completed. If partial progress survived switching
 * organisms, at least one resumed run would be expected among 80.
 *
 * Completed specimens are never reset. `Analyse` banked them.
 *
 * ## The genus roster
 *
 * A detailed surface scan reports which genera a body carries, which is what
 * lets the overlay say what has *not* been collected. Measured:
 *
 * - `SAASignalsFound.Genuses[].Genus` and `ScanOrganic.Genus` use the **same
 *   tokens**. All 11 sampled genera were DSS-listed, and **zero** genera were
 *   ever sampled that the body's scan had not listed.
 * - Body identifiers line up: `SAASignalsFound.BodyID` matches `ScanOrganic.Body`
 *   on all 54 sampled bodies.
 * - The biological signal **count equals the number of genera listed**, 119 of 119.
 * - **One species per genus per body**, 90 of 90, and one variant per species,
 *   90 of 90. So a row is keyed by genus and filled in once sampled.
 * - 17 of 60 bodies were scanned more than once, so a repeat scan merges.
 *
 * Matching is on the **raw token**, not the localised name. The two agreed on all
 * 11 genera, but the token is language-independent.
 *
 * What the scan does **not** give is the species — `Genuses` carries only a genus.
 * So an unsampled row says "Concha" and must not guess which concha.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import { splitVariant } from './exobiology.js';

/**
 * Samples required for one specimen.
 *
 * Measured, not assumed: all 24 species that reached `Analyse` in the corpus
 * took exactly three.
 */
export const SAMPLES_REQUIRED = 3;

/** A genus a body carries, and how far through it the commander is. */
export interface SpeciesProgress {
  /** Language-independent genus identifier; the row's key. */
  readonly genusToken: string;
  /** Localised genus, e.g. `Concha`. Known from the surface scan alone. */
  readonly genus: string;
  /**
   * Species identity, known only once sampling starts.
   *
   * Null on an unsampled row, because a surface scan reports a genus and nothing
   * finer. "Concha" is what the game said; "Concha Renibus" would be a guess.
   */
  readonly speciesToken: string | null;
  readonly species: string | null;
  /** Variant colour, e.g. `Gold`. Null until sampled, or when there is none. */
  readonly colour: string | null;
  /**
   * Samples collected.
   *
   * `0` means nothing collected. `null` means **in progress with the count not
   * established** — the reader resumes from a byte offset rather than replaying,
   * so a run first seen midway could be on its second or third sample. A wrong
   * "1 / 3" would say two remain when one does.
   */
  readonly samplesTaken: number | null;
  readonly samplesRequired: number;
  readonly completed: boolean;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
}

export type ExobiologyStatus = 'unscanned' | 'sampling' | 'complete';

export function rowStatus(row: SpeciesProgress): ExobiologyStatus {
  if (row.completed) return 'complete';
  if (row.samplesTaken === null || row.samplesTaken > 0) return 'sampling';
  return 'unscanned';
}

/** The stage line, or null when no number can be stood behind. */
export function stageText(row: SpeciesProgress): string | null {
  if (row.completed) return `${row.samplesRequired} / ${row.samplesRequired}`;
  if (row.samplesTaken === null || row.samplesTaken === 0) return null;
  return `${row.samplesTaken} / ${row.samplesRequired}`;
}

/** Everything known about exobiology on the body the commander is at. */
export interface LiveExobiology {
  readonly systemName: string | null;
  readonly systemAddress: number | null;
  readonly bodyId: number | null;
  readonly bodyName: string | null;
  /** One row per genus the surface scan reported, in the order reported. */
  readonly rows: readonly SpeciesProgress[];
  /** The genus being sampled right now, if any. */
  readonly activeGenusToken: string | null;
  readonly completedCount: number;
  readonly unscannedCount: number;
  readonly total: number;
  /** Most recent change, for the overlay's own staleness decisions. */
  readonly updatedAt: string;
}

/**
 * The live state, as a tagged union.
 *
 * One `kind` today. The shape exists so mining, colonisation delivery or carrier
 * operations can be added as further members without the overlay growing a second
 * mechanism — the widget switches on `kind` and renders nothing for one it does
 * not know.
 */
export type LiveActivity = { readonly kind: 'exobiology'; readonly exobiology: LiveExobiology };

/**
 * A completed specimen, as the Activity Journal recorded it.
 *
 * Every field optional-by-null because entries written by older versions carry
 * less: the genus token and the variant colour were both added after the first
 * release, so a recovery must work from whatever is there.
 */
export interface CompletedRecord {
  readonly genusToken: string | null;
  readonly genus: string | null;
  readonly speciesToken: string | null;
  readonly species: string | null;
  readonly colour: string | null;
}

/** Where the commander is, for the purpose of showing a roster. */
export interface BodyRef {
  readonly systemAddress: number | null;
  readonly bodyId: number;
  readonly bodyName: string | null;
  readonly systemName: string | null;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bodyKey(systemAddress: number | null, bodyId: number | null): string {
  return `${systemAddress ?? '?'}|${bodyId ?? '?'}`;
}

const MAX_GENERA_PER_BODY = 16;

/**
 * Tracks exobiology progress on the body the commander is at.
 *
 * Holds only the current body. Everything else lives in the database, which the
 * companion loads on arrival and writes back on change — so this class stays a
 * pure interpreter of events and can be tested without storage.
 */
export class LiveActivityTracker {
  private commanderFid: string | null;

  private body: BodyRef | null = null;
  private rows: SpeciesProgress[] = [];
  private activeGenusToken: string | null = null;
  private updatedAt = '';

  /** Set when the body changed and its stored rows have not been loaded yet. */
  private hydrationNeeded: BodyRef | null = null;
  /** Genus tokens whose rows changed and have not been persisted yet. */
  private readonly dirty = new Set<string>();

  /**
   * Genus lists learned for bodies the commander is **not** at.
   *
   * The detailed surface scan is normally done from orbit before approaching:
   * 99 of 122 scans in the corpus had no prior `ApproachBody` for that body. So
   * the common case is learning a body's genera long before standing on it, and
   * discarding them until arrival threw away the whole roster.
   *
   * Drained by the caller and written to storage, so arriving later is a read.
   */
  private readonly pendingRosters = new Map<
    string,
    { readonly body: BodyRef; readonly rows: SpeciesProgress[] }
  >();

  constructor(options: { readonly commanderFid: string | null }) {
    this.commanderFid = options.commanderFid;
  }

  get state(): LiveActivity | null {
    if (this.body === null || this.rows.length === 0) return null;
    return {
      kind: 'exobiology',
      exobiology: {
        systemName: this.body.systemName,
        systemAddress: this.body.systemAddress,
        bodyId: this.body.bodyId,
        bodyName: this.body.bodyName,
        rows: this.rows,
        activeGenusToken: this.activeGenusToken,
        completedCount: this.rows.filter((r) => r.completed).length,
        unscannedCount: this.rows.filter((r) => rowStatus(r) === 'unscanned').length,
        total: this.rows.length,
        updatedAt: this.updatedAt,
      },
    };
  }

  /** The body whose stored rows the caller should load, consumed by reading it. */
  takeHydrationRequest(): BodyRef | null {
    const req = this.hydrationNeeded;
    this.hydrationNeeded = null;
    return req;
  }

  /**
   * Genus lists for other bodies, for the caller to persist.
   *
   * Consumed by reading, so a body is written once per scan rather than on
   * every journal line until arrival.
   */
  takePendingRosters(): ReadonlyArray<{ body: BodyRef; rows: readonly SpeciesProgress[] }> {
    if (this.pendingRosters.size === 0) return [];
    const out = [...this.pendingRosters.values()];
    this.pendingRosters.clear();
    return out;
  }

  /** Rows changed since the last drain, for the caller to persist. */
  takeDirtyRows(): readonly SpeciesProgress[] {
    if (this.dirty.size === 0) return [];
    const out = this.rows.filter((r) => this.dirty.has(r.genusToken));
    this.dirty.clear();
    return out;
  }

  /** Where those dirty rows belong. */
  get currentBody(): BodyRef | null {
    return this.body;
  }

  /**
   * Apply what the Activity Journal records about this body.
   *
   * **The Journal is authoritative for completion.** Its `sample-completed`
   * entries are derived from `Analyse` events, keyed by a deterministic event
   * id, and survive restarts, reinstalls and a lost progress table. The
   * progress rows beside them only know what *this* process watched happen, so
   * when the two disagree about whether something is finished, the Journal
   * wins.
   *
   * It restores the **identity** as well as the flag. The entry carries the
   * species and variant, so a specimen recovered after a restart reads
   * "Fonticulua Campestris Teal" with its value, not a bare "Fonticulua" —
   * which is all a surface scan would have given.
   *
   * Progress rows remain the only source for a **partial** count: three samples
   * out of three is in history, but two out of three never is, by design.
   */
  applyCompleted(records: readonly CompletedRecord[]): boolean {
    if (records.length === 0 || this.body === null) return false;
    let changed = false;

    for (const record of records) {
      // Either key: older Journal entries stored only the localised genus.
      const i = this.rows.findIndex(
        (r) =>
          (record.genusToken !== null && r.genusToken === record.genusToken) ||
          (record.genus !== null && r.genus === record.genus),
      );
      if (i === -1) continue;

      const row = this.rows[i]!;
      const needsIdentity = row.species === null && record.species !== null;
      if (row.completed && !needsIdentity) continue;

      this.rows[i] = {
        ...row,
        // Kept if already known from this session; the Journal fills the gap
        // after a restart rather than overwriting live observation.
        species: row.species ?? record.species,
        speciesToken: row.speciesToken ?? record.speciesToken,
        colour: row.colour ?? record.colour,
        samplesTaken: SAMPLES_REQUIRED,
        completed: true,
        updatedAt: row.updatedAt ?? '',
      };
      this.dirty.add(row.genusToken);
      changed = true;
    }

    if (changed && this.activeGenusToken !== null) {
      const active = this.rows.find((r) => r.genusToken === this.activeGenusToken);
      if (active?.completed) this.activeGenusToken = null;
    }
    return changed;
  }

  /**
   * Put the commander on a body without a journal event saying so.
   *
   * Needed at startup: the reader resumes from a byte offset, so a commander
   * already standing on a planet generates no `ApproachBody` for the app to
   * see, and the roster stayed empty until they happened to scan something.
   */
  enterKnownBody(ref: BodyRef): boolean {
    return this.enterBody(ref);
  }

  /**
   * Install stored rows for the body just entered.
   *
   * Merged rather than replacing: a surface scan seen since arrival may already
   * have added genera that storage does not know about yet.
   */
  hydrate(body: BodyRef, stored: readonly SpeciesProgress[]): void {
    if (this.body === null || bodyKey(this.body.systemAddress, this.body.bodyId) !== bodyKey(body.systemAddress, body.bodyId)) {
      return;
    }
    for (const row of stored) {
      const i = this.rows.findIndex((r) => r.genusToken === row.genusToken);
      if (i === -1) this.rows.push(row);
      // Stored state wins for a row this session has not touched, because it
      // carries progress this session never saw.
      else if (!this.dirty.has(row.genusToken)) this.rows[i] = row;
    }
    this.sortRows();
    this.activeGenusToken =
      this.rows.find((r) => !r.completed && (r.samplesTaken === null || r.samplesTaken > 0))
        ?.genusToken ?? null;
    if (this.updatedAt === '') {
      this.updatedAt = stored.reduce<string>((max, r) => (r.updatedAt && r.updatedAt > max ? r.updatedAt : max), '');
    }
  }

  /** Genus order follows the surface scan; anything unlisted goes last. */
  private sortRows(): void {
    // Insertion order is already scan order; nothing to do beyond keeping
    // completed rows where they are, so the list does not jump around as the
    // commander works.
  }

  setCommander(fid: string | null): void {
    if (fid === this.commanderFid) return;
    this.commanderFid = fid;
    this.leaveBody();
  }

  private leaveBody(): void {
    this.body = null;
    this.rows = [];
    this.activeGenusToken = null;
    this.updatedAt = '';
    this.hydrationNeeded = null;
    this.dirty.clear();
  }

  private enterBody(ref: BodyRef): boolean {
    if (this.body !== null && bodyKey(this.body.systemAddress, this.body.bodyId) === bodyKey(ref.systemAddress, ref.bodyId)) {
      // Same body; fill in a name or system that arrived later.
      const better: BodyRef = {
        ...this.body,
        bodyName: this.body.bodyName ?? ref.bodyName,
        systemName: this.body.systemName ?? ref.systemName,
      };
      const changed = better.bodyName !== this.body.bodyName || better.systemName !== this.body.systemName;
      this.body = better;
      return changed;
    }
    this.leaveBody();
    this.body = ref;
    this.hydrationNeeded = ref;
    return true;
  }

  /**
   * Observe one event.
   *
   * Returns true when what the overlay would draw has changed.
   */
  observe(event: NormalizedEvent, bodyNames: ReadonlyMap<number, string>): boolean {
    const name = event.source.event;
    const raw = event.source.raw as Record<string, unknown>;
    const at = event.source.provenance.timestamp;

    /*
     * Arrival. `ApproachBody` covers 56 of 56 sampled bodies in the corpus and
     * carries the body name, which is why it is the primary signal rather than
     * something inferred from a scan.
     */
    if (name === 'ApproachBody' || name === 'Touchdown') {
      const bodyId = num(raw, 'BodyID');
      if (bodyId === null) return false;
      if (name === 'Touchdown' && raw['OnPlanet'] !== true) return false;
      return this.enterBody({
        systemAddress: num(raw, 'SystemAddress'),
        bodyId,
        bodyName: str(raw, 'Body') ?? bodyNames.get(bodyId) ?? null,
        systemName: str(raw, 'StarSystem'),
      });
    }

    /*
     * Departure. A body visit more often ends with `SupercruiseEntry` (471) than
     * with `LeaveBody` (41), so both are honoured; leaving the system ends it too.
     *
     * Nothing is discarded here -- rows are already stored. Only the display
     * stops, because the commander is no longer there.
     */
    if (name === 'SupercruiseEntry' || name === 'LeaveBody' || name === 'FSDJump' || name === 'CarrierJump') {
      if (this.body === null) return false;
      this.leaveBody();
      return true;
    }

    if (name === 'SAASignalsFound') return this.observeSurfaceScan(raw, at, bodyNames);
    if (name === 'ScanOrganic') return this.observeScan(raw, at, bodyNames);

    return false;
  }

  /** A detailed surface scan: which genera this body carries. */
  /**
   * A detailed surface scan: which genera this body carries.
   *
   * Recorded for **every** body scanned, not only the one underfoot. Commanders
   * scan from orbit and then pick which body to land on, so the list almost
   * always arrives first.
   */
  private observeSurfaceScan(
    raw: Record<string, unknown>,
    at: string,
    bodyNames: ReadonlyMap<number, string>,
  ): boolean {
    const genuses = Array.isArray(raw['Genuses']) ? (raw['Genuses'] as Record<string, unknown>[]) : [];
    if (genuses.length === 0) return false;

    const bodyId = num(raw, 'BodyID');
    if (bodyId === null) return false;
    const systemAddress = num(raw, 'SystemAddress');

    const fresh = (): SpeciesProgress[] => {
      const rows: SpeciesProgress[] = [];
      for (const g of genuses) {
        const token = str(g, 'Genus');
        if (token === null) continue;
        if (rows.some((r) => r.genusToken === token)) continue;
        if (rows.length >= MAX_GENERA_PER_BODY) break;
        rows.push({
          genusToken: token,
          genus: str(g, 'Genus_Localised') ?? token,
          // A surface scan reports a genus and nothing finer, so the species
          // stays unknown until something is collected from it.
          speciesToken: null,
          species: null,
          colour: null,
          samplesTaken: 0,
          samplesRequired: SAMPLES_REQUIRED,
          completed: false,
          startedAt: null,
          updatedAt: at,
        });
      }
      return rows;
    };

    const here =
      this.body !== null &&
      bodyKey(this.body.systemAddress, this.body.bodyId) === bodyKey(systemAddress, bodyId);

    if (!here) {
      // Learned for later. Stored by the caller so arrival is a read.
      const key = bodyKey(systemAddress, bodyId);
      this.pendingRosters.set(key, {
        body: {
          systemAddress,
          bodyId,
          bodyName: str(raw, 'BodyName') ?? bodyNames.get(bodyId) ?? null,
          systemName: null,
        },
        rows: fresh(),
      });
      // Nothing on screen changed: the commander is somewhere else.
      return false;
    }

    let added = false;
    for (const row of fresh()) {
      if (this.rows.some((r) => r.genusToken === row.genusToken)) continue;
      if (this.rows.length >= MAX_GENERA_PER_BODY) break;
      this.rows.push(row);
      this.dirty.add(row.genusToken);
      added = true;
    }

    if (added) {
      this.updatedAt = at;
      if (this.body !== null && this.body.bodyName === null) {
        this.body = {
          ...this.body,
          bodyName: str(raw, 'BodyName') ?? bodyNames.get(bodyId) ?? null,
        };
      }
    }
    return added;
  }

  private observeScan(
    raw: Record<string, unknown>,
    at: string,
    bodyNames: ReadonlyMap<number, string>,
  ): boolean {
    const scanType = str(raw, 'ScanType');
    const genusToken = str(raw, 'Genus');
    const bodyId = num(raw, 'Body');
    if (scanType === null || genusToken === null || bodyId === null) return false;

    const systemAddress = num(raw, 'SystemAddress');

    // A scan is also an arrival signal, for the case where nothing else said so.
    this.enterBody({
      systemAddress,
      bodyId,
      bodyName: bodyNames.get(bodyId) ?? null,
      systemName: this.body?.systemName ?? null,
    });

    const { species, colour } = splitVariant(
      str(raw, 'Variant_Localised'),
      str(raw, 'Species_Localised'),
    );

    let i = this.rows.findIndex((r) => r.genusToken === genusToken);
    if (i === -1) {
      /*
       * A genus no surface scan listed. Never observed -- zero genera were
       * sampled that the body's scan had not listed -- but reporting a specimen
       * the commander is visibly holding would be worse than a roster one row
       * longer.
       */
      this.rows.push({
        genusToken,
        genus: str(raw, 'Genus_Localised') ?? genusToken,
        speciesToken: null,
        species: null,
        colour: null,
        samplesTaken: 0,
        samplesRequired: SAMPLES_REQUIRED,
        completed: false,
        startedAt: null,
        updatedAt: at,
      });
      i = this.rows.length - 1;
    }

    const prior = this.rows[i]!;
    const identity = {
      speciesToken: str(raw, 'Species'),
      species,
      colour,
      genus: str(raw, 'Genus_Localised') ?? prior.genus,
    };

    let samplesTaken: number | null;
    let completed = false;

    if (scanType === 'Analyse') {
      // Proof of three, whatever this process saw beforehand.
      samplesTaken = SAMPLES_REQUIRED;
      completed = true;
    } else if (scanType === 'Log') {
      samplesTaken = 1;
    } else if (scanType === 'Sample') {
      const wasCounting = !prior.completed && prior.samplesTaken !== null && prior.samplesTaken > 0;
      samplesTaken = wasCounting ? Math.min(prior.samplesTaken! + 1, SAMPLES_REQUIRED) : null;
    } else {
      return false;
    }

    this.rows[i] = {
      ...prior,
      ...identity,
      samplesTaken,
      samplesRequired: SAMPLES_REQUIRED,
      completed,
      startedAt: scanType === 'Log' ? at : (prior.startedAt ?? at),
      updatedAt: at,
    };
    this.dirty.add(genusToken);

    /*
     * One specimen at a time. Starting a different genus returns the previous
     * partial row to unscanned: of 80 completed runs every one was contiguous,
     * and the only 3 interrupted runs never completed, so partial progress does
     * not appear to survive switching organisms.
     *
     * Completed rows are untouched -- `Analyse` banked them.
     */
    if (!completed) {
      for (let j = 0; j < this.rows.length; j += 1) {
        if (j === i) continue;
        const other = this.rows[j]!;
        if (other.completed) continue;
        if (other.samplesTaken === 0) continue;
        this.rows[j] = { ...other, samplesTaken: 0, speciesToken: other.speciesToken, updatedAt: at };
        this.dirty.add(other.genusToken);
      }
    }

    this.activeGenusToken = completed ? null : genusToken;
    this.updatedAt = at;

    if (this.body !== null && this.body.bodyName === null) {
      const found = bodyNames.get(bodyId);
      if (found !== undefined) this.body = { ...this.body, bodyName: found };
    }
    return true;
  }

  /** Fill in a body name that arrived after the scan did. */
  resolveBodyName(bodyNames: ReadonlyMap<number, string>): boolean {
    if (this.body === null || this.body.bodyName !== null) return false;
    const found = bodyNames.get(this.body.bodyId);
    if (found === undefined) return false;
    this.body = { ...this.body, bodyName: found };
    return true;
  }

  /** Attach a system name once one is known. */
  setSystem(systemName: string | null, systemAddress: number | null): void {
    if (this.body === null || systemName === null) return;
    if (this.body.systemName === systemName) return;
    if (systemAddress !== null && this.body.systemAddress !== null && systemAddress !== this.body.systemAddress) {
      return;
    }
    this.body = { ...this.body, systemName };
  }
}
