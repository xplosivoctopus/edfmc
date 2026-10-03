/**
 * Mission store.
 *
 * Folds mission events into a durable picture of what the commander has accepted,
 * and reconciles against the `Missions` snapshot the game emits at session start.
 *
 * Everything here joins on **MissionID only**. The `Missions` snapshot reports a
 * different `Name` than `MissionAccepted` for the same mission — `Mission_Altruism`
 * becomes `Mission_Altruism_name`, and a colonisation entry appears as
 * `$Mission_Colonisation_Initial_Name;` — so name-based joining would silently fail.
 */

import { UNKNOWN, isKnown, type Known, type NormalizedEvent } from '@edfm/elite-journal';

import type { DestinationGroup, Mission, MissionCategory, MissionStatus, MissionSummary } from './types.js';

/* ------------------------------------------------------------------ helpers */

function str(o: Readonly<Record<string, unknown>>, k: string): Known<string> {
  const v = o[k];
  return typeof v === 'string' ? v : UNKNOWN;
}
function num(o: Readonly<Record<string, unknown>>, k: string): Known<number> {
  const v = o[k];
  if (typeof v === 'number') return v;
  // Donation is a STRING on MissionAccepted ("750000") but a number on
  // MissionCompleted ("Donated":750000). Accept both rather than losing it.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return UNKNOWN;
}
function bool(o: Readonly<Record<string, unknown>>, k: string): Known<boolean> {
  const v = o[k];
  return typeof v === 'boolean' ? v : UNKNOWN;
}

/**
 * Normalize a mission name into a stable key.
 *
 * Frontier's casing is inconsistent (`MISSION_Salvage_Illegal` alongside
 * `Mission_Courier`), the snapshot appends `_name`, and some entries are wrapped
 * as `$Mission_X_Name;`. All three forms fold to the same key.
 */
export function missionTypeKey(name: string): string {
  return name
    .trim()
    .replace(/^\$/, '')
    .replace(/;$/, '')
    .replace(/_name$/i, '')
    .toLowerCase();
}

/** Map a mission key to a broad category. Order matters: more specific first. */
export function missionCategory(typeKey: string): MissionCategory {
  const k = typeKey;
  if (k.includes('massacre')) return 'massacre';
  if (k.includes('assassinate')) return 'assassination';
  if (k.includes('altruism')) return 'donation'; // includes AltruismCredits
  if (k.includes('passenger') || k.includes('sightsee')) return 'passenger';
  if (k.includes('salvage')) return 'salvage';
  if (k.includes('collect')) return 'collect';
  if (k.includes('mining')) return 'mining';
  if (k.includes('delivery') || k.includes('deliverywing')) return 'delivery';
  if (k.includes('courier')) return 'courier';
  if (k.includes('hack') || k.includes('onslaught')) return 'hack';
  if (k.includes('permit')) return 'permit';
  return 'other';
}

/**
 * JavaScript loses precision above 2^53. Frontier's MissionID is u64, and the
 * colonisation sentinel (2^64-1) exceeds it.
 */
function idIsReliable(id: number): boolean {
  return Number.isSafeInteger(id);
}

/** The colonisation pseudo-mission sentinel, seen 113 times in the corpus. */
const COLONISATION_SENTINEL = 18446744073709551615;

/**
 * Whether a mission actually requires cargo.
 *
 * Decided from the data — a commodity and a count — rather than from the mission
 * category. Category is itself an inference from a name, and it gets this wrong:
 * `Mission_Altruism` categorises as a donation but is "donate 32 units of Micro
 * Controllers", which needs 32t of hold. `Mission_AltruismCredits` is the same
 * category and needs none. The journal already says which is which.
 */
function carriesCargo(m: Mission): boolean {
  return isKnown(m.commodity) && isKnown(m.count) && m.count > 0;
}

/**
 * Cargo still owed on a mission, or null when it does not carry cargo.
 *
 * Prefers real delivery progress over the original requirement. Having handed in
 * 1,236 of 1,386, what the commander needs to know is 150 — the accepted total is
 * the wrong number to plan the next run around.
 */
