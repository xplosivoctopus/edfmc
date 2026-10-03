/**
 * The Activity Journal engine.
 *
 * Feeds journal events through the processors and keeps the small amount of
 * context they need. Deliberately owns no storage: it returns entries, and the
 * caller decides what to do with them. That is what lets the whole thing be
 * tested against the real corpus without a database.
 *
 * ## Why it holds state at all
 *
 * One thing: BodyID to name. `ScanOrganic` reports `Body` as an integer, so an
 * entry that wants to say *which* body needs a name from somewhere else --
 * `Scan`, `SAASignalsFound` and `Touchdown` all carry both. Resolving it at write
 * time rather than at display time means the entry is self-contained and survives
 * the map being lost on restart.
 *
 * The map is bounded and cleared when the commander leaves a system, because a
 * BodyID is only unique within one.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import {
  biologicalSignalEntries,
  exobiologyEntries,
  footfallEntries,
} from './exobiology.js';
import { missionEntries } from './missions.js';
import type { ActivityContext, ActivityEntry } from './types.js';

/** A system has a few dozen bodies; this is slack, not a target. */
const MAX_TRACKED_BODIES = 512;

export interface ActivityEngineOptions {
  /** Entries are scoped to a commander; nothing is recorded without one. */
  readonly commanderFid: string | null;
}

export class ActivityEngine {
  private commanderFid: string | null;
  private bodyNames = new Map<number, string>();
  /** BodyID -> WasFootfalled as reported when that body was scanned. */
  private footfallWhenScanned = new Map<number, boolean>();
  private systemName: string | null = null;
  private systemAddress: number | null = null;

  constructor(options: ActivityEngineOptions) {
    this.commanderFid = options.commanderFid;
  }

  /**
   * BodyID to name, as learned so far.
   *
   * Exposed read-only so live activity can resolve a body without building a
   * second map. `ScanOrganic` reports `Body` as an integer, and there should be
   * exactly one implementation that knows how to turn that into a name.
   */
  get bodyNameMap(): ReadonlyMap<number, string> {
    return this.bodyNames;
  }

  /**
   * The commander changed.
   *
   * Everything learned about bodies belongs to the previous session's location,
   * and entries are scoped by FID, so this starts clean rather than risking one
   * commander's activity being attributed to another.
   */
  setCommander(fid: string | null): void {
    if (fid === this.commanderFid) return;
    this.commanderFid = fid;
    this.reset();
  }

  private reset(): void {
    this.bodyNames.clear();
    this.footfallWhenScanned.clear();
  }

  /**
   * Observe one event and return whatever activity it represents.
   *
   * Returns an empty array for the overwhelming majority, which is the point:
   * the journal is noisy and the activity record should not be.
   */
  observe(event: NormalizedEvent): readonly ActivityEntry[] {
    const raw = event.source.raw as Record<string, unknown>;
    const name = event.source.event;

    this.trackLocation(name, raw);
    this.trackBodies(name, raw);

    // No commander yet means the session header has not been read. Recording
    // against an unknown FID would put entries somewhere no commander can see.
    if (this.commanderFid === null) return [];

    const ctx: ActivityContext = {
      commanderFid: this.commanderFid,
      bodyNames: this.bodyNames,
      systemName: this.systemName,
      systemAddress: this.systemAddress,
    };

    const bodyId = typeof raw['BodyID'] === 'number' ? (raw['BodyID'] as number) : null;
    const footfall = bodyId === null ? null : (this.footfallWhenScanned.get(bodyId) ?? null);

    /*
     * Once footfall is recorded the body is walked, so the flag is flipped to
     * stop the next disembark repeating the entry. The corpus has disembark
     * pairs on one body a minute apart, so this is the ordinary case, not an
     * edge case.
     */
    if (bodyId !== null && footfall === false && name === 'Disembark' && raw['OnPlanet'] === true) {
      this.footfallWhenScanned.set(bodyId, true);
    }

    return [
      ...exobiologyEntries(event, ctx),
      ...biologicalSignalEntries(event, ctx),
      ...footfallEntries(event, ctx, footfall),
      ...missionEntries(event, ctx),
    ];
  }

  private trackLocation(name: string, raw: Record<string, unknown>): void {
    if (name !== 'FSDJump' && name !== 'Location' && name !== 'CarrierJump') return;
    const system = typeof raw['StarSystem'] === 'string' ? raw['StarSystem'] : null;
    const address = typeof raw['SystemAddress'] === 'number' ? (raw['SystemAddress'] as number) : null;

    // A BodyID is only unique within a system, so carrying the map across a jump
    // would eventually attach the wrong name to an entry.
    if (address !== null && address !== this.systemAddress) this.reset();
    this.systemName = system ?? this.systemName;
    this.systemAddress = address ?? this.systemAddress;
  }

  /** Learn BodyID -> name, and the footfall state reported at scan time. */
  private trackBodies(name: string, raw: Record<string, unknown>): void {
    const id = typeof raw['BodyID'] === 'number' ? (raw['BodyID'] as number) : null;
    if (id === null) return;

    // Scan and SAASignalsFound call it BodyName; Touchdown calls it Body.
    const bodyName =
      typeof raw['BodyName'] === 'string'
        ? raw['BodyName']
        : (name === 'Touchdown' || name === 'Disembark') && typeof raw['Body'] === 'string'
          ? raw['Body']
          : null;

    if (bodyName !== null && this.bodyNames.size < MAX_TRACKED_BODIES) {
      this.bodyNames.set(id, bodyName);
    }

    // Prior state, recorded as reported. Not evidence that the commander
    // achieved a first footfall -- nothing in the journal reports that.
    if (name === 'Scan' && typeof raw['WasFootfalled'] === 'boolean') {
      if (this.footfallWhenScanned.size < MAX_TRACKED_BODIES) {
        this.footfallWhenScanned.set(id, raw['WasFootfalled'] as boolean);
      }
    }
  }
}

/**
 * Group entries the way a person reads them: system, then body, then activity.
 *
 * A flat list of "what fired" is the thing this feature exists not to be. The
 * grouping is computed rather than stored, so a later filter or sort does not
 * need a migration.
 */
export interface ActivityGroup {
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly entries: readonly ActivityEntry[];
  /** Earliest entry in the group, for ordering. */
  readonly startedAt: string;
}

export function groupActivity(entries: readonly ActivityEntry[]): readonly ActivityGroup[] {
  const groups = new Map<string, ActivityEntry[]>();

  for (const entry of entries) {
    const key = `${entry.systemName ?? ''}\u0000${entry.bodyName ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      return {
        systemName: sorted[0]!.systemName,
        bodyName: sorted[0]!.bodyName,
        entries: sorted,
        startedAt: sorted[0]!.occurredAt,
      };
    })
    // Newest group first: the journal is read backwards from what just happened.
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
