/**
 * Commander / session state (§4).
 *
 * Governing rule: never guess. Every field starts UNKNOWN and only becomes known
 * when an event actually said so. A field the game did not report stays UNKNOWN
 * rather than defaulting to false/zero/empty, because downstream features
 * (verification especially) must be able to distinguish "absent" from "reported as
 * none".
 */

import type { NormalizedEvent, Known } from './types.js';
import { UNKNOWN, isKnown } from './types.js';
import type {
  ApproachSettlementData,
  DockedData,
  FsdJumpData,
  LocationData,
  StationService,
} from './normalizer.js';

export type DockingState = 'docked' | 'undocked' | 'unknown';
export type VehicleState = 'ship' | 'srv' | 'on-foot' | 'taxi' | 'unknown';

/**
 * Where the commander is, in travel terms.
 *
 * Derived from an explicit event sequence, never inferred from absence:
 *   Docked -> docked
 *   Undocked / Liftoff / SupercruiseExit -> normal-space
 *   SupercruiseEntry -> supercruise
 *   StartJump JumpType=Hyperspace -> witch-space
 *   FSDJump -> supercruise (arrival is always in supercruise)
 *   Touchdown -> landed
 *
 * `StartJump` carries JumpType "Hyperspace" (3842) or "Supercruise" (1644);
 * only the former means witch space. Supercruise entry is taken from
 * SupercruiseEntry rather than StartJump, because the jump can be aborted while
 * charging and no supercruise ever happens.
 */
export type TravelState =
  | 'docked'
  | 'landed'
  | 'normal-space'
  | 'supercruise'
  | 'witch-space'
  | 'unknown';

/**
 * A carrier jump the game has scheduled but not yet confirmed complete.
 *
 * `departureTime` is the instant the game stated, kept verbatim as ISO 8601 so a
 * countdown is rendered from a reported fact rather than a duration we computed and
 * then have to keep correcting.
 */
export interface PendingCarrierJump {
  readonly carrierId: number;
  readonly system: string;
  /** Present on 97.1% of requests; absent when no body was selected. */
  readonly body: Known<string>;
  readonly systemAddress: Known<number>;
  /** ISO 8601, exactly as the journal reported it. */
  readonly departureTime: string;
  /** When the request was seen, for ordering and for expiring a stale record. */
  readonly requestedAt: string;
}

export interface CommanderState {
  commander: Known<string>;
  fid: Known<string>;
  gameVersion: Known<string>;
  build: Known<string>;
  odyssey: Known<boolean>;
  gameMode: Known<string>;

  starSystem: Known<string>;
  systemAddress: Known<number>;
  starPos: Known<readonly [number, number, number]>;

  body: Known<string>;
  /**
   * "Planet", "Star", or "Station".
   *
   * "Station" means Body and StationName are the same thing: the journal reports
   * Body='Elder Hub' alongside StationName='Elder Hub' (89 of 169 docked Location
   * events). Anything else means Body is a real celestial body the station sits on
   * or orbits — a fleet carrier is always Planet or Star — and the two are
   * genuinely different places worth showing separately.
   */
  bodyType: Known<string>;
  bodyId: Known<number>;
  latitude: Known<number>;
  longitude: Known<number>;

  /** Exactly what the journal reported. For a carrier this is the callsign. */
  stationName: Known<string>;
  stationType: Known<string>;
  marketId: Known<number>;
  stationServices: Known<readonly StationService[]>;
  docking: DockingState;

  /**
   * Human-readable name of the carrier currently docked at, when known.
   *
   * Only resolvable for the commander's own carrier: `Docked` carries just the
   * callsign, and the name has to be joined from CarrierStats by CarrierID. At
   * someone else's carrier this stays UNKNOWN, because the journal genuinely does
   * not say — it is not a lookup failure to paper over.
   */
  carrierName: Known<string>;
  /** CarrierID -> name, accumulated from CarrierStats / CarrierNameChange. */
  knownCarriers: Record<number, string>;

  /**
   * Scheduled jumps for the commander's OWN carriers, keyed by CarrierID.
   *
   * Only ever populated from `CarrierJumpRequest`, which the game emits solely for
   * carriers the commander commands. Another commander's carrier can jump out from
   * under you and the journal says nothing about it beforehand -- that is a real
   * gap, not a missing feature, and must not be papered over with a guess.
   *
   * Keyed rather than singular because a commander can command several carriers;
   * this one has three.
   */
  carrierJumps: Record<number, PendingCarrierJump>;