export function remainingCargo(m: Mission): number | null {
  if (isKnown(m.totalToDeliver) && isKnown(m.delivered)) {
    return Math.max(0, m.totalToDeliver - m.delivered);
  }
  return carriesCargo(m) ? (m.count as number) : null;
}

/** True once any delivery has been recorded against this mission. */
export function hasDeliveryProgress(m: Mission): boolean {
  return isKnown(m.totalToDeliver) && isKnown(m.delivered);
}

/**
 * Whether the work is done and only handing it in remains.
 *
 * Two signals, both reported rather than inferred:
 *
 * 1. **`MissionRedirected` has fired.** The game moves a mission's destination
 *    when its objective is met and it wants you to return -- a massacre's kills
 *    reached, a scan taken. That is the game saying "done, come back", and it
 *    is already recorded as `redirected`.
 * 2. **Every item has been delivered.** `CargoDepot` reports `ItemsDelivered`
 *    against `TotalItemsToDeliver`, so a depot mission is finished when the
 *    first reaches the second. Redirection does not fire for these.
 *
 * Deliberately NOT inferred for anything else. A kill mission with no
 * redirection yet is not "probably nearly done" -- counting `Bounty` events
 * against a target would be a guess, and the overlay would tell a commander
 * their work was finished when it was not. Anything this cannot establish stays
 * simply active, which is the honest answer.
 *
 * This is distinct from `status === 'completed'`, which means `MissionCompleted`
 * fired -- the mission was HANDED IN and is no longer active at all.
 */
export function isAwaitingTurnIn(m: Mission): boolean {
  if (m.status !== 'active') return false;
  if (m.redirected) return true;
  return (
    isKnown(m.totalToDeliver) &&
    isKnown(m.delivered) &&
    m.totalToDeliver > 0 &&
    m.delivered >= m.totalToDeliver
  );
}

/**
 * Categories that normally involve cargo. Used only to decide whether a *missing*
 * commodity/count is worth flagging, never to count cargo.
 */
const CARGO_CATEGORIES = new Set<MissionCategory>([
  'delivery',
  'collect',
  'courier',
  'salvage',
  'mining',
]);

function mightCarryCargo(m: Mission): boolean {
  return CARGO_CATEGORIES.has(m.category);
}

/* -------------------------------------------------------------------- store */

export interface MissionStoreOptions {
  readonly now?: () => number;
  /** Missions expiring within this window count as "expiring soon". */
  readonly expiringSoonMs?: number;
}

export class MissionStore {
  private readonly missions = new Map<number, Mission>();
  private readonly now: () => number;
  private readonly expiringSoonMs: number;

  constructor(options: MissionStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.expiringSoonMs = options.expiringSoonMs ?? 60 * 60 * 1000;
  }

  /** Seed from persisted rows on startup. */
  load(missions: readonly Mission[]): void {
    for (const m of missions) this.missions.set(m.missionId, m);
  }

  all(): readonly Mission[] {
    return [...this.missions.values()];
  }

  active(): readonly Mission[] {
    return this.all().filter((m) => m.status === 'active');
  }

  get(id: number): Mission | undefined {
    return this.missions.get(id);
  }

  /**
   * Fold one event in. Returns true when something changed, so the caller can
   * skip re-rendering for the vast majority of events that are not missions.
   */
  observe(event: NormalizedEvent): boolean {
    const raw = event.source.raw;

    switch (event.source.event) {
      case 'MissionAccepted':
        return this.accept(event);

      case 'MissionCompleted':
        return this.end(raw, 'completed', event);
      case 'MissionFailed':
        return this.end(raw, 'failed', event);
      case 'MissionAbandoned':
        return this.end(raw, 'abandoned', event);

      case 'MissionRedirected':
        return this.redirect(raw);

      case 'CargoDepot':
        return this.depot(raw);

      case 'Missions':
        return this.reconcile(raw);

      default:
        return false;
    }
  }