  /**
   * Which kind of Material Trader the current station has: `encoded`, `raw` or
   * `manufactured`.
   *
   * UNKNOWN whenever the station has a trader whose type has not been established,
   * which is the common case -- `StationServices` never names the type, and only a
   * `MaterialTrade` does. "Has a trader, kind unknown" and "has no trader" are
   * different facts, and the `stationServices` list is what distinguishes them.
   */
  traderType: Known<string>;
  /** MarketID -> TraderType, accumulated from MaterialTrade. Stable per station. */
  knownTraders: Record<number, string>;

  /**
   * Completed exobiology scans that are **confirmed** still unsold: a LOWER BOUND
   * on what the commander is carrying, never a claim about the true total.
   *
   * The journal never states exobiology holdings. `Backpack` is suit inventory
   * (Items / Components / Consumables / Data) and `Materials` is engineering stock
   * (Raw / Manufactured / Encoded); neither includes organic data. So the only
   * available answer is accumulated from events.
   *
   * `Analyse` is the scan type that completes a specimen (60 of 243 scans; Log and
   * Sample are progress toward it), and `SellOrganicData.BioData.length` is the
   * only quantity the journal reports for a sale.
   *
   * A death resets it to zero, and that is deliberately the conservative choice
   * rather than a claim about the mechanic. Whether death destroys unsold data
   * could not be established: across 18 deaths in the corpus, no window between
   * two deaths ever sold more than it scanned, which is consistent with both
   * possibilities. Resetting means the app may stay quiet about data the commander
   * still holds -- withholding a reminder. Not resetting would mean telling them to
   * go and sell data they may no longer have, which is the error that actually
   * misleads.
   *
   * Zero therefore means "nothing confirmed", not "you are carrying nothing".
   */
  exobiologyToSell: number;

  travel: TravelState;

  /**
   * System the FSD is currently targeting.
   *
   * From `FSDTarget.Name`, and from `StartJump.StarSystem` while in witch space
   * (100% present on hyperspace jumps, n=3842). Cleared on arrival and when the
   * route is cleared.
   */
  jumpTarget: Known<string>;
  /**
   * Jumps left in the plotted route, from `FSDTarget.RemainingJumpsInRoute`.
   *
   * Present on 94.5% of FSDTarget events (n=4157) — absent when targeting a
   * single system with no route plotted, so UNKNOWN here means "not on a route",
   * not "zero jumps left".
   */
  remainingJumps: Known<number>;

  vehicle: VehicleState;
  ship: Known<string>;
  shipName: Known<string>;
  shipIdent: Known<string>;
  cargoCount: Known<number>;

  /** Most recent settlement approached, for context assistance (Phase 3). */
  lastSettlement: Known<string>;

  /** Provenance of the newest event folded in, for the dashboard and diagnostics. */
  lastEventId: string | null;
  lastEventName: string | null;
  lastEventAt: string | null;
  /** Set when a Shutdown event was seen; the game is known to have exited. */
  shutdown: boolean;
}

export function initialState(): CommanderState {
  return {
    commander: UNKNOWN,
    fid: UNKNOWN,
    gameVersion: UNKNOWN,
    build: UNKNOWN,
    odyssey: UNKNOWN,
    gameMode: UNKNOWN,
    starSystem: UNKNOWN,
    systemAddress: UNKNOWN,
    starPos: UNKNOWN,
    body: UNKNOWN,
    bodyType: UNKNOWN,
    bodyId: UNKNOWN,
    latitude: UNKNOWN,
    longitude: UNKNOWN,
    stationName: UNKNOWN,
    stationType: UNKNOWN,
    marketId: UNKNOWN,
    stationServices: UNKNOWN,
    carrierName: UNKNOWN,
    knownCarriers: {},
    carrierJumps: {},
    traderType: UNKNOWN,
    knownTraders: {},
    exobiologyToSell: 0,
    docking: 'unknown',
    travel: 'unknown',
    jumpTarget: UNKNOWN,
    remainingJumps: UNKNOWN,
    vehicle: 'unknown',
    ship: UNKNOWN,
    shipName: UNKNOWN,
    shipIdent: UNKNOWN,
    cargoCount: UNKNOWN,
    lastSettlement: UNKNOWN,
    lastEventId: null,
    lastEventName: null,
    lastEventAt: null,
    shutdown: false,
  };
}

/** Assign only when the incoming value is actually known — never overwrite with UNKNOWN. */
function set<T>(current: Known<T>, incoming: Known<T>): Known<T> {
  return isKnown(incoming) ? incoming : current;
}

/**
 * Join the docked station to a known carrier name.
 *
 * The link is `Docked.MarketID === CarrierStats.CarrierID`; both were observed as
 * 3703420416 for the same carrier. Leaves `carrierName` UNKNOWN when no identity
 * has been seen, which is the honest answer for another commander's carrier.
 */
function resolveCarrierName(s: CommanderState): void {
  if (!isKnown(s.stationType) || s.stationType !== 'FleetCarrier') return;
  if (!isKnown(s.marketId)) return;
  const name = s.knownCarriers[s.marketId];
  if (name) s.carrierName = name;
}

/**
 * Record a carrier identity and re-resolve the current station if it matches.
 *
 * Separate from `applyEvent` so identities can be loaded from storage or learned
 * from historical journals without those old events overwriting `lastEvent*` and
 * making the dashboard report stale activity.
 */
export function learnCarrier(state: CommanderState, carrierId: number, name: string): void {
  if (!Number.isFinite(carrierId) || name.length === 0) return;
  state.knownCarriers[carrierId] = name;
  if (isKnown(state.marketId) && state.marketId === carrierId) state.carrierName = name;
}

/**
 * Record a scheduled carrier jump.
 *
 * Exported alongside `learnCarrier` and for the same reason: a pending jump has to
 * be recoverable from historical journals at startup, and replaying those events
 * through `applyEvent` would make the dashboard report stale activity as the latest
 * thing that happened.
 */
export function recordCarrierJump(
  state: CommanderState,
  data: unknown,
  requestedAt: string,
): void {
  const d = data as {
    carrierId: Known<number>;
    system: Known<string>;
    systemAddress: Known<number>;
    body: Known<string>;
    departureTime: Known<string>;
  };
  // The destination and the departure instant are the whole point. Without either
  // there is nothing honest to show, so nothing is recorded.
  if (!isKnown(d.carrierId) || !isKnown(d.system) || !isKnown(d.departureTime)) return;

  // A fresh request supersedes any earlier one for the same carrier: the commander
  // re-targeted, and the previous destination is simply no longer true.
  state.carrierJumps[d.carrierId] = {
    carrierId: d.carrierId,
    system: d.system,
    body: d.body,
    systemAddress: d.systemAddress,
    departureTime: d.departureTime,
    requestedAt,
  };
}

export function cancelCarrierJump(state: CommanderState, carrierId: number): void {
  delete state.carrierJumps[carrierId];
}

/**
 * Note where a carrier is, and end a pending jump when it is no longer pending.
 *
 * Originally this cleared only on an exact match with the destination, which
 * stranded countdowns. Measured across 138 real requests:
 *
 *  - 93% confirm within five minutes of the stated departure (median: zero).
 *  - 11 were never confirmed at all.
 *  - Five reported a *different* system next, because the carrier had moved on
 *    again, or the location arrived from a later session.
 *
 * So an exact match is sufficient but not necessary. Once the departure time has
 * passed, **any** report of where that carrier is ends the countdown: whatever it
 * says, the carrier is not still waiting to leave.
 *
 * Note what that does and does not claim. Clearing on a non-matching location
 * does not assert the carrier arrived -- only that there is no longer a pending
 * departure to count down to, which is the only thing that was ever displayed.
 *
 * Before the departure time a non-matching location is just the carrier sitting
 * where it was, and the jump stays pending.
 */
export function confirmCarrierAt(
  state: CommanderState,
  carrierId: number,
  starSystem: string,
  observedAt?: string,
): void {
  const pending = state.carrierJumps[carrierId];
  if (!pending) return;

  if (pending.system === starSystem) {
    delete state.carrierJumps[carrierId];
    return;
  }

  // Without a timestamp there is nothing to compare, so stay conservative.
  if (observedAt === undefined) return;
  const seen = Date.parse(observedAt);
  const departs = Date.parse(pending.departureTime);
  if (Number.isFinite(seen) && Number.isFinite(departs) && seen >= departs) {
    delete state.carrierJumps[carrierId];
  }
}