  private accept(event: NormalizedEvent): boolean {
    const raw = event.source.raw;
    const id = raw['MissionID'];
    const name = raw['Name'];
    if (typeof id !== 'number' || typeof name !== 'string') return false;
    if (id === COLONISATION_SENTINEL) return false; // not a real mission

    const typeKey = missionTypeKey(name);
    const mission: Mission = {
      missionId: id,
      idIsReliable: idIsReliable(id),
      name,
      typeKey,
      category: missionCategory(typeKey),
      localisedName: str(raw, 'LocalisedName'),
      faction: str(raw, 'Faction'),
      influence: str(raw, 'Influence'),
      reputation: str(raw, 'Reputation'),
      wing: bool(raw, 'Wing'),
      destinationSystem: str(raw, 'DestinationSystem'),
      destinationStation: str(raw, 'DestinationStation'),
      destinationSettlement: str(raw, 'DestinationSettlement'),
      targetFaction: str(raw, 'TargetFaction'),
      target: str(raw, 'Target'),
      targetType: str(raw, 'TargetType'),
      commodity: str(raw, 'Commodity'),
      commodityLocalised: str(raw, 'Commodity_Localised'),
      count: num(raw, 'Count'),
      killCount: num(raw, 'KillCount'),
      passengerCount: num(raw, 'PassengerCount'),
      passengerType: str(raw, 'PassengerType'),
      passengerVips: bool(raw, 'PassengerVIPs'),
      passengerWanted: bool(raw, 'PassengerWanted'),
      // Populated by CargoDepot, not by acceptance.
      delivered: UNKNOWN,
      totalToDeliver: UNKNOWN,
      collected: UNKNOWN,
      reward: num(raw, 'Reward'),
      donation: num(raw, 'Donation'),
      expiry: str(raw, 'Expiry'),
      status: 'active',
      redirected: false,
      acceptedAt: event.source.provenance.timestamp,
      sourceEventId: event.source.provenance.eventId,
      gameVersion: event.source.provenance.gameVersion,
      endedAt: null,
    };

    this.missions.set(id, mission);
    return true;
  }

  private end(
    raw: Readonly<Record<string, unknown>>,
    status: MissionStatus,
    event: NormalizedEvent,
  ): boolean {
    const id = raw['MissionID'];
    if (typeof id !== 'number') return false;

    const existing = this.missions.get(id);
    if (!existing) {
      // Completed a mission accepted before we were watching. We know the outcome
      // but almost nothing else; recording a stub is more honest than dropping it.
      if (status !== 'completed') return false;
      const name = typeof raw['Name'] === 'string' ? raw['Name'] : 'Unknown';
      const typeKey = missionTypeKey(name);
      this.missions.set(id, {
        ...emptyMission(id, name, typeKey, event),
        status,
        endedAt: event.source.provenance.timestamp,
        faction: str(raw, 'Faction'),
        localisedName: str(raw, 'LocalisedName'),
      });
      return true;
    }

    if (existing.status === status) return false;
    this.missions.set(id, {
      ...existing,
      status,
      endedAt: event.source.provenance.timestamp,
    });
    return true;
  }

  private redirect(raw: Readonly<Record<string, unknown>>): boolean {
    const id = raw['MissionID'];
    if (typeof id !== 'number') return false;
    const existing = this.missions.get(id);
    if (!existing) return false;

    // All nine MissionRedirected fields were present on 100% of n=67.
    return this.replace(id, {
      ...existing,
      destinationSystem: str(raw, 'NewDestinationSystem'),
      destinationStation: str(raw, 'NewDestinationStation'),
      redirected: true,
    });
  }

  /**
   * Record delivery progress from a CargoDepot event.
   *
   * `ItemsDelivered` is cumulative, so it is assigned rather than accumulated —
   * adding successive events would double-count, and replaying a journal would
   * inflate it without bound.
   *
   * Deliberately ignores `Progress`, which read 0.000000 on 43 of 45 observed
   * events and therefore carries no information.
   */
  private depot(raw: Readonly<Record<string, unknown>>): boolean {
    const id = raw['MissionID'];
    if (typeof id !== 'number') return false;

    const existing = this.missions.get(id);
    if (!existing) return false; // depot update for a mission we never saw accepted

    const delivered = num(raw, 'ItemsDelivered');
    const total = num(raw, 'TotalItemsToDeliver');
    const collected = num(raw, 'ItemsCollected');

    if (
      existing.delivered === delivered &&
      existing.totalToDeliver === total &&
      existing.collected === collected
    ) {
      return false;
    }

    return this.replace(id, {
      ...existing,
      delivered,
      totalToDeliver: total,
      collected,
      // TotalItemsToDeliver matched MissionAccepted.Count in every case checked,
      // but the depot event is the more authoritative statement of the
      // requirement, so it fills a count we never learned.
      count: isKnown(existing.count) ? existing.count : total,
    });
  }

  /**
   * Reconcile against the game's own list of missions.
   *
   * This is the authoritative answer to "what is actually active", and the only
   * way to notice missions that ended while the application was closed.
   */
  private reconcile(raw: Readonly<Record<string, unknown>>): boolean {
    const active = idsFrom(raw['Active']);
    const complete = idsFrom(raw['Complete']);
    const failed = idsFrom(raw['Failed']);
    if (!active && !complete && !failed) return false;

    const known = new Set<number>([...(active ?? []), ...(complete ?? []), ...(failed ?? [])]);
    let changed = false;

    for (const id of complete ?? []) changed = this.setStatus(id, 'completed') || changed;
    for (const id of failed ?? []) changed = this.setStatus(id, 'failed') || changed;

    for (const mission of this.missions.values()) {
      if (mission.status !== 'active') continue;
      if (known.has(mission.missionId)) continue;
      // The game no longer lists it. It ended somehow — completed, failed,
      // abandoned or expired — and the journal does not say which. Guessing
      // "completed" would inflate the commander's record.
      changed = this.setStatus(mission.missionId, 'ended-unknown') || changed;
    }

    return changed;
  }

  private setStatus(id: number, status: MissionStatus): boolean {
    const existing = this.missions.get(id);
    if (!existing || existing.status === status) return false;
    return this.replace(id, {
      ...existing,
      status,
      endedAt: existing.endedAt ?? new Date(this.now()).toISOString(),
    });
  }

  private replace(id: number, mission: Mission): boolean {
    this.missions.set(id, mission);
    return true;
  }

  /* ------------------------------------------------------------- grouping */

  /**
   * Group active missions by destination.
   *
   * Missions with no destination are returned separately rather than bundled
   * under a placeholder, because "the game did not say where" is different from
   * "somewhere unnamed" (§8).
   */
  byDestination(): { groups: readonly DestinationGroup[]; withoutDestination: readonly Mission[] } {
    const groups = new Map<string, Mission[]>();
    const without: Mission[] = [];

    for (const mission of this.active()) {
      if (!isKnown(mission.destinationSystem)) {
        without.push(mission);
        continue;
      }
      const station = isKnown(mission.destinationStation) ? mission.destinationStation : null;
      // JSON rather than a delimiter string: station names contain spaces,
      // punctuation and colons, so any separator risks two different
      // system/station pairs colliding into one group.
      const key = JSON.stringify([mission.destinationSystem, station]);
      const bucket = groups.get(key);
      if (bucket) bucket.push(mission);
      else groups.set(key, [mission]);
    }

    const out: DestinationGroup[] = [];
    for (const [key, missions] of groups) {
      const first = missions[0]!;
      const system = first.destinationSystem as string;
      const station = isKnown(first.destinationStation) ? first.destinationStation : null;

      let cargo = 0;
      let cargoIncomplete = false;
      let kills = 0;
      const factions = new Set<string>();
      let earliest: string | null = null;

      for (const m of missions) {
        // Remaining, not the accepted total: after handing in 1,236 of 1,386 the
        // number that matters for the next run is 150.
        const owed = remainingCargo(m);
        if (owed !== null) cargo += owed;
        else if (mightCarryCargo(m)) cargoIncomplete = true;
        if (isKnown(m.killCount)) kills += m.killCount;
        if (isKnown(m.targetFaction)) factions.add(m.targetFaction);
        if (isKnown(m.expiry) && (earliest === null || m.expiry < earliest)) earliest = m.expiry;
      }

      out.push({
        system,
        station,
        key,
        missions,
        missionCount: missions.length,
        cargoRequired: cargo,
        cargoIncomplete,
        earliestExpiry: earliest,
        targetFactions: [...factions].sort(),
        killsRequired: kills,
      });
    }

    // Most missions first; earliest deadline breaks ties.
    out.sort(
      (a, b) =>
        b.missionCount - a.missionCount ||
        (a.earliestExpiry ?? '￿').localeCompare(b.earliestExpiry ?? '￿'),
    );
    return { groups: out, withoutDestination: without };
  }