/**
 * The commander watched the carrier jump.
 *
 * `CarrierJump` fires only when they are aboard, and carries no CarrierID -- but
 * 53 of 73 carry a MarketID, which for a carrier is the same number. That makes
 * it a definitive arrival for the one case where the commander is guaranteed to
 * be looking at the overlay while it happens.
 */
export function confirmCarrierJumped(state: CommanderState, marketId: number): void {
  delete state.carrierJumps[marketId];
}

/** Trader kinds the journal actually emits, lowercase as `TraderType` reports them. */
const TRADER_TYPES = new Set(['encoded', 'raw', 'manufactured']);

/**
 * Resolve the current station's Material Trader kind from what has been learned.
 *
 * Only set when the station actually advertises a trader. A remembered MarketID is
 * not sufficient on its own: a station could in principle lose the service, and
 * reporting a trader that is no longer listed would be asserting something the
 * game is currently contradicting.
 */
function resolveTraderType(s: CommanderState): void {
  // Always recomputed, never inherited. `traderType` is a projection of
  // (marketId, stationServices, knownTraders) rather than accumulated state, so it
  // is cleared first: docking is reported without an intervening Undocked often
  // enough -- a Location event after a carrier jump, or simply a missed event --
  // and a leftover value would confidently name the previous station's trader.
  s.traderType = UNKNOWN;
  if (!isKnown(s.marketId) || !isKnown(s.stationServices)) return;
  if (!s.stationServices.some((svc) => svc.id === 'materialtrader')) return;
  const type = s.knownTraders[s.marketId];
  if (type) s.traderType = type;
}

/**
 * Record a station's Material Trader kind and re-resolve if it is the current one.
 *
 * Separate from `applyEvent` for the same reason as `learnCarrier`: identities are
 * loaded from storage and replayed from historical journals, and those old events
 * must not overwrite `lastEvent*` and make the dashboard report stale activity.
 */
export function learnTrader(state: CommanderState, marketId: number, traderType: string): void {
  if (!Number.isFinite(marketId)) return;
  const type = traderType.toLowerCase();
  // Unrecognised kinds are dropped rather than stored. A rule keys on these
  // values, and a future fourth kind should read as UNKNOWN until it is measured
  // rather than silently flowing through to the UI as a raw token.
  if (!TRADER_TYPES.has(type)) return;
  state.knownTraders[marketId] = type;
  if (isKnown(state.marketId) && state.marketId === marketId) resolveTraderType(state);
}

function clearLocation(s: CommanderState): void {
  s.stationName = UNKNOWN;
  s.stationType = UNKNOWN;
  s.marketId = UNKNOWN;
  s.stationServices = UNKNOWN;
  s.carrierName = UNKNOWN;
  s.traderType = UNKNOWN;
}

/**
 * Fold one normalized event into state.
 *
 * Pure with respect to its input event; mutates and returns `state` so a long
 * session does not allocate a new object per event (§30).
 */
export function applyEvent(state: CommanderState, event: NormalizedEvent): CommanderState {
  const p = event.source.provenance;

  state.lastEventId = p.eventId;
  state.lastEventName = event.source.event;
  state.lastEventAt = p.timestamp || null;

  if (p.commander !== null) state.commander = p.commander;
  if (p.fid !== null) state.fid = p.fid;
  if (p.gameVersion !== null) state.gameVersion = p.gameVersion;
  if (p.build !== null) state.build = p.build;
  if (p.odyssey !== null) state.odyssey = p.odyssey;

  switch (event.kind) {
    case 'load-game': {
      const d = event.data as {
        ship: Known<string>;
        shipName: Known<string>;
        shipIdent: Known<string>;
        gameMode: Known<string>;
      };
      state.ship = set(state.ship, d.ship);
      state.shipName = set(state.shipName, d.shipName);
      state.shipIdent = set(state.shipIdent, d.shipIdent);
      state.gameMode = set(state.gameMode, d.gameMode);
      state.shutdown = false;
      break;
    }

    case 'location': {
      const d = event.data as LocationData;
      applyLocationLike(state, d);
      break;
    }

    case 'carrier-jump': {
      const d = event.data as LocationData;
      applyLocationLike(state, d);
      // The commander was aboard and watched it happen, which is the one case
      // where they are certainly looking at the overlay. MarketID identifies the
      // carrier; CarrierJump carries no CarrierID of its own.
      if (isKnown(d.marketId)) confirmCarrierJumped(state, d.marketId);
      break;
    }

    case 'fsd-jump': {
      const d = event.data as FsdJumpData;
      state.starSystem = set(state.starSystem, d.starSystem);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      state.starPos = set(state.starPos, d.starPos);
      state.body = set(state.body, d.body);
      state.bodyType = set(state.bodyType, d.bodyType);
      state.bodyId = set(state.bodyId, d.bodyId);
      // Jumping always leaves any station and any planetary surface behind, and
      // always arrives in supercruise.
      state.docking = 'undocked';
      state.travel = 'supercruise';
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      state.lastSettlement = UNKNOWN;
      clearLocation(state);

      // Arrived at the target, so it is no longer a destination. A further
      // FSDTarget will set the next leg of a route.
      if (isKnown(state.jumpTarget) && isKnown(d.starSystem) && state.jumpTarget === d.starSystem) {
        state.jumpTarget = UNKNOWN;
      }
      break;
    }

    case 'carrier-identity': {
      const d = event.data as {
        carrierId: Known<number>;
        name: Known<string>;
      };
      // Also re-resolves, so a rename while docked takes effect immediately.
      if (isKnown(d.carrierId) && isKnown(d.name)) learnCarrier(state, d.carrierId, d.name);
      break;
    }

    case 'carrier-jump-request':
      recordCarrierJump(state, event.data, event.source.provenance.timestamp);
      break;

    case 'carrier-jump-cancelled': {
      const d = event.data as { carrierId: Known<number> };
      if (isKnown(d.carrierId)) cancelCarrierJump(state, d.carrierId);
      break;
    }

    case 'carrier-location': {
      const d = event.data as { carrierId: Known<number>; starSystem: Known<string> };
      if (isKnown(d.carrierId) && isKnown(d.starSystem)) {
        confirmCarrierAt(state, d.carrierId, d.starSystem, event.source.provenance.timestamp);
      }
      break;
    }

    case 'trader-identity': {
      const d = event.data as {
        marketId: Known<number>;
        traderType: Known<string>;
      };
      if (isKnown(d.marketId) && isKnown(d.traderType)) {
        learnTrader(state, d.marketId, d.traderType);
      }
      break;
    }

    case 'organic-scan': {
      const d = event.data as { scanType: Known<string> };
      // Only a completed Analyse yields sellable data. Log and Sample are steps
      // toward one specimen, so counting them would inflate the total.
      if (isKnown(d.scanType) && d.scanType === 'Analyse') state.exobiologyToSell += 1;
      break;
    }

    case 'organic-sold': {
      const d = event.data as { sold: Known<number> };
      // Floored, not reset. Selling fewer than we counted leaves the rest held;
      // selling more than we counted means older data we never saw was included,
      // and zero is the correct lower bound in that case.
      if (isKnown(d.sold)) state.exobiologyToSell = Math.max(0, state.exobiologyToSell - d.sold);
      break;
    }

    case 'died': {
      state.exobiologyToSell = 0;
      break;
    }

    case 'docked': {
      const d = event.data as DockedData;
      state.docking = 'docked';
      state.travel = 'docked';
      state.stationName = set(state.stationName, d.stationName);
      state.stationType = set(state.stationType, d.stationType);
      state.marketId = set(state.marketId, d.marketId);
      state.starSystem = set(state.starSystem, d.starSystem);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      if (d.services !== UNKNOWN) state.stationServices = d.services;
      resolveCarrierName(state);
      resolveTraderType(state);
      break;
    }

    case 'undocked': {
      state.docking = 'undocked';
      state.travel = 'normal-space';
      clearLocation(state);
      break;
    }

    case 'approach-settlement': {
      const d = event.data as ApproachSettlementData;
      state.lastSettlement = set(state.lastSettlement, d.name);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      state.bodyId = set(state.bodyId, d.bodyId);
      state.body = set(state.body, d.bodyName);
      state.marketId = set(state.marketId, d.marketId);
      if (d.services !== UNKNOWN) state.stationServices = d.services;
      break;
    }

    case 'touchdown': {
      const d = event.data as { latitude: Known<number>; longitude: Known<number> };
      state.latitude = set(state.latitude, d.latitude);
      state.longitude = set(state.longitude, d.longitude);
      state.travel = 'landed';
      break;
    }

    case 'liftoff': {
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      state.travel = 'normal-space';
      break;
    }

    case 'disembark': {
      const d = event.data as { srv: Known<boolean> };
      // Disembark means leaving a vehicle. SRV:true is disembarking *from* an SRV,
      // which still puts the commander on foot.
      state.vehicle = 'on-foot';
      void d;
      break;
    }

    case 'embark': {
      const d = event.data as { srv: Known<boolean>; taxi: Known<boolean> };
      state.vehicle = isKnown(d.srv) && d.srv ? 'srv' : isKnown(d.taxi) && d.taxi ? 'taxi' : 'ship';
      break;
    }

    case 'supercruise-entry': {
      state.docking = 'undocked';
      state.travel = 'supercruise';
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      break;
    }

    case 'supercruise-exit': {
      const d = event.data as { body: Known<string>; bodyType: Known<string> };
      state.body = set(state.body, d.body);
      state.bodyType = set(state.bodyType, d.bodyType);
      state.travel = 'normal-space';
      break;
    }

    case 'fsd-target': {
      const d = event.data as { system: Known<string>; remainingJumps: Known<number> };
      state.jumpTarget = set(state.jumpTarget, d.system);
      // Assigned directly rather than through set(): when no route is plotted the
      // field is absent, and that must clear a stale count rather than keep it.
      state.remainingJumps = d.remainingJumps;
      break;
    }

    case 'start-jump': {
      const d = event.data as { jumpType: Known<string>; system: Known<string> };
      if (isKnown(d.jumpType) && d.jumpType === 'Hyperspace') {
        state.travel = 'witch-space';
        state.jumpTarget = set(state.jumpTarget, d.system);
      }
      // A Supercruise StartJump is only the charge-up. SupercruiseEntry confirms
      // it actually happened; the jump can still be aborted before then.
      break;
    }

    case 'nav-route-clear': {
      state.jumpTarget = UNKNOWN;
      state.remainingJumps = UNKNOWN;
      break;
    }

    case 'cargo': {
      const d = event.data as { vessel: Known<string>; count: Known<number> };
      // Only ship cargo belongs on the dashboard's cargo figure.
      if (!isKnown(d.vessel) || d.vessel === 'Ship') state.cargoCount = set(state.cargoCount, d.count);
      break;
    }

    case 'shutdown': {
      state.shutdown = true;
      break;
    }

    default:
      break; // unknown events still updated provenance above
  }

  return state;
}