  /** Active missions ordered by expiry. Missions with no expiry sort last. */
  byExpiry(): readonly Mission[] {
    return [...this.active()].sort((a, b) => {
      const ax = isKnown(a.expiry) ? a.expiry : '￿';
      const bx = isKnown(b.expiry) ? b.expiry : '￿';
      return ax.localeCompare(bx);
    });
  }

  byCategory(): ReadonlyMap<MissionCategory, readonly Mission[]> {
    const out = new Map<MissionCategory, Mission[]>();
    for (const m of this.active()) {
      const bucket = out.get(m.category);
      if (bucket) bucket.push(m);
      else out.set(m.category, [m]);
    }
    return out;
  }

  summary(): MissionSummary {
    const active = this.active();
    const soon = new Date(this.now() + this.expiringSoonMs).toISOString();
    const categories: Record<string, number> = {};
    let cargo = 0;
    let withoutDestination = 0;
    let expiringSoon = 0;

    for (const m of active) {
      categories[m.category] = (categories[m.category] ?? 0) + 1;
      if (!isKnown(m.destinationSystem)) withoutDestination += 1;
      if (isKnown(m.expiry) && m.expiry <= soon) expiringSoon += 1;
      const owed = remainingCargo(m);
      if (owed !== null) cargo += owed;
    }

    return {
      active: active.length,
      withoutDestination,
      expiringSoon,
      totalCargo: cargo,
      categories,
    };
  }
}

/** Extract MissionIDs from a snapshot array, or null when the field is absent. */
function idsFrom(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = (entry as Record<string, unknown>)['MissionID'];
    // The colonisation sentinel is excluded: it is not a mission, and its value
    // has already lost precision by the time it reaches us.
    if (typeof id === 'number' && Number.isSafeInteger(id)) out.push(id);
  }
  return out;
}

function emptyMission(
  id: number,
  name: string,
  typeKey: string,
  event: NormalizedEvent,
): Mission {
  return {
    missionId: id,
    idIsReliable: idIsReliable(id),
    name,
    typeKey,
    category: missionCategory(typeKey),
    localisedName: UNKNOWN,
    faction: UNKNOWN,
    influence: UNKNOWN,
    reputation: UNKNOWN,
    wing: UNKNOWN,
    destinationSystem: UNKNOWN,
    destinationStation: UNKNOWN,
    destinationSettlement: UNKNOWN,
    targetFaction: UNKNOWN,
    target: UNKNOWN,
    targetType: UNKNOWN,
    commodity: UNKNOWN,
    commodityLocalised: UNKNOWN,
    count: UNKNOWN,
    killCount: UNKNOWN,
    passengerCount: UNKNOWN,
    passengerType: UNKNOWN,
    passengerVips: UNKNOWN,
    passengerWanted: UNKNOWN,
    delivered: UNKNOWN,
    totalToDeliver: UNKNOWN,
    collected: UNKNOWN,
    reward: UNKNOWN,
    donation: UNKNOWN,
    expiry: UNKNOWN,
    status: 'active',
    redirected: false,
    acceptedAt: event.source.provenance.timestamp,
    sourceEventId: event.source.provenance.eventId,
    gameVersion: event.source.provenance.gameVersion,
    endedAt: null,
  };
}