function applyLocationLike(state: CommanderState, d: LocationData): void {
  state.starSystem = set(state.starSystem, d.starSystem);
  state.systemAddress = set(state.systemAddress, d.systemAddress);
  state.starPos = set(state.starPos, d.starPos);
  state.body = set(state.body, d.body);
  state.bodyType = set(state.bodyType, d.bodyType);
  state.bodyId = set(state.bodyId, d.bodyId);
  state.latitude = set(state.latitude, d.latitude);
  state.longitude = set(state.longitude, d.longitude);

  if (isKnown(d.docked)) {
    state.docking = d.docked ? 'docked' : 'undocked';
    // Only the docked case is certain. Location does not distinguish supercruise
    // from normal space when undocked, so travel is left alone rather than
    // guessed — a subsequent SupercruiseEntry/Exit will say.
    if (d.docked) state.travel = 'docked';
    else if (isKnown(d.latitude)) state.travel = 'landed';

    if (d.docked) {
      state.stationName = set(state.stationName, d.stationName);
      state.stationType = set(state.stationType, d.stationType);
      state.marketId = set(state.marketId, d.marketId);
      if (d.services !== UNKNOWN) state.stationServices = d.services as readonly StationService[];
      // Covers starting the session already docked, and CarrierJump.
      resolveCarrierName(state);
      resolveTraderType(state);
    } else {
      clearLocation(state);
    }
  }

  // OnFoot/InSRV appear only when true; absence here means "not reported".
  if (isKnown(d.onFoot) && d.onFoot) state.vehicle = 'on-foot';
  else if (isKnown(d.inSrv) && d.inSrv) state.vehicle = 'srv';
}
