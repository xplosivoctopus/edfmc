/**
 * Application service: wires the journal engine to local persistence and state.
 *
 * Deliberately framework-free so the same object can drive the React UI today and
 * the overlay window (Phase 2) without duplication.
 */

import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import {
  AnomalyLedger,
  JournalEngine,
  applyEvent,
  initialState,
  listJournalFiles,
  replayFile,
  resolveJournalDirectory,
  setDefaultFs,
  isKnown,
  type CommanderState,
  type Known,
  type IngestStats,
  type JournalCheckpoint,
  type FieldAnomaly,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  DEFAULT_CATEGORY,
  normaliseTags,
  prefill,
  resolveCollision,
  sanitiseSegment,
  validateHotkey,
  type CaptureContext,
  type Prefill,
  type ScreenshotRecord,
} from './screenshots.js';

import {
  BUNDLED_RULES,
  ContextResolver,
  resourceUrl,
  type ActiveContext,
} from '@edfm/context';

import {
  MISSION_COLUMNS,
  MissionStore,
  explainMission,
  fromRow,
  hasDeliveryProgress,
  isAwaitingTurnIn,
  remainingCargo,
  toRow,
  type DestinationGroup,
  type Mission,
  type MissionRow,
  type MissionSummary,
} from '@edfm/missions';

import {
  DiscoveryState,
  VerificationEngine,
  createReferenceClient,
  createSubmitter,
  isCarrier,
  observeStation,
  createStationProvider,
  type ReferenceClient,
  type Submitter,
  type IdentityMode,
} from '@edfm/verification';
import {
  loadPlugins,
  mergeContextRules,
  type LoadedPlugin,
  type RejectedPlugin,
} from '@edfm/plugins';
import {
  buildPlan,
  combinedRequirements,
  allocate,
  siteFromDepot,
  type ConstructionSite,
  type SourcingPlan,
  type PlanOptions,
  type Requirement,
  type CandidateStation,
} from '@edfm/logistics';
import {
  SessionTracker,
  SETTLEMENT_MATERIALS,
  summarise,
  groupBy,
  itemTally,
  type ObservedSession,
  type Completeness,
  type QualitySummary,
  type GroupSummary,
  type ItemSummary,
} from '@edfm/research';

import { logger } from './logger.js';
import { httpFetch } from './http.js';
import { credentialClear, credentialPresent, credentialSet } from './credentials.js';
import {
  ActivityEngine,
  LiveActivityTracker,
  formatCredits,
  rowStatus,
  speciesInfo,
  type BodyRef,
  type CompletedRecord,
  type SpeciesProgress,
  groupActivity,
  type ActivityEntry,
  type ActivityGroup,
} from '@edfm/activity';
import { DEFAULT_GUIDANCE_MODE, type GuidanceMode } from '@edfm/context';
import {
  EMPTY_QUEUE,
  INTEGRATIONS,
  EDDN_JOURNAL_EVENTS,
  EDDN_UPLOAD_URL,
  applyBatchOutcome,
  auditEddnMessage,
  backoffFor,
  buildBatch,
  augmentForEdsm,
  buildInaraBatch,
  buildEddnJournalMessage,
  classifyHttp,
  isDiscardedByEdsm,
  parseEdsmDiscard,
  parseEdsmResponse,
  parseInaraResponse,
  toInaraLocation,
  type InaraEvent as InaraLocationEvent,
  classifyFailure,
  isWithinPhaseOne,
  looksLikeJournalToken,
  parseBatchOutcome,
  parseStatus,
  type JournalStatus,
  integrationsList,
  sharingAudit,
  type IntegrationId,
  type QueueSummary,
  type SharingAudit,
  type SharingInput,
} from '@edfm/integrations';
import {
  backfillCarrierIdentities,
  backfillCarrierJumps,
  backfillExobiologyHoldings,
  backfillTraderIdentities,
  type BackfillContext,
} from './backfill.js';
import { policyFor, projectResources } from './spoiler.js';
import {
  DEFAULT_WIDGETS,
  overlayApi,
  APPEARANCE_BOUNDS,
  DEFAULT_APPEARANCE,
  clampNumber,
  clampOpacity,
  type LiveJournalState,
  type OverlayLiveActivity,
  type OverlayAppearance,
  type OverlayCarrierJump,
  type OverlayMissionRow,
  type OverlayMissions,
  type OverlayWidgets,
} from './overlay.js';
import { savedGamesDir, tauriFs, watchJournalDirectory } from './tauriFs.js';

/**
 * Events that fire constantly and carry no dashboard value.
 * `FSSSignalDiscovered` alone was 45,545 of 197,164 lines in the validation corpus;
 * re-rendering for each would burn CPU beside a running game for nothing (§30).
 */
const HIGH_FREQUENCY_NOISE = new Set([
  'Music',
  'FSSSignalDiscovered',
  'ReservoirReplenished',
  'UnderAttack',
  'ShipTargeted',
  'ReceiveText',
]);

/**
 * Install the Tauri adapter as this host's filesystem.
 *
 * Call sites also pass it explicitly; registering it here means any future code
 * path that relies on the default gets the right one rather than throwing.
 */
setDefaultFs(tauriFs);

/**
 * Human label for a travel state.
 *
 * "Unknown" is reserved for genuinely unknown. When the commander is in
 * supercruise there is no station, and reporting that as missing data would
 * misdescribe a situation the journal states plainly.
 */
export function travelLabel(travel: CommanderState['travel']): string {
  switch (travel) {
    case 'docked':
      return 'Docked';
    case 'landed':
      return 'Landed';
    case 'normal-space':
      return 'In flight';
    case 'supercruise':
      return 'Supercruise';
    case 'witch-space':
      return 'Witch space';
    default:
      return 'Unknown';
  }
}

/**
 * How many mission rows reach the overlay.
 *
 * Small on purpose. The overlay competes with the game for attention, and a long
 * list there is worse than none — the main window holds the complete set.
 */
const OVERLAY_MISSION_ROWS = 5;

/** Stamped onto every observation so a report can be traced to a build. */
const COMPANION_VERSION = '0.1.0';

/**
 * Subtypes a backfill may send.
 *
 * Named explicitly rather than taking whatever is in the table, because the
 * table outlives the rules. `landed` is the reason: an entry per touchdown used
 * to be recorded, that was dropped as noise, and those rows are still on disk.
 * A backfill driven by "everything stored" would upload hundreds of them to a
 * public profile -- activity this app no longer considers worth recording.
 *
 * `mission-completed` is absent for a different reason, and not because it is
 * unwanted: EDFM's journal extension allowlists four categories and `missions`
 * is not one of them, so the server answers `unsupported_category` and the entry
 * is marked permanently rejected. Queueing work that cannot succeed would fill a
 * commander's Failed count with entries nothing they do can fix. The moment the
 * wiki accepts the category, this list is the only thing that changes -- the
 * entries are already being recorded and stored.
 */
const SYNCABLE_SUBTYPES = [
  'sample-completed',
  'signals-detected',
  'data-sold',
] as const;

/** Between backfill batches, so a long catch-up is not a burst of traffic. */
const BACKFILL_PAUSE_MS = 1_500;

/** A row of `activity_entries`, as SQLite hands it back. */
interface ActivityRow {
  id: string;
  commander_fid: string;
  occurred_at: string;
  category: string;
  subtype: string;
  system_name: string | null;
  system_address: number | null;
  body_name: string | null;
  body_id: number | null;
  location_name: string | null;
  title: string;
  detail: string | null;
  data: string;
  sources: string;
}

/** One place to turn a row into an entry, so the readers cannot drift apart. */
function activityFromRow(r: ActivityRow): ActivityEntry {
  return {
    id: r.id,
    commanderFid: r.commander_fid,
    occurredAt: r.occurred_at,
    category: r.category as ActivityEntry['category'],
    subtype: r.subtype,
    systemName: r.system_name,
    systemAddress: r.system_address,
    bodyName: r.body_name,
    bodyId: r.body_id,
    locationName: r.location_name,
    title: r.title,
    detail: r.detail,
    data: safeJsonObject(r.data),
    sources: safeJsonStrings(r.sources),
  };
}

/**
 * EDFM API origin.
 *
 * Overridable at build time so a developer can point at a local server without
 * editing source. No secret is involved: this is a public read endpoint, and
 * everything privileged stays server-side (§19).
 */
const API_BASE_URL = import.meta.env.VITE_EDFM_API_URL ?? 'https://api.edfieldmanual.com';

/** Bounds the re-check map; only the newest observation per station matters. */
const MAX_PENDING_RECHECK = 50;

/** Relative expiry for display. "Expired" rather than a negative duration. */
export function relativeExpiry(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return 'Unknown';
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Cargo line for a mission row.
 *
 * Leads with what is still owed when the journal has told us, because that is the
 * number the next run is planned around — after handing in 1,236 of 1,386, "150
 * left" is useful and "1386 t" is actively misleading.
 */
function cargoLabel(m: Mission): string | null {
  const commodity = isKnown(m.commodityLocalised) ? ` ${m.commodityLocalised}` : '';
  if (hasDeliveryProgress(m)) {
    return `${remainingCargo(m)} t left of ${m.totalToDeliver as number}${commodity}`;
  }
  return isKnown(m.count) && isKnown(m.commodity) ? `${m.count} t${commodity}`.trim() : null;
}

export type ConnectionState = 'starting' | 'watching' | 'no-directory' | 'stopped' | 'error';

export interface CompanionSnapshot {
  readonly state: CommanderState;
  readonly stats: IngestStats;
  readonly connection: ConnectionState;
  readonly directory: string | null;
  readonly directoryDetail: string;
  readonly activeFile: string | null;
  readonly lastError: string | null;
  readonly contexts: readonly ActiveContext[];
  /** Scheduled jumps for the commander's own carriers, soonest first. */
  readonly carrierJumps: readonly OverlayCarrierJump[];
  /** The commander's field journal, newest first. Local only, never transmitted. */
  readonly activity: readonly ActivityGroup[];
  /** How much explanation to show. Never changes which facts are shown. */
  readonly guidance: GuidanceMode;
  /**
   * Null until the commander has chosen, which is what triggers the first-run
   * prompt. Distinct from "they chose Standard".
   */
  readonly guidanceChosen: boolean;
  readonly appearance: OverlayAppearance;
  /**
   * Per-integration state: enabled, and whether a credential exists. Never the
   * credential itself, which cannot reach JavaScript at all.
   */
  readonly integrations: Readonly<
    Record<IntegrationId, { readonly enabled: boolean; readonly hasCredential: boolean }>
  >;
  /** Bound setter, so the screen needs no import of the companion singleton. */
  readonly setIntegrationEnabled: (id: IntegrationId, enabled: boolean) => Promise<void>;
  /**
   * Store a key for an integration that needs one.
   *
   * Returns null on success, or a sentence. The value goes straight to the OS
   * credential store; it is never kept in the snapshot, so it cannot reach a
   * render, a log or a crash report.
   */
  readonly setIntegrationCredential: (id: IntegrationId, secret: string) => Promise<string | null>;
  readonly clearIntegrationCredential: (id: IntegrationId) => Promise<void>;
  /**
   * What has actually left this machine, for the active commander.
   *
   * Read from the queue and the per-integration state rather than inferred from
   * the switches, because "switched on" and "has sent something" are different
   * claims and only the second one is evidence.
   */
  readonly sharing: SharingAudit;
  /**
   * Journal fields whose type changed, and what the app knows about itself.
   *
   * Structural metadata only: event name, field name, the two types, a count and
   * the game build. No field values, because this panel is the thing that ends
   * up in a screenshot attached to a bug report.
   */
  readonly diagnostics: DiagnosticsView;
  /** Bring forward every waiting retry for one integration. */
  readonly retrySharingNow: (id: IntegrationId) => Promise<void>;
  /** Discard permanently-rejected items, which will never be sent. */
  readonly clearSharingRejected: (id: IntegrationId) => Promise<void>;
  readonly contextRuleVersion: number;
  readonly contextRuleSource: string;
  readonly missions: MissionView;
  readonly verification: VerificationStats;
  /** Whether the commander has opted in to verification (§21). */
  readonly verificationEnabled: boolean;
  readonly research: ResearchView;
  readonly contributions: ContributionView;
  readonly logistics: LogisticsView;
  readonly plugins: PluginView;
  readonly screenshots: ScreenshotView;
  readonly journalSync: JournalSyncView;
  /** Store a token, verify it against `/status`, and connect. */
  readonly connectJournalSync: (token: string) => Promise<string | null>;
  /** Forget the local credential. Does not revoke the token on the website. */
  readonly disconnectJournalSync: () => Promise<void>;
  /** Push whatever is waiting now. */
  readonly syncJournalNow: () => Promise<void>;
  /**
   * What a backfill would send, without sending any of it.
   *
   * Asked before the commander is offered the choice, so the decision is made
   * against a real count and a real span rather than in the abstract.
   */
  readonly journalBackfillPreview: () => Promise<{
    entries: number;
    oldest: string | null;
    newest: string | null;
  }>;
  /** Queue everything not yet acknowledged, however old, and send it. */
  readonly backfillJournalSync: (
    onProgress?: (sent: number, total: number) => void,
  ) => Promise<string | null>;
  /** Stop a running backfill at the end of the batch in flight. */
  readonly cancelJournalBackfill: () => void;
  /**
   * Rebuild the local Activity Journal from the journal files on disk.
   *
   * Local only; it sends nothing. Without it a backfill has almost nothing to
   * send, because activity from before the feature existed was never recorded.
   */
  readonly rebuildActivityHistory: (
    onProgress?: (done: number, total: number) => void,
  ) => Promise<{ filesRead: number; entriesAdded: number; failed: number }>;
  /** Stop a running rebuild at the next file boundary. */
  readonly cancelActivityRebuild: () => void;
  /** Capture now. Bound so a hotkey handler needs no import of the singleton. */
  readonly captureScreenshot: () => Promise<void>;
  readonly saveScreenshot: (draft: ScreenshotSaveRequest) => Promise<void>;
  readonly discardScreenshotDraft: () => void;
  readonly setScreenshotHotkey: (binding: string | null) => Promise<string | null>;
  readonly setScreenshotFolder: (path: string) => Promise<boolean>;
  readonly updateScreenshot: (id: string, patch: Partial<ScreenshotRecord>) => Promise<void>;
  readonly removeScreenshotFromCatalog: (id: string) => Promise<void>;
  /** Re-read the catalog and re-check which images are still on disk. */
  readonly refreshScreenshots: () => Promise<void>;
  readonly deleteScreenshotImage: (id: string) => Promise<void>;
}

/** What the confirmation dialog sends back. */
export interface ScreenshotSaveRequest {
  readonly filename: string;
  /** Skip the rename entirely and catalog the file where it landed. */
  readonly keepOriginalName: boolean;
  readonly category: string;
  readonly subject: string;
  readonly systemName: string;
  readonly bodyName: string;
  readonly stationName: string;
  readonly tags: readonly string[];
  readonly note: string;
  /** Null unless the commander ticked the link. Never set automatically. */
  readonly activityEntryId: string | null;
}

/**
 * Strip anything path-shaped out of a message bound for a log.
 *
 * §21: a screenshot path names a folder under the commander's account and
 * often their Windows username. Diagnostics say what failed, never where.
 */
export function sanitisePath(detail: string): string {
  return detail
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>')
    .replace(/\\\\[^\s"']+/g, '<path>')
    .replace(/\/(?:[\w.-]+\/){2,}[\w.-]*/g, '<path>')
    .slice(0, 300);
}

function screenshotFromRow(r: Record<string, unknown>): ScreenshotRecord {
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(r['tags'] ?? '[]')) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // A corrupt tag list is not a reason to hide the screenshot.
    tags = [];
  }
  return {
    id: String(r['id']),
    commanderFid: String(r['commander_fid']),
    filePath: String(r['file_path']),
    capturedAt: String(r['captured_at']),
    category: String(r['category']),
    subject: text(r['subject']),
    systemName: text(r['system_name']),
    bodyName: text(r['body_name']),
    stationName: text(r['station_name']),
    settlement: text(r['settlement']),
    tags,
    note: text(r['note']),
    activityEntryId: text(r['activity_entry_id']),
    width: typeof r['width'] === 'number' ? r['width'] : null,
    height: typeof r['height'] === 'number' ? r['height'] : null,
  };
}

/**
 * A capture waiting for the commander to say what it is.
 *
 * Held in the store rather than passed through an event, so a reload or a
 * re-render cannot lose it. The image is already written to disk by this point:
 * nothing here risks the screenshot itself.
 */
export interface ScreenshotDraft {
  /** Where the capture currently lives. Renamed only once confirmed. */
  readonly stagingPath: string;
  readonly capturedAt: string;
  readonly width: number;
  readonly height: number;
  /** `elite-window` or `primary-monitor`. */
  readonly source: string;
  /**
   * The image is a single flat colour, which is what exclusive fullscreen looks
   * like through a screen read. Surfaced so the commander is told rather than
   * cataloguing a black rectangle.
   */
  readonly looksBlank: boolean;
  readonly suggestion: Prefill;
}

export interface ScreenshotView {
  /** Null until the commander chooses one. Nothing is bound by default. */
  readonly hotkey: string | null;
  /** Null until resolved; the Pictures folder by default. */
  readonly folder: string | null;
  readonly folderWritable: boolean;
  readonly recent: readonly ScreenshotRecord[];
  /** The capture awaiting confirmation, if any. */
  readonly draft: ScreenshotDraft | null;
  /**
   * True when the form had to fall back to the main window.
   *
   * Normally the form opens in its own window over the game. If that window
   * cannot be shown, the capture is still answerable here rather than being
   * stranded.
   */
  readonly draftInMainWindow: boolean;
  /** Last failure, already sanitised of paths. */
  readonly lastError: string | null;
  /**
   * Catalog ids whose image is not where the catalog says it is.
   *
   * Marked rather than removed. "Not found" and "deleted" are the same answer
   * from here: an unplugged drive, a disconnected network path, an unsynced
   * cloud placeholder and a renamed folder all read identically, and pruning on
   * that would silently destroy the subject, tags and notes the commander typed.
   * The image could be retaken; that writing could not.
   */
  readonly missing: ReadonlySet<string>;
  /** Forget every entry whose image is gone. Only ever from an explicit click. */
  readonly removeMissingFromCatalog: () => Promise<void>;
}

/**
 * The EDFM Commander Journal connection, as the commander sees it.
 *
 * Phase 1 is push-only: new derived Activity Journal entries go up. There is no
 * read endpoint in the deployed API, so there is nothing here about downloading
 * or restoring, and inventing a field for it would promise something the server
 * cannot do.
 */
export type JournalConnectionState =
  | 'not-connected'
  | 'connected'
  | 'syncing'
  | 'needs-attention'
  | 'unavailable';

export interface JournalSyncView {
  readonly state: JournalConnectionState;
  readonly hasCredential: boolean;
  /** Entries waiting to go up, for the active commander. */
  readonly pending: number;
  /** Entries the server will never accept. */
  readonly failed: number;
  /** ISO 8601 of the last acknowledged sync, or null. */
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  /** One sentence, already safe to show. Never a raw server body. */
  readonly message: string | null;
  /** What `/status` last reported. Null until a successful check. */
  readonly server: JournalStatus | null;
  /**
   * When sync was switched on. Entries from before this are not uploaded
   * automatically, and the UI says so rather than leaving it to be assumed.
   */
  readonly syncingSince: string | null;
  /** A backfill is in flight. Both it and a rebuild are one-at-a-time. */
  readonly backfilling: boolean;
  /** A local history rebuild is in flight. */
  readonly rebuilding: boolean;
}

/** What the app knows about itself and about the journal's shape. */
export interface DiagnosticsView {
  readonly appVersion: string;
  /** Game version the journal is reporting, or null before a header is seen. */
  readonly gameVersion: string | null;
  readonly anomalies: readonly FieldAnomaly[];
  readonly eventsTracked: number;
  readonly fieldsTracked: number;
  /** Non-zero when a bound was reached, so the list is not implied complete. */
  readonly truncated: number;
}

/**
 * Installed plugins.
 *
 * Rejections are part of the view, not a log line. A plugin that silently did
 * not load is indistinguishable from one that loaded and did nothing, and the
 * author is usually the person running the app.
 */
export interface PluginView {
  readonly loaded: readonly LoadedPlugin[];
  readonly rejected: readonly RejectedPlugin[];
  readonly directory: string | null;
  /** Context rules contributed by plugins, over the built-in count. */
  readonly contributedRules: number;
  /** Which location was used: `documents`, `app-data`, or `none`. */
  readonly source: string;
  /**
   * Why the preferred location was not used.
   *
   * Set on a machine with no Documents folder, or one where it is not
   * writable. Surfaced rather than logged, because a commander who was told
   * "Documents" and finds nothing there needs to know where it went instead.
   */
  readonly fallbackReason: string | null;
  /**
   * Folders whose plugin.json exists but could not be read.
   *
   * The case this exists for is OneDrive holding a manifest online-only: the
   * plugin is installed, looks installed, and silently does nothing. "No
   * plugins" and "could not read your plugin" must not look the same.
   */
  readonly unreadable: readonly { readonly directory: string; readonly message: string }[];
  /**
   * Plugins the commander switched off.
   *
   * Disabled rather than uninstalled: the plugin stays listed, keeps its
   * instructions, and contributes nothing. Turning something off should not
   * require deleting it and finding it again later.
   */
  readonly disabledIds: readonly string[];
}

/**
 * Construction sites and the current sourcing plan.
 *
 * The plan is held rather than recomputed on render: building it costs a
 * network round trip, and §16's whole point is that a commander studies the
 * reasoning rather than watching it flicker.
 */
export interface LogisticsView {
  readonly sites: readonly ConstructionSite[];
  /** Combined across active sites (§17). */
  readonly requirements: readonly Requirement[];
  readonly plan: SourcingPlan | null;
  readonly planningState: 'idle' | 'searching' | 'error';
  readonly planError: string | null;
  /** Candidate stations the last search returned, for context. */
  readonly candidatesConsidered: number;
  readonly plannedAt: string | null;
}

/**
 * Contribution history (S11).
 *
 * Deliberately not a leaderboard and deliberately not a score. S11 warns that
 * incentivising accuracy encourages manufacturing reports, so these are counts
 * of what this commander's client actually sent, with no ranking, no streak and
 * nothing to beat.
 */
export interface ContributionView {
  readonly enabled: boolean;
  readonly identityMode: IdentityMode;
  /** Observations the server accepted. */
  readonly submitted: number;
  /** Waiting to be sent, including while offline. */
  readonly pending: number;
  /** Rejected outright; retrying would send the same mistake. */
  readonly failed: number;
  /** What the server derived from those observations. */
  readonly findingsFromSubmissions: number;
  /** Detected locally, whether or not anything was ever sent. */
  readonly discrepanciesDetected: number;
  /** Recorded locally; contribution of research is not built yet. */
  readonly researchSessions: number;
  readonly lastContributionAt: string | null;
}

/**
 * Research state for the UI.
 *
 * Carries the §13 quality summary alongside the counts, so a screen cannot
 * render a rate without also having been told whether the sample supports one.
 */
export interface ResearchView {
  readonly projectTitle: string;
  readonly projectVersion: number;
  readonly sessions: readonly ObservedSession[];
  readonly active: ObservedSession | null;
  readonly quality: QualitySummary;
  readonly byEconomy: readonly GroupSummary[];
  readonly items: readonly ItemSummary[];
  /** Fields §12 asked for that the game does not expose. */
  readonly unavailableFields: readonly string[];
}

/** Aggregate verification counters for the Contributions screen (§15). */
export interface VerificationStats {
  readonly checked: number;
  readonly matched: number;
  readonly discrepancies: number;
  readonly independentlyConfirmed: number;
  readonly conflicting: number;
}

export interface MissionView {
  readonly summary: MissionSummary;
  readonly groups: readonly DestinationGroup[];
  readonly withoutDestination: readonly Mission[];
  readonly byExpiry: readonly Mission[];
}

const EMPTY_STATS: IngestStats = {
  linesRead: 0,
  eventsEmitted: 0,
  malformedJson: 0,
  notAnObject: 0,
  missingEventField: 0,
  unknownEventKinds: {},
  filesOpened: 0,
  rotations: 0,
  emptyFilesSkipped: 0,
};

/**
 * Parse a stored JSON object without letting one corrupt row break the timeline.
 *
 * Anything that is not a plain object becomes an empty one: a row written by a
 * future version, or half-written by a crash, should cost its own detail rather
 * than the whole screen.
 */
function safeJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The same, for a stored array of strings. */
function safeJsonStrings(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export class Companion {
  private started = false;
  /* ------------------------------------------------------------- EDSM */

  private edsmSending = false;
  private edsmTimer: ReturnType<typeof setInterval> | null = null;
  /** Fetched live; empty until it arrives, and empty filters nothing. */
  private edsmDiscard: ReadonlySet<string> = new Set();

  /**
   * Offer one journal event to EDSM.
   *
   * EDSM forwards journal entries rather than taking a vocabulary of its own,
   * so almost any event is a candidate — which makes the discard list the gate.
   * 141 event names are on it, and sending them is traffic EDSM has explicitly
   * asked not to receive.
   *
   * **Nothing is queued while the integration is off**, enforced here rather
   * than at send time, so switching EDSM off does not leave a queue filling up.
   */
  private observeForEdsm(event: NormalizedEvent): void {
    if (!this.integrationState.edsm.enabled) return;
    if (!INTEGRATIONS.edsm.implemented) return;
    if (!this.integrationState.edsm.hasCredential) return;
    if (isDiscardedByEdsm(event.source.event, this.edsmDiscard)) return;

    const s = this.state;
    // Without a commander name EDSM cannot attribute the entry, and the name is
    // the one field it will not accept a guess for.
    if (!isKnown(s.commander)) return;

    const augmented = augmentForEdsm(event.source.raw as Record<string, unknown>, {
      systemName: isKnown(s.starSystem) ? s.starSystem : null,
      systemAddress: isKnown(s.systemAddress) ? s.systemAddress : null,
      systemCoordinates: isKnown(s.starPos) ? s.starPos : null,
      stationName: isKnown(s.stationName) ? s.stationName : null,
      marketId: isKnown(s.marketId) ? s.marketId : null,
      // The journal's numeric ship id is not tracked in state, so it is
      // omitted rather than guessed -- which is what EDSM expects for an
      // unknown field anyway.
      shipId: null,
    });

    void this.enqueueEdsm(event.source.provenance.eventId, augmented);
  }

  private async enqueueEdsm(eventId: string, entry: unknown): Promise<void> {
    if (!this.db) return;
    const now = new Date().toISOString();
    try {
      // Keyed on the journal event id, which is stable across restart and
      // replay, so re-reading a file cannot submit the same entry twice.
      await this.db.execute(
        `INSERT OR IGNORE INTO integration_queue
           (id, integration, commander_fid, status, payload, attempts, created_at, updated_at)
         VALUES ($1, 'edsm', $2, 'queued', $3, 0, $4, $4)`,
        [eventId, this.discoveryFid, JSON.stringify(entry), now],
      );
    } catch (err) {
      logger.warn('edsm', 'Could not queue an entry', { error: String(err) });
    }
  }

  private startEdsmDrain(): void {
    if (this.edsmTimer !== null) return;
    void this.loadEdsmDiscard();
    this.edsmTimer = setInterval(() => void this.drainEdsm(), 30_000);
  }

  /**
   * Fetch the discard list.
   *
   * A failure leaves the set empty, and an empty set filters nothing: guessing
   * that an event is unwanted would silently lose it.
   */
  private async loadEdsmDiscard(): Promise<void> {
    try {
      const raw = await invoke<{ status: number; body: string }>('edsm_discard');
      if (raw.status !== 200) return;
      this.edsmDiscard = parseEdsmDiscard(JSON.parse(raw.body));
      logger.info('edsm', 'Loaded the discard list', { events: this.edsmDiscard.size });
    } catch (err) {
      logger.warn('edsm', 'Could not load the discard list', { error: String(err) });
    }
  }

  /**
   * Send what is due, in one batch.
   *
   * EDSM takes an array, so a reconnecting commander's backlog goes in a few
   * requests rather than one per entry.
   */
  private async drainEdsm(): Promise<void> {
    if (this.edsmSending || !this.db) return;
    if (!this.integrationState.edsm.enabled) return;
    if (!isKnown(this.state.commander)) return;

    this.edsmSending = true;
    try {
      const now = new Date().toISOString();
      const rows = await this.db.select<Array<{ id: string; payload: string; attempts: number }>>(
        `SELECT id, payload, attempts FROM integration_queue
          WHERE integration = 'edsm' AND status IN ('queued','retryable')
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY created_at
          LIMIT 50`,
        [now],
      );
      if (rows.length === 0) return;

      const entries: Record<string, unknown>[] = [];
      const ids: string[] = [];
      for (const row of rows) {
        try {
          entries.push(JSON.parse(row.payload) as Record<string, unknown>);
          ids.push(row.id);
        } catch {
          // A row whose payload cannot be read will never send. Drop it rather
          // than retrying something unparseable forever.
          await this.db.execute(
            `DELETE FROM integration_queue WHERE integration = 'edsm' AND id = $1`,
            [row.id],
          );
        }
      }
      if (entries.length === 0) return;


      const raw = await invoke<{ status: number; body: string; transport_error: string | null }>(
        'edsm_submit',
        {
          submission: {
            commander_name: isKnown(this.state.commander) ? this.state.commander : '',
            software_name: 'EDFM Companion',
            software_version: COMPANION_VERSION,
            game_version: isKnown(this.state.gameVersion) ? this.state.gameVersion : null,
            game_build: isKnown(this.state.build) ? this.state.build : null,
            message_json: JSON.stringify(entries),
          },
        },
      );

      if (raw.transport_error !== null || raw.status === 0) {
        await this.backoffQueue('edsm', ids);
        return;
      }

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw.body);
      } catch {
        parsed = null;
      }

      /*
       * The finding this is built around: EDSM answers HTTP 200 even when it
       * accepted nothing. The outcome is in `msgnum`, so the status code is
       * deliberately not consulted.
       */
      const outcome = parseEdsmResponse(parsed);

      if (outcome.kind === 'credential') {
        // A key problem will not fix itself by being retried, and repeating an
        // authenticated request with a dead key is rude to the server.
        await this.recordIntegrationError(
          'edsm',
          `EDSM rejected the credential (${outcome.code}). Check your API key.`,
        );
        logger.warn('edsm', 'Credential rejected', { code: String(outcome.code) });
        this.notify();
        return;
      }
      if (outcome.kind !== 'accepted') {
        await this.backoffQueue('edsm', ids);
        return;
      }

      // Per entry, in the order submitted. An entry EDSM did not answer for
      // stays queued rather than being assumed delivered.
      for (let i = 0; i < ids.length; i += 1) {
        const result = outcome.perEvent[i];
        const id = ids[i]!;
        if (result === undefined) continue;
        if (result.accepted) {
          await this.db.execute(
            `DELETE FROM integration_queue WHERE integration = 'edsm' AND id = $1`,
            [id],
          );
        } else {
          await this.db.execute(
            `UPDATE integration_queue SET status = 'rejected', last_error = $2, updated_at = $3
              WHERE integration = 'edsm' AND id = $1`,
            [id, `${result.msgnum}: ${result.msg}`.slice(0, 200), new Date().toISOString()],
          );
        }
      }
      await this.recordIntegrationSuccess('edsm');
      this.notify();
    } catch (err) {
      logger.warn('edsm', 'Send failed', { error: String(err) });
    } finally {
      this.edsmSending = false;
    }
  }

  /**
   * Record, or clear, the last error for an integration.
   *
   * Written to `integration_state` so the Connections audit shows it: that
   * screen already asks "what happened last time", and a second place for the
   * answer would be a second thing to keep in step.
   */
  private async recordIntegrationError(integration: string, message: string | null): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    const now = new Date().toISOString();
    try {
      await this.db.execute(
        `INSERT INTO integration_state (integration, commander_fid, enabled, last_error, updated_at)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (integration, commander_fid)
         DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
        [integration, this.discoveryFid, message, now],
      );
      await this.loadSharingState();
    } catch (err) {
      logger.warn(integration, 'Could not record the last error', { error: String(err) });
    }
  }

  /**
   * Record that something actually reached a service.
   *
   * The counterpart to `recordIntegrationError`, and it was missing: the
   * Connections audit reads `last_success_at` to answer "when did this last
   * send", but nothing ever wrote it, so the answer stayed blank however much
   * had been sent. Clears the last error at the same time, because an error
   * still on display after a success describes a problem that has passed.
   */
  private async recordIntegrationSuccess(integration: string): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    const now = new Date().toISOString();
    try {
      await this.db.execute(
        `INSERT INTO integration_state
           (integration, commander_fid, enabled, last_success_at, last_error, updated_at)
         VALUES ($1, $2, 1, $3, NULL, $3)
         ON CONFLICT (integration, commander_fid)
         DO UPDATE SET last_success_at = excluded.last_success_at,
                       last_error = NULL,
                       updated_at = excluded.updated_at`,
        [integration, this.discoveryFid, now],
      );
      await this.loadSharingState();
    } catch (err) {
      logger.warn(integration, 'Could not record the last success', { error: String(err) });
    }
  }

  /** Shared backoff for the community queues. */
  private async backoffQueue(integration: string, ids: readonly string[]): Promise<void> {
    if (!this.db || ids.length === 0) return;
    const now = new Date();
    for (const id of ids) {
      const rows = await this.db.select<Array<{ attempts: number }>>(
        `SELECT attempts FROM integration_queue WHERE integration = $1 AND id = $2`,
        [integration, id],
      );
      const attempts = Number(rows[0]?.attempts ?? 0) + 1;
      const next = new Date(now.getTime() + backoffFor(attempts) * 1000).toISOString();
      await this.db.execute(
        `UPDATE integration_queue
            SET status = 'retryable', attempts = $3, next_attempt_at = $4, updated_at = $5
          WHERE integration = $1 AND id = $2`,
        [integration, id, attempts, next, now.toISOString()],
      );
    }
  }

  /* ------------------------------------------------------------ Inara */

  private inaraSending = false;
  /** The location Inara was last told about, so it is not told twice. */
  private inaraLastSent: string | null = null;

  /**
   * Keep the Inara profile location current.
   *
   * Unlike EDDN and EDSM this is not fed from the Activity Journal, because
   * **Inara has no event that accepts exobiology** -- its write vocabulary is
   * travel, ranks, ships, materials, market and combat. Feeding it journal
   * entries would mean inventing event names, so it is fed location instead,
   * which is the one thing it both documents and commanders want from it.
   *
   * `setCommanderTravelLocation` overwrites rather than appends, so there is no
   * queue: a backlog of old locations would walk the profile through places the
   * commander has already left. Only the latest is sent, and only when it has
   * actually changed.
   */
  private observeForInara(event: NormalizedEvent): void {
    if (!this.integrationState.inara.enabled) return;
    if (!INTEGRATIONS.inara.implemented) return;
    if (!this.integrationState.inara.hasCredential) return;

    // Arriving somewhere is the only thing that moves the profile. Firing on
    // every event would send one request per journal line.
    const name = event.source.event;
    if (
      name !== 'Location' &&
      name !== 'FSDJump' &&
      name !== 'CarrierJump' &&
      name !== 'Docked' &&
      name !== 'ApproachBody' &&
      name !== 'Touchdown'
    ) {
      return;
    }

    const st = this.state;
    if (!isKnown(st.commander)) return;

    const at = {
      systemName: isKnown(st.starSystem) ? st.starSystem : null,
      systemCoords: isKnown(st.starPos) ? st.starPos : null,
      stationName: isKnown(st.stationName) ? st.stationName : null,
      marketId: isKnown(st.marketId) ? st.marketId : null,
      bodyName: isKnown(st.body) ? st.body : null,
      occurredAt: event.source.provenance.timestamp,
    };

    const built = toInaraLocation(at);
    if (built === null) return;

    /*
     * Keyed on the location rather than the event, because several events
     * report arriving at the same place -- `Location` then `Docked`, say -- and
     * each would otherwise be a separate request saying the same thing.
     */
    const fingerprint = JSON.stringify(built.eventData);
    if (fingerprint === this.inaraLastSent) return;
    this.inaraLastSent = fingerprint;

    void this.sendInara(built);
  }

  private async sendInara(locationEvent: InaraLocationEvent): Promise<void> {
    if (this.inaraSending) return;
    this.inaraSending = true;
    try {
      const st = this.state;
      const batch = buildInaraBatch({
        // Supplied by Rust from the credential store; never read here.
        apiKey: '',
        commanderName: isKnown(st.commander) ? st.commander : '',
        commanderFrontierID: this.discoveryFid,
        appName: 'EDFM Companion',
        appVersion: COMPANION_VERSION,
        isBeingDeveloped: false,
        events: [locationEvent],
      });

      const raw = await invoke<{ status: number; body: string; transport_error: string | null }>(
        'inara_submit',
        {
          submission: {
            app_name: batch.header.appName,
            app_version: batch.header.appVersion,
            commander_name: batch.header.commanderName,
            commander_frontier_id: batch.header.commanderFrontierID ?? null,
            events_json: JSON.stringify(batch.events),
          },
        },
      );

      if (raw.transport_error !== null || raw.status === 0) {
        // Allowed to be retried: the next arrival will try again, so a dropped
        // request costs nothing but a slightly stale profile.
        this.inaraLastSent = null;
        return;
      }

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw.body);
      } catch {
        parsed = null;
      }

      const outcome = parseInaraResponse(parsed);
      if (outcome.kind === 'credential') {
        /*
         * A rejected key will not fix itself, and Inara documents that a header
         * level failure cancels the batch. Stop and say so rather than
         * repeating an authenticated request with a dead key.
         */
        await this.recordIntegrationError(
          'inara',
          `Inara rejected the key: ${outcome.message}`.slice(0, 200),
        );
        logger.warn('inara', 'Credential rejected');
        this.notify();
        return;
      }
      if (outcome.kind !== 'accepted') {
        this.inaraLastSent = null;
        logger.warn('inara', 'Location not accepted', { kind: outcome.kind });
        return;
      }

      await this.recordIntegrationSuccess('inara');
      this.notify();
    } catch (err) {
      this.inaraLastSent = null;
      logger.warn('inara', 'Send failed', { error: String(err) });
    } finally {
      this.inaraSending = false;
    }
  }

  /* ------------------------------------------------------------- EDDN */

  private eddnSending = false;
  private eddnTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Send queued observations on a timer rather than on the event that produced
   * them.
   *
   * Ingest stays off the network entirely: a slow upload cannot delay reading
   * the journal, and a burst of jumps produces one drain rather than twenty
   * requests.
   */
  private startEddnDrain(): void {
    if (this.eddnTimer !== null) return;
    this.eddnTimer = setInterval(() => void this.drainEddn(), 20_000);
  }

  /**
   * Offer one journal event to EDDN.
   *
   * Called on the high-frequency path, so the cheap rejection comes first: all
   * but seven event names are out, and that check is a set lookup before
   * anything is built or read.
   *
   * **Nothing is queued while the integration is off.** That is the promise the
   * Connections screen makes, and it is enforced here rather than at send time,
   * so switching EDDN off does not leave a queue quietly filling up.
   */
  private observeForEddn(event: NormalizedEvent): void {
    if (!EDDN_JOURNAL_EVENTS.includes(event.source.event)) return;
    if (!this.integrationState.eddn.enabled) return;
    if (!INTEGRATIONS.eddn.implemented) return;

    const message = this.buildEddnMessage(event);
    if (message === null) return;

    /*
     * The second audit pass, before anything is stored. The builder already
     * sanitises; this is the last point at which a mistake is still private,
     * and EDDN is public and permanent.
     */
    const problems = auditEddnMessage(message);
    if (problems.length > 0) {
      logger.warn('eddn', 'Message withheld by the audit', { problems: problems.join(', ') });
      return;
    }

    void this.enqueueEddn(event.source.provenance.eventId, message);
  }

  /**
   * Assemble the message, or null when the game has not said enough.
   *
   * Every required field has to be known. A position, a system address or a
   * game build that this run never observed cannot be guessed, and EDDN would
   * rather have nothing than a record with an invented coordinate in it.
   */
  private buildEddnMessage(event: NormalizedEvent): ReturnType<typeof buildEddnJournalMessage> {
    const s = this.state;
    if (!isKnown(s.commander) || !isKnown(s.gameVersion) || !isKnown(s.build)) return null;
    if (!isKnown(s.starSystem) || !isKnown(s.starPos) || !isKnown(s.systemAddress)) return null;

    return buildEddnJournalMessage(
      event.source.event,
      event.source.raw as Record<string, unknown>,
      {
        // The schema asks for the in-game commander name.
        uploaderID: s.commander,
        softwareName: 'EDFM Companion',
        softwareVersion: COMPANION_VERSION,
        gameversion: s.gameVersion,
        gamebuild: s.build,
      },
      {
        starSystem: s.starSystem,
        starPos: s.starPos,
        systemAddress: s.systemAddress,
        // Absent stays absent: the spec forbids substituting false for "the
        // game did not say".
        ...(isKnown(s.odyssey) ? { odyssey: s.odyssey } : {}),
      },
    );
  }

  /**
   * Store a message for sending.
   *
   * The id is the journal event id, which is `sourceFile:byteOffset` and
   * therefore stable across restart and replay. Re-reading a file re-derives the
   * same id and the insert is dropped, so an observation cannot be published
   * twice.
   */
  private async enqueueEddn(eventId: string, message: unknown): Promise<void> {
    if (!this.db) return;
    const now = new Date().toISOString();
    try {
      await this.db.execute(
        `INSERT OR IGNORE INTO integration_queue
           (id, integration, commander_fid, status, payload, attempts, created_at, updated_at)
         VALUES ($1, 'eddn', $2, 'queued', $3, 0, $4, $4)`,
        [eventId, this.discoveryFid, JSON.stringify(message), now],
      );
    } catch (err) {
      logger.warn('eddn', 'Could not queue an observation', { error: String(err) });
    }
  }

  /**
   * Send what is due.
   *
   * One message per request: EDDN's upload endpoint takes a single document, so
   * there is no batching to do. The queue is drained a few at a time rather than
   * all at once, because a commander who has been offline for an evening should
   * not open a hundred connections the moment they reconnect.
   */
  private async drainEddn(): Promise<void> {
    if (this.eddnSending || !this.db) return;
    if (!this.integrationState.eddn.enabled) return;

    this.eddnSending = true;
    try {
      const now = new Date().toISOString();
      const rows = await this.db.select<Array<{ id: string; payload: string; attempts: number }>>(
        `SELECT id, payload, attempts FROM integration_queue
          WHERE integration = 'eddn' AND status IN ('queued','retryable')
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY created_at
          LIMIT 10`,
        [now],
      );

      for (const row of rows) {
        const outcome = await this.postToEddn(row.payload);
        if (outcome === 'accepted') {
          await this.db.execute(`DELETE FROM integration_queue WHERE integration = 'eddn' AND id = $1`, [
            row.id,
          ]);
          this.eddnSent += 1;
          await this.recordIntegrationSuccess('eddn');
        } else if (outcome === 'rejected') {
          // A schema rejection is identical however often it is sent.
          await this.db.execute(
            `UPDATE integration_queue SET status = 'rejected', last_error = $2, updated_at = $3
              WHERE integration = 'eddn' AND id = $1`,
            [row.id, 'rejected by EDDN', new Date().toISOString()],
          );
        } else {
          const attempts = row.attempts + 1;
          const next = new Date(Date.now() + backoffFor(attempts) * 1000).toISOString();
          await this.db.execute(
            `UPDATE integration_queue
                SET status = 'retryable', attempts = $2, next_attempt_at = $3, updated_at = $4
              WHERE integration = 'eddn' AND id = $1`,
            [row.id, attempts, next, new Date().toISOString()],
          );
        }
      }
      if (rows.length > 0) this.notify();
    } catch (err) {
      logger.warn('eddn', 'Send failed', { error: String(err) });
    } finally {
      this.eddnSending = false;
    }
  }

  private eddnSent = 0;

  /**
   * One upload.
   *
   * EDDN answers `200` for accepted and `400` for a schema rejection. Anything
   * else -- a gateway, a timeout, a 5xx -- is the network rather than the
   * message, so it is retried.
   */
  private async postToEddn(payload: string): Promise<'accepted' | 'rejected' | 'retry'> {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      const response = await tauriFetch(EDDN_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (response.status === 200) return 'accepted';
      const verdict = classifyHttp(response.status);
      return verdict.kind === 'permanent' ? 'rejected' : 'retry';
    } catch {
      // No response at all: the network, not the message.
      return 'retry';
    }
  }

  /* --------------------------------------- rebuilding activity history */

  private historyRebuilding = false;
  private historyCancelled = false;

  /**
   * Rebuild the local Activity Journal from every journal file on disk.
   *
   * Needed because the Activity Journal only ever saw events from the moment
   * the feature existed. Live ingest resumes from a single `(file, offset)`
   * checkpoint and never looks back, so activity from before that point was
   * never recorded at all -- there was nothing locally to back-fill *from*. A
   * backfill without this would faithfully upload an empty history.
   *
   * Safe to run repeatedly. `replayFile` reproduces byte-identical `eventId`s,
   * the entry id *is* that event id, and the insert is `INSERT OR IGNORE`, so a
   * second pass writes nothing new.
   *
   * **It does not touch the live checkpoint.** That cursor drives current
   * commander state; moving it backwards here would replay months of state
   * transitions over the live session.
   *
   * Deliberately NOT in the sync section. Replay is the one path here that
   * handles raw journal events, and the source guards over that section assert
   * that the thing which talks to EDFM never touches one. Keeping this outside
   * is what lets those guards stay honest -- and nothing here sends anything.
   */
  readonly rebuildActivityHistory = async (
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ filesRead: number; entriesAdded: number; failed: number }> => {
    const empty = { filesRead: 0, entriesAdded: 0, failed: 0 };
    if (this.historyRebuilding) return empty;

    /*
     * The commander this rebuild is for. Entries are attributed to whoever the
     * journal says was playing, and only theirs are kept: writing another
     * commander's history into the table on their behalf is work nobody asked
     * for, and they can rebuild their own.
     */
    const fid = this.discoveryFid;
    const dir = this.directory;
    if (fid === null || dir === null) return empty;

    this.historyRebuilding = true;
    this.historyCancelled = false;
    this.notify();

    let filesRead = 0;
    let entriesAdded = 0;
    let failed = 0;

    try {
      const files = (await listJournalFiles(dir)).filter((f) => f.sizeBytes > 0);

      /*
       * A fresh engine, not the live one. The live engine holds current
       * commander state; pushing four months of historical events through it
       * would leave the app believing the commander is wherever they were in
       * June. One engine across all files, as live ingest also spans files.
       */
      const engine = new ActivityEngine({ commanderFid: null });

      for (const file of files) {
        if (this.historyCancelled) break;
        try {
          const replayed = await replayFile(file.fullPath);
          const produced: ActivityEntry[] = [];
          for (const event of replayed.events) {
            /*
             * The engine produces nothing at all until it has a commander, and
             * the journal is the only thing that knows which one. `provenance`
             * carries the FID from the governing Commander/LoadGame event, so
             * history is attributed to whoever actually played it rather than
             * to whoever happens to be signed in now.
             */
            const seen = event.source.provenance.fid;
            if (seen !== null) engine.setCommander(seen);
            produced.push(...engine.observe(event));
          }

          const mine = produced.filter((e) => e.commanderFid === fid);
          if (mine.length > 0) {
            await this.saveActivity(mine);
            entriesAdded += mine.length;
          }
        } catch (err) {
          // One unreadable file must not abandon the rest of the history.
          failed += 1;
          logger.warn('activity', 'Could not replay a file', {
            file: file.fileName,
            error: String(err),
          });
        }
        filesRead += 1;
        onProgress?.(filesRead, files.length);
      }

      await this.loadActivity(fid);
      logger.info('activity', 'History rebuilt', { filesRead, entriesAdded, failed });
      return { filesRead, entriesAdded, failed };
    } finally {
      this.historyRebuilding = false;
      this.historyCancelled = false;
      this.notify();
    }
  };

  /** Stop a running rebuild at the next file boundary. */
  readonly cancelActivityRebuild = (): void => {
    this.historyCancelled = true;
    this.notify();
  };

  /* ----------------------------------------------- EDFM journal sync */

  private journalState: JournalConnectionState = 'not-connected';
  private journalMessage: string | null = null;
  private journalServer: JournalStatus | null = null;
  private journalLastSuccess: string | null = null;
  private journalLastAttempt: string | null = null;
  private journalPending = 0;
  private journalFailed = 0;
  private journalWatermark: string | null = null;
  private journalSyncing = false;

  /**
   * The connection state, read in full.
   *
   * `syncJournalNow` reassigns the field behind an await, which the compiler
   * cannot see: it narrows `this.journalState` from the guards a caller made
   * earlier and then rejects a later check against the states it thinks were
   * excluded. Reading through here is a reference with no narrowing history, so
   * the declared type survives -- which is the truth, since the call changed it.
   */
  private get currentJournalState(): JournalConnectionState {
    return this.journalState;
  }

  /** Settings keys are per commander: two people share a machine, not an account. */
  private journalKey(suffix: string): string {
    return `edfm-journal.${suffix}.${this.discoveryFid ?? 'unknown'}`;
  }

  private async loadJournalSync(): Promise<void> {
    /*
     * Only read the per-commander settings once there is a commander. At
     * startup the FID is still unknown, and reading under a placeholder key
     * returns nothing while looking like a real answer.
     */
    if (this.discoveryFid !== null) {
      this.journalWatermark = await this.getSetting(this.journalKey('watermark'));
      this.journalLastSuccess = await this.getSetting(this.journalKey('lastSuccess'));
    }

    const hasCredential = await credentialPresent('edfm-journal');
    this.journalState = hasCredential ? 'connected' : 'not-connected';
    await this.refreshJournalCounts();
    this.notify();

    // Verify the stored token is still good, without blocking startup.
    if (hasCredential) void this.checkJournalStatus();
  }

  /**
   * Ask `/status` whether the connection still works.
   *
   * Separate from syncing because the answers differ: a revoked token must stop
   * uploads and say so, while an unreachable server must not — the entries are
   * kept and the local journal carries on regardless.
   */
  private async checkJournalStatus(): Promise<boolean> {
    this.journalLastAttempt = new Date().toISOString();
    try {
      const raw = await invoke<{
        status: number;
        body: string;
        retryAfterSeconds: number | null;
        transport_error: string | null;
      }>('edfm_journal_status');

      if (raw.transport_error !== null || raw.status === 0) {
        this.journalState = 'unavailable';
        this.journalMessage = 'EDFM could not be reached. Your entries are kept and will sync later.';
        this.notify();
        return false;
      }

      let body: unknown = null;
      try {
        body = JSON.parse(raw.body);
      } catch {
        body = null;
      }

      if (raw.status === 200) {
        const status = parseStatus(body);
        if (status === null) {
          // §27: a response this cannot read is not a working connection.
          this.journalState = 'unavailable';
          this.journalMessage = 'EDFM replied with something this app could not read.';
          this.notify();
          return false;
        }
        this.journalServer = status;
        this.journalState = 'connected';
        this.journalMessage = null;
        this.notify();
        return true;
      }

      const failure = classifyFailure(raw.status, body, raw.retryAfterSeconds ?? undefined);
      this.journalState =
        failure.kind === 'invalid-credential' || failure.kind === 'profile-missing'
          ? 'needs-attention'
          : 'unavailable';
      this.journalMessage = failure.message;
      this.notify();
      return false;
    } catch (err) {
      this.journalState = 'unavailable';
      this.journalMessage = 'EDFM could not be reached.';
      logger.warn('edfm-journal', 'Status check failed', { error: String(err) });
      this.notify();
      return false;
    }
  }

  /**
   * Store a token and verify it before claiming to be connected.
   *
   * Order matters, and so does the rollback: the credential is stored first
   * because the request is made in Rust and reads it from the store, but an
   * unusable credential is removed again rather than left behind looking
   * configured. §6 asks for exactly that.
   *
   * Returns null on success, or a sentence explaining the failure.
   */
  readonly connectJournalSync = async (token: string): Promise<string | null> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return 'Paste the token generated on edfieldmanual.com.';
    if (!looksLikeJournalToken(trimmed)) {
      // Caught locally so an obvious paste accident is a clear message rather
      // than a 401 the commander has to interpret.
      return 'That does not look like a journal sync token. It begins with edfmj_v1_.';
    }

    try {
      await credentialSet('edfm-journal', trimmed);
    } catch (err) {
      logger.warn('edfm-journal', 'Could not store the token', { error: String(err) });
      return 'The token could not be saved to the Windows Credential Manager.';
    }

    const ok = await this.checkJournalStatus();
    if (!ok) {
      // Unusable: take it back out rather than leaving a credential that looks
      // configured and never works.
      try {
        await credentialClear('edfm-journal');
      } catch {
        // Leaving it is survivable; the connection already reads as unusable.
      }
      this.journalState = 'not-connected';
      await this.loadIntegrationState();
      return this.journalMessage ?? 'The token could not be verified.';
    }

    // The Phase 1 boundary starts now. Nothing from before this is uploaded.
    this.journalWatermark = new Date().toISOString();
    await this.setSetting(this.journalKey('watermark'), this.journalWatermark);
    await this.setSetting(`integration.edfm-journal.${this.discoveryFid}.enabled`, 'true');
    await this.loadIntegrationState();
    this.notify();
    return null;
  };

  /**
   * Forget the local credential.
   *
   * **This does not revoke the token on the website**, and the UI says so. Only
   * EDFM can revoke it, so claiming otherwise would leave a commander believing
   * a credential was dead when it was not.
   *
   * The local Activity Journal and the queue survive: disconnecting is not a
   * reason to lose a record of what they did.
   */
  readonly disconnectJournalSync = async (): Promise<void> => {
    try {
      await credentialClear('edfm-journal');
    } catch (err) {
      logger.warn('edfm-journal', 'Could not clear the token', { error: String(err) });
    }
    this.journalState = 'not-connected';
    this.journalServer = null;
    this.journalMessage = null;
    if (this.discoveryFid !== null) {
      await this.setSetting(`integration.edfm-journal.${this.discoveryFid}.enabled`, 'false');
    }
    await this.loadIntegrationState();
    this.notify();
  };

  /**
   * Queue an entry, if Phase 1 covers it.
   *
   * Called as entries are recorded. Never awaited by ingest: the field journal
   * is a record, and syncing it must not gate reading the game's.
   */
  private async enqueueJournalEntries(entries: readonly ActivityEntry[]): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    if (this.journalState === 'not-connected') return;

    const eligible = entries.filter((e) => isWithinPhaseOne(e.occurredAt, this.journalWatermark));
    if (eligible.length === 0) return;

    const now = new Date().toISOString();
    try {
      for (const entry of eligible) {
        // The queue id IS the entry id: measured compatible with the server's
        // stable-client-id rules, so a retry cannot create a duplicate.
        await this.db.execute(
          `INSERT OR IGNORE INTO integration_queue
             (id, integration, commander_fid, status, payload, attempts, created_at, updated_at)
           VALUES ($1, 'edfm-journal', $2, 'queued', $3, 0, $4, $4)`,
          [entry.id, this.discoveryFid, JSON.stringify({ entryId: entry.id }), now],
        );
      }
      await this.refreshJournalCounts();
    } catch (err) {
      logger.warn('edfm-journal', 'Could not queue entries', { error: String(err) });
    }
  }

  /**
   * Look entries up by id, from the table rather than the screen's window.
   *
   * Chunked, because SQLite has a bound-parameter limit and a backfill batch
   * can ask for a hundred ids at once.
   */
  private async loadActivityByIds(
    fid: string,
    ids: readonly string[],
  ): Promise<readonly ActivityEntry[]> {
    if (!this.db || ids.length === 0) return [];
    const out: ActivityEntry[] = [];
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const holes = slice.map((_, n) => `$${n + 2}`).join(',');
      try {
        const rows = await this.db.select<ActivityRow[]>(
          `SELECT * FROM activity_entries
            WHERE commander_fid = $1 AND id IN (${holes})`,
          [fid, ...slice],
        );
        out.push(...rows.map(activityFromRow));
      } catch (err) {
        logger.warn('db', 'Could not read activity by id', { error: String(err) });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- backfill */

  /**
   * What a backfill would send, before sending any of it.
   *
   * Automatic sync uploads nothing from before the moment it was switched on,
   * because a back catalogue is a decision with weight: how much, how far back,
   * and what becomes visible. So this answers the question first and sends
   * nothing -- the commander sees the count and the span, and chooses.
   *
   * Counts only what is not already queued or sent, so the number shrinks as a
   * backfill progresses rather than describing the same work twice.
   */
  readonly journalBackfillPreview = async (): Promise<{
    entries: number;
    oldest: string | null;
    newest: string | null;
  }> => {
    const fid = this.discoveryFid;
    if (!this.db || fid === null) return { entries: 0, oldest: null, newest: null };
    const holes = SYNCABLE_SUBTYPES.map((_, i) => `$${i + 2}`).join(',');
    try {
      const rows = await this.db.select<
        Array<{ n: number; oldest: string | null; newest: string | null }>
      >(
        `SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest
           FROM activity_entries a
          WHERE a.commander_fid = $1
            AND a.subtype IN (${holes})
            AND a.synced_at IS NULL
            AND NOT EXISTS (
              -- Matched on (integration, id) and deliberately NOT on
              -- commander_fid, because that pair is the queue's PRIMARY KEY.
              -- This probe predicts what the upload will actually queue, and
              -- that upload is an INSERT OR IGNORE: it collides on the key,
              -- whoever the row belongs to. Adding q.commander_fid = a.commander_fid
              -- here made the probe disagree with the insert -- the preview
              -- counted an entry as sendable, the insert then silently dropped
              -- it, and the number shown was larger than the work done.
              --
              -- The scoping that matters is elsewhere and is unaffected: the
              -- send path selects by commander_fid, so a row belonging to
              -- another commander is never transmitted under this token.
              SELECT 1 FROM integration_queue q
               WHERE q.integration = 'edfm-journal' AND q.id = a.id
            )`,
        [fid, ...SYNCABLE_SUBTYPES],
      );
      return {
        entries: Number(rows[0]?.n ?? 0),
        oldest: rows[0]?.oldest ?? null,
        newest: rows[0]?.newest ?? null,
      };
    } catch (err) {
      logger.warn('edfm-journal', 'Could not preview the backfill', { error: String(err) });
      return { entries: 0, oldest: null, newest: null };
    }
  };

  /**
   * Queue everything not yet sent, however old, and then send it.
   *
   * This is the Phase 2 action the watermark was holding back, so it runs only
   * when the commander asks for it. The watermark itself is left alone: it
   * still governs what new activity is queued automatically, and this is a
   * one-off decision rather than a change of policy.
   */
  readonly backfillJournalSync = async (
    onProgress?: (sent: number, total: number) => void,
  ): Promise<string | null> => {
    const fid = this.discoveryFid;
    if (!this.db || fid === null) return 'No commander is loaded yet.';
    if (this.journalState === 'not-connected') return 'Connect your journal sync token first.';
    if (this.journalBackfilling) return null;

    this.journalBackfilling = true;
    this.journalCancelled = false;
    this.notify();

    const holes = SYNCABLE_SUBTYPES.map((_, i) => `$${i + 3}`).join(',');

    try {
      const now = new Date().toISOString();
      /*
       * Queued in one statement rather than row by row. The queue id is the
       * entry id, so `INSERT OR IGNORE` makes this safe to run twice, and
       * anything already queued or sent is left exactly as it was.
       */
      await this.db.execute(
        `INSERT OR IGNORE INTO integration_queue
           (id, integration, commander_fid, status, payload, attempts, created_at, updated_at)
         SELECT a.id, 'edfm-journal', a.commander_fid, 'queued',
                json_object('entryId', a.id), 0, $2, $2
           FROM activity_entries a
          WHERE a.commander_fid = $1
            AND a.subtype IN (${holes})
            AND a.synced_at IS NULL`,
        [fid, now, ...SYNCABLE_SUBTYPES],
      );
      await this.refreshJournalCounts();
      this.notify();

      const total = this.journalPending;
      let sent = 0;

      /*
       * One batch at a time, with a pause between them. A backfill is the only
       * time this client sends sustained traffic, so it is paced deliberately
       * rather than looping as fast as the server will answer.
       */
      while (!this.journalCancelled) {
        const before = this.journalPending;
        if (before === 0) break;

        await this.syncJournalNow();

        const state = this.currentJournalState;
        if (state === 'needs-attention' || state === 'not-connected') {
          return this.journalMessage ?? 'Sync stopped: the connection needs attention.';
        }

        await this.refreshJournalCounts();
        if (this.journalPending >= before) {
          /*
           * No progress. Either everything left is waiting on a backoff or the
           * server is refusing: either way, stop rather than spin. The queue is
           * durable, so the next attempt resumes from here.
           */
          return this.journalPending > 0
            ? 'Some entries are waiting to retry. They will go on the next sync.'
            : null;
        }

        sent += before - this.journalPending;
        onProgress?.(sent, total);
        await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
      }

      return this.journalCancelled ? 'Stopped. Everything still queued will be sent later.' : null;
    } catch (err) {
      logger.warn('edfm-journal', 'Backfill failed', { error: String(err) });
      return 'The backfill could not be completed. Nothing was lost.';
    } finally {
      this.journalBackfilling = false;
      await this.refreshJournalCounts();
      this.notify();
    }
  };

  /** Stop a running backfill at the end of the batch in flight. */
  readonly cancelJournalBackfill = (): void => {
    this.journalCancelled = true;
    this.notify();
  };

  private journalBackfilling = false;
  private journalCancelled = false;

  private async refreshJournalCounts(): Promise<void> {
    if (!this.db || this.discoveryFid === null) {
      this.journalPending = 0;
      this.journalFailed = 0;
      return;
    }
    try {
      const rows = await this.db.select<Array<{ status: string; n: number }>>(
        `SELECT status, COUNT(*) AS n FROM integration_queue
          WHERE integration = 'edfm-journal' AND commander_fid = $1 GROUP BY status`,
        [this.discoveryFid],
      );
      const at = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
      this.journalPending = at('queued') + at('retryable');
      this.journalFailed = at('rejected');
    } catch {
      // Counts are informational; a failed read must not break the screen.
    }
  }

  /**
   * Push what is waiting.
   *
   * One batch per call. The queue is durable, so the rest simply waits rather
   * than being held in memory, and a failure mid-way loses nothing.
   */
  readonly syncJournalNow = async (): Promise<void> => {
    if (this.journalSyncing) return;
    if (!this.db || this.discoveryFid === null) return;
    if (this.journalState === 'not-connected' || this.journalState === 'needs-attention') return;

    this.journalSyncing = true;
    this.journalState = 'syncing';
    this.journalLastAttempt = new Date().toISOString();
    this.notify();

    try {
      await this.runJournalBatch();
    } catch (err) {
      logger.warn('edfm-journal', 'Sync failed', { error: String(err) });
      this.journalState = 'unavailable';
      this.journalMessage = 'The sync could not be completed. Your entries are kept.';
    } finally {
      this.journalSyncing = false;
      await this.refreshJournalCounts();
      this.notify();
    }
  };

  private async runJournalBatch(): Promise<void> {
    const fid = this.discoveryFid;
    if (!this.db || fid === null) return;

    const limits = this.journalServer?.limits;
    const now = new Date().toISOString();

    // Commander-scoped, and only rows actually due.
    const rows = await this.db.select<Array<{ id: string }>>(
      `SELECT id FROM integration_queue
        WHERE integration = 'edfm-journal' AND commander_fid = $1
          AND status IN ('queued','retryable')
          AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
        ORDER BY created_at
        LIMIT $3`,
      [fid, now, limits?.maxBatchEntries ?? 100],
    );
    if (rows.length === 0) {
      this.journalState = 'connected';
      return;
    }

    const wanted = new Set(rows.map((r) => r.id));

    /*
     * Read from the table, not from `activityEntries`.
     *
     * That list is the most recent 500 rows for the screen. Resolving queued
     * ids against it meant anything older was "not found" and was deleted from
     * the queue as unsendable -- which made a history backfill impossible: the
     * rows were discarded before they could be sent. The queue is durable, so
     * its entries must be looked up somewhere equally durable.
     */
    const entries = await this.loadActivityByIds(fid, [...wanted]);

    // An entry whose row exists but is no longer in memory is dropped from the
    // queue rather than retried forever: there is nothing left to send.
    const found = new Set(entries.map((e) => e.id));
    for (const id of wanted) {
      if (!found.has(id)) {
        await this.db.execute(
          `DELETE FROM integration_queue WHERE integration = 'edfm-journal' AND id = $1 AND commander_fid = $2`,
          [id, fid],
        );
      }
    }
    if (entries.length === 0) return;

    const { batch, skipped } = buildBatch(entries, COMPANION_VERSION, {
      maxEntries: limits?.maxBatchEntries,
      maxRequestBytes: limits?.maxRequestBytes,
      maxEntryDataBytes: limits?.maxEntryDataBytes,
    });

    // Entries this client refuses to send will never become sendable.
    for (const s of skipped) {
      await this.markJournalRejected(s.id, s.reason);
    }
    if (batch === null) return;

    const sentIds = batch.entries.map((e) => e.id);
    const raw = await invoke<{
      status: number;
      body: string;
      retryAfterSeconds: number | null;
      transport_error: string | null;
    }>('edfm_journal_batch', { body: JSON.stringify(batch) });

    if (raw.transport_error !== null || raw.status === 0) {
      this.journalState = 'unavailable';
      this.journalMessage = 'EDFM could not be reached. Your entries are kept and will sync later.';
      await this.backoffJournal(sentIds);
      return;
    }

    let body: unknown = null;
    try {
      body = JSON.parse(raw.body);
    } catch {
      body = null;
    }

    if (raw.status !== 200 && raw.status !== 207) {
      const failure = classifyFailure(raw.status, body, raw.retryAfterSeconds ?? undefined);
      this.journalMessage = failure.message;
      if (failure.kind === 'invalid-credential' || failure.kind === 'profile-missing') {
        // Stop. Repeating an authenticated request with a dead token is both
        // useless and rude to the server.
        this.journalState = 'needs-attention';
        return;
      }
      this.journalState = 'unavailable';
      if (failure.retryable) await this.backoffJournal(sentIds, failure.retryAfterSeconds);
      else for (const id of sentIds) await this.markJournalRejected(id, failure.kind);
      return;
    }

    const outcome = parseBatchOutcome(body);
    if (outcome === null) {
      /*
       * §27: nothing is marked synchronised on a status code. A 200 whose body
       * cannot be read acknowledged nothing, so everything stays queued.
       */
      this.journalState = 'unavailable';
      this.journalMessage = 'EDFM replied with something this app could not read. Nothing was marked as synced.';
      await this.backoffJournal(sentIds);
      return;
    }

    const applied = applyBatchOutcome(sentIds, outcome);

    const acknowledgedAt = new Date().toISOString();
    for (const id of applied.acknowledged) {
      /*
       * Record the acknowledgement on the entry BEFORE removing the queue row.
       * The queue is not an archive, so a finished row is deleted -- but then
       * nothing remembered that EDFM had it, and a second backfill re-sent the
       * whole history. If the delete fails after this, the worst case is a row
       * that is queued and already marked sent, which the next pass drops.
       */
      await this.db.execute(
        `UPDATE activity_entries SET synced_at = $3
          WHERE id = $1 AND commander_fid = $2 AND synced_at IS NULL`,
        [id, fid, acknowledgedAt],
      );
      await this.db.execute(
        `DELETE FROM integration_queue WHERE integration = 'edfm-journal' AND id = $1 AND commander_fid = $2`,
        [id, fid],
      );
    }
    for (const row of applied.permanent) {
      await this.markJournalRejected(row.id, row.reason);
    }
    if (applied.retryable.length > 0 || applied.unanswered.length > 0) {
      await this.backoffJournal([...applied.retryable, ...applied.unanswered]);
    }

    if (applied.acknowledged.length > 0) {
      this.journalLastSuccess = new Date().toISOString();
      await this.setSetting(this.journalKey('lastSuccess'), this.journalLastSuccess);
    }

    this.journalState = 'connected';
    this.journalMessage =
      applied.permanent.length > 0 ? 'Some entries could not be synced and will not be retried.' : null;
  }

  private async markJournalRejected(id: string, reason: string): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    await this.db.execute(
      `UPDATE integration_queue SET status = 'rejected', last_error = $3, updated_at = $4
        WHERE integration = 'edfm-journal' AND id = $1 AND commander_fid = $2`,
      [id, this.discoveryFid, reason.slice(0, 200), new Date().toISOString()],
    );
  }

  /**
   * Put work back with a wait.
   *
   * The delay is stored on the row rather than held in a timer, so it survives
   * a restart instead of collapsing into a retry storm.
   */
  private async backoffJournal(ids: readonly string[], seconds?: number): Promise<void> {
    if (!this.db || this.discoveryFid === null || ids.length === 0) return;
    const now = new Date();
    for (const id of ids) {
      const rows = await this.db.select<Array<{ attempts: number }>>(
        `SELECT attempts FROM integration_queue WHERE integration = 'edfm-journal' AND id = $1 AND commander_fid = $2`,
        [id, this.discoveryFid],
      );
      const attempts = Number(rows[0]?.attempts ?? 0) + 1;
      const wait = seconds ?? backoffFor(attempts);
      const next = new Date(now.getTime() + wait * 1000).toISOString();
      await this.db.execute(
        `UPDATE integration_queue
            SET status = 'retryable', attempts = $3, next_attempt_at = $4, updated_at = $5
          WHERE integration = 'edfm-journal' AND id = $1 AND commander_fid = $2`,
        [id, this.discoveryFid, attempts, next, now.toISOString()],
      );
    }
  }

  private journalSyncView(): JournalSyncView {
    return {
      state: this.journalState,
      hasCredential: this.integrationState['edfm-journal'].hasCredential,
      pending: this.journalPending,
      failed: this.journalFailed,
      lastSuccessAt: this.journalLastSuccess,
      lastAttemptAt: this.journalLastAttempt,
      message: this.journalMessage,
      server: this.journalServer,
      syncingSince: this.journalWatermark,
      backfilling: this.journalBackfilling,
      rebuilding: this.historyRebuilding,
    };
  }

  /* ------------------------------------------------------- screenshots */

  private screenshotHotkey: string | null = null;
  private screenshotFolder: string | null = null;
  private screenshotFolderOk = false;
  private screenshotDraft: ScreenshotDraft | null = null;
  private draftInMainWindow = false;
  private captureRepliesBound = false;
  private screenshotList: ScreenshotRecord[] = [];
  private screenshotError: string | null = null;
  /** Rebuilt on every catalog read; never persisted, because it is not a fact
      about the screenshot but about the disk at this moment. */
  private missingScreenshots: ReadonlySet<string> = new Set();

  /** Newest first, and bounded: the browser pages rather than holding everything. */
  private static readonly SCREENSHOTS_IN_MEMORY = 300;

  /**
   * Resolve the folder captures are saved into.
   *
   * Defaults to `Pictures/EDFM Companion/Screenshots`, reached through the
   * known-folder API rather than by appending "Pictures" to the user profile:
   * the folder is relocatable, and on a machine where it has been moved a
   * string-built path is simply wrong.
   *
   * Images never go into application data. A commander's screenshots belong
   * somewhere they can find them without knowing this app exists.
   */
  private async loadScreenshotSettings(): Promise<void> {
    this.screenshotHotkey = (await this.getSetting('screenshot.hotkey')) ?? null;

    const stored = await this.getSetting('screenshot.folder');
    if (stored) {
      this.screenshotFolder = stored;
    } else {
      try {
        const pictures = await invoke<string | null>('pictures_dir');
        this.screenshotFolder = pictures
          ? `${pictures}\\EDFM Companion\\Screenshots`
          : null;
      } catch {
        this.screenshotFolder = null;
      }
    }

    this.screenshotFolderOk = await this.checkScreenshotFolder();
    await this.registerScreenshotHotkey();
    this.notify();
  }

  private async checkScreenshotFolder(): Promise<boolean> {
    if (!this.screenshotFolder) return false;
    try {
      return await invoke<boolean>('folder_writable', { path: this.screenshotFolder });
    } catch {
      return false;
    }
  }

  /**
   * Bind the chosen hotkey, if there is one.
   *
   * **Nothing is bound unless the commander chose it.** Elite players run dense
   * keyboard and HOTAS setups, and silently claiming a combination could break
   * something they rely on mid-flight.
   */
  private async registerScreenshotHotkey(): Promise<void> {
    try {
      const { unregisterAll, register } = await import('@tauri-apps/plugin-global-shortcut');
      await unregisterAll();
      if (!this.screenshotHotkey) return;
      await register(this.screenshotHotkey, (event) => {
        // The plugin fires for press and release; one capture per press.
        if (event.state !== undefined && event.state !== 'Pressed') return;
        void this.captureScreenshot();
      });
    } catch (err) {
      // A combination the OS will not give us is a normal outcome, not a crash.
      this.screenshotError =
        'That key combination could not be registered. Another application may already own it.';
      logger.warn('screenshot', 'Hotkey registration failed', { error: String(err) });
      this.notify();
    }
  }

  /**
   * Choose or clear the capture hotkey.
   *
   * Returns null on success, or a reason. Clearing is passing null, which is
   * also the shipped state.
   */
  readonly setScreenshotHotkey = async (binding: string | null): Promise<string | null> => {
    if (binding !== null) {
      const check = validateHotkey(binding);
      if (!check.ok) return check.reason;
    }

    const previous = this.screenshotHotkey;
    this.screenshotHotkey = binding;
    this.screenshotError = null;
    await this.registerScreenshotHotkey();

    if (this.screenshotError !== null) {
      // Registration failed: put the old binding back rather than leaving the
      // commander with a setting that reads as active and does nothing.
      const reason = this.screenshotError;
      this.screenshotHotkey = previous;
      await this.registerScreenshotHotkey();
      this.screenshotError = reason;
      this.notify();
      return reason;
    }

    await this.setSetting('screenshot.hotkey', binding ?? '');
    this.notify();
    return null;
  };

  readonly setScreenshotFolder = async (path: string): Promise<boolean> => {
    const trimmed = path.trim();
    if (trimmed.length === 0) return false;
    let ok = false;
    try {
      ok = await invoke<boolean>('folder_writable', { path: trimmed });
    } catch {
      ok = false;
    }
    if (!ok) {
      // §22: never quietly save somewhere unexpected.
      this.screenshotError = 'That folder cannot be written to. Captures would have nowhere to go.';
      this.notify();
      return false;
    }
    this.screenshotFolder = trimmed;
    this.screenshotFolderOk = true;
    this.screenshotError = null;
    await this.setSetting('screenshot.folder', trimmed);
    this.notify();
    return true;
  };

  /**
   * What the app believes right now, for prefilling.
   *
   * Assembled here because this is the only place that can see every source at
   * once. Each field is read from what was actually observed; nothing is
   * inferred to fill a gap.
   */
  private captureContext(): CaptureContext {
    const live = this.liveActivity.state?.exobiology ?? null;
    const active = live?.rows.find((r) => !r.completed && r.samplesTaken !== 0) ?? null;
    const newest = this.activityEntries[0] ?? null;

    const systemName = isKnown(this.state.starSystem) ? this.state.starSystem : null;
    const stateBody = isKnown(this.state.body) ? this.state.body : null;

    return {
      systemName,
      /*
       * A body equal to the system name carries nothing: in supercruise and
       * witchspace the game reports the main star, whose name is the system's,
       * and prefilling it produced rows reading "Wregoe VQ-V b48-0 · Wregoe
       * VQ-V b48-0".
       */
      bodyName: live?.bodyName ?? (stateBody === systemName ? null : stateBody),
      stationName: isKnown(this.state.stationName) ? this.state.stationName : null,
      settlement: null,
      shipName: isKnown(this.state.ship) ? this.state.ship : null,
      sampling:
        active && active.species
          ? {
              species: active.species,
              genus: active.genus,
              colour: active.colour,
              samplesTaken: active.samplesTaken,
              samplesRequired: active.samplesRequired,
              completed: active.completed,
            }
          : null,
      latestEntry: newest
        ? {
            id: newest.id,
            title: newest.title,
            occurredAt: newest.occurredAt,
            category: newest.category,
          }
        : null,
    };
  }

  /**
   * Capture, and open the confirmation dialog.
   *
   * The image is written to a staging file first and renamed only after the
   * commander confirms, so a cancelled dialog, a rejected filename or an
   * unavailable destination can never lose it.
   */
  readonly captureScreenshot = async (): Promise<void> => {
    if (this.screenshotDraft !== null) return; // one at a time

    this.screenshotError = null;
    try {
      const staging = `${this.screenshotFolder ?? ''}\\.edfm-pending`;
      const result = await invoke<{
        path: string;
        width: number;
        height: number;
        source: string;
        looks_blank: boolean;
      }>('capture_screenshot', { stagingDir: staging });

      const capturedAt = new Date().toISOString();
      this.screenshotDraft = {
        stagingPath: result.path,
        capturedAt,
        width: result.width,
        height: result.height,
        source: result.source,
        looksBlank: result.looks_blank,
        suggestion: prefill(this.captureContext()),
      };
      this.notify();

      await this.openCaptureWindow();
    } catch (err) {
      // §22: a failed capture produces an error, never a catalog entry.
      this.screenshotError = 'The screenshot could not be captured.';
      logger.warn('screenshot', 'Capture failed', { error: sanitisePath(String(err)) });
      this.notify();
    }
  };

  /**
   * Show the form over the game.
   *
   * A separate always-on-top window, positioned on the game's monitor. In
   * Borderless this draws over Elite, which keeps rendering behind it — the
   * commander answers one question without leaving the cockpit view.
   *
   * The overlay is **not** touched. It stays click-through throughout: making it
   * interactive for a form and restoring it afterwards is exactly the state that
   * gets left switched on when an error path is taken, and a second window
   * cannot leave the first in a bad state.
   *
   * Falls back to the main window if that window cannot be shown, because a
   * capture that cannot be answered is worse than one answered in the wrong
   * place.
   */
  private async openCaptureWindow(): Promise<void> {
    const draft = this.screenshotDraft;
    if (!draft) return;

    try {
      const [{ WebviewWindow }, { emit }] = await Promise.all([
        import('@tauri-apps/api/webviewWindow'),
        import('@tauri-apps/api/event'),
      ]);

      const win = await WebviewWindow.getByLabel('capture');
      if (!win) throw new Error('no capture window');

      await this.bindCaptureReplies();

      // Centre it on the game's monitor rather than the primary one: on a
      // multi-monitor setup the form belongs where the commander is looking.
      try {
        const info = await invoke<{
          found: boolean;
          x: number;
          y: number;
          width: number;
          height: number;
        }>('elite_window_info');
        if (info.found && info.width > 0 && info.height > 0) {
          const { LogicalPosition } = await import('@tauri-apps/api/dpi');
          await win.setPosition(
            new LogicalPosition(
              Math.round(info.x + info.width / 2 - 260),
              Math.round(info.y + info.height / 2 - 330),
            ),
          );
        } else {
          await win.center();
        }
      } catch {
        await win.center();
      }

      await emit('capture-draft', {
        draft,
        folder: this.screenshotFolder,
        error: this.screenshotError,
      });

      await win.show();
      await win.setAlwaysOnTop(true);
      await win.setFocus();
      this.draftInMainWindow = false;
      this.notify();
    } catch (err) {
      /*
       * The window could not be shown. The draft is already in the store and
       * the image is already on disk, so the main window renders the same form
       * instead.
       */
      logger.warn('screenshot', 'Capture window unavailable; using the main window', {
        error: String(err),
      });
      this.draftInMainWindow = true;
      this.notify();
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        await w.show();
        await w.unminimize();
        await w.setFocus();
      } catch {
        // Focus is a convenience; the form is on screen regardless.
      }
    }
  }

  /**
   * Listen for the capture window's answer, once.
   *
   * Bound lazily rather than at startup so a commander who never sets a hotkey
   * never registers listeners for a feature they do not use.
   */
  private async bindCaptureReplies(): Promise<void> {
    if (this.captureRepliesBound) return;
    this.captureRepliesBound = true;

    const { listen } = await import('@tauri-apps/api/event');

    await listen<ScreenshotSaveRequest>('capture-save', (e) => {
      void this.saveScreenshot(e.payload);
    });
    await listen('capture-cancel', () => {
      this.discardScreenshotDraft();
    });
  }

  /** Tell the capture window it may close, or why it may not. */
  private async closeCaptureWindow(problem: string | null): Promise<void> {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      if (problem === null) {
        await emit('capture-done');
      } else {
        // Reopened with the reason rather than closing on a failure the
        // commander has not seen.
        await emit('capture-error', problem);
      }
    } catch {
      // The window may already be gone; nothing here depends on it.
    }
  }

  readonly discardScreenshotDraft = (): void => {
    this.screenshotDraft = null;
    this.draftInMainWindow = false;
    this.screenshotError = null;
    void this.closeCaptureWindow(null);
    this.notify();
  };

  /**
   * Rename the staged capture and catalog it.
   *
   * Order matters: the file is moved first, and the row is written only if that
   * succeeded. A catalog entry pointing at a file that was never created would
   * be worse than no entry.
   */
  readonly saveScreenshot = async (request: ScreenshotSaveRequest): Promise<void> => {
    const draft = this.screenshotDraft;
    if (!draft) return;

    const folder = this.screenshotFolder;
    if (!folder) {
      this.screenshotError = 'No screenshot folder is set.';
      this.notify();
      return;
    }

    let finalPath = draft.stagingPath;

    if (!request.keepOriginalName) {
      const wanted = sanitiseSegment(request.filename) || sanitiseSegment(`Screenshot`);
      const named = wanted.toLowerCase().endsWith('.png') ? wanted : `${wanted}.png`;

      // Collisions are resolved against the disk, never by overwriting.
      let resolved: string;
      try {
        resolved = await this.resolveOnDisk(folder, named);
      } catch {
        resolved = named;
      }

      try {
        finalPath = await invoke<string>('commit_screenshot', {
          from: draft.stagingPath,
          to: `${folder}\\${resolved}`,
        });
      } catch (err) {
        /*
         * §22: keep the original file and the draft. The commander can correct
         * the name and try again; nothing has been lost.
         */
        this.screenshotError =
          'The screenshot could not be moved to your folder. It is still saved, under its temporary name.';
        logger.warn('screenshot', 'Commit failed', { error: sanitisePath(String(err)) });
        void this.closeCaptureWindow(this.screenshotError);
        this.notify();
        return;
      }
    }

    await this.catalogScreenshot(draft, request, finalPath);
    this.screenshotDraft = null;
    this.draftInMainWindow = false;
    void this.closeCaptureWindow(null);
    this.notify();
  };

  /** Ask the filesystem, one candidate at a time, so nothing is overwritten. */
  private async resolveOnDisk(folder: string, name: string): Promise<string> {
    const checked = new Map<string, boolean>();
    const exists = (candidate: string): boolean => checked.get(candidate) ?? false;

    // Probe up to a handful of candidates; `resolveCollision` is pure, so the
    // answers are gathered first.
    let current = name;
    for (let i = 0; i < 16; i += 1) {
      const taken = await invoke<boolean>('path_exists', { path: `${folder}\\${current}` });
      checked.set(current, taken);
      if (!taken) return current;
      current = resolveCollision(name, exists);
    }
    return current;
  }

  private async catalogScreenshot(
    draft: ScreenshotDraft,
    request: ScreenshotSaveRequest,
    filePath: string,
  ): Promise<void> {
    const fid = this.discoveryFid;
    if (!this.db || fid === null) {
      // Without a commander there is nobody to attribute it to, and §14 forbids
      // guessing. The image is saved; only the catalog row is skipped.
      this.screenshotError =
        'The image was saved, but no commander is identified yet, so it was not catalogued.';
      return;
    }

    const now = new Date().toISOString();
    const record: ScreenshotRecord = {
      id: `${draft.capturedAt}:${filePath}`,
      commanderFid: fid,
      filePath,
      capturedAt: draft.capturedAt,
      category: request.category || DEFAULT_CATEGORY,
      subject: request.subject?.trim() || null,
      systemName: request.systemName?.trim() || null,
      bodyName: request.bodyName?.trim() || null,
      stationName: request.stationName?.trim() || null,
      settlement: null,
      tags: normaliseTags(request.tags),
      note: request.note?.trim() || null,
      activityEntryId: request.activityEntryId,
      width: draft.width,
      height: draft.height,
    };

    try {
      await this.db.execute(
        `INSERT OR REPLACE INTO screenshots
           (id, commander_fid, file_path, captured_at, category, subject,
            system_name, body_name, station_name, settlement, tags, note,
            activity_entry_id, context_snapshot, width, height, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
        [
          record.id,
          record.commanderFid,
          record.filePath,
          record.capturedAt,
          record.category,
          record.subject,
          record.systemName,
          record.bodyName,
          record.stationName,
          record.settlement,
          JSON.stringify(record.tags),
          record.note,
          record.activityEntryId,
          // What the app believed, kept so a bad suggestion can later be told
          // apart from a bad choice.
          JSON.stringify({ source: draft.source, suggested: draft.suggestion.category.value }),
          record.width,
          record.height,
          now,
        ],
      );
      this.screenshotList = [record, ...this.screenshotList].slice(
        0,
        Companion.SCREENSHOTS_IN_MEMORY,
      );
    } catch (err) {
      this.screenshotError = 'The image was saved, but it could not be catalogued.';
      logger.warn('screenshot', 'Catalog write failed', { error: sanitisePath(String(err)) });
    }
  }

  /** Load this commander's catalog. Never another's. */
  private async loadScreenshots(): Promise<void> {
    if (!this.db || this.discoveryFid === null) {
      this.screenshotList = [];
      return;
    }
    try {
      const rows = await this.db.select<Array<Record<string, unknown>>>(
        `SELECT id, commander_fid, file_path, captured_at, category, subject,
                system_name, body_name, station_name, settlement, tags, note,
                activity_entry_id, width, height
           FROM screenshots
          WHERE commander_fid = $1
          ORDER BY captured_at DESC
          LIMIT $2`,
        [this.discoveryFid, Companion.SCREENSHOTS_IN_MEMORY],
      );
      this.screenshotList = rows.map((r) => screenshotFromRow(r));
      await this.checkScreenshotFiles();
    } catch (err) {
      logger.warn('screenshot', 'Could not read the catalog', { error: String(err) });
      this.screenshotList = [];
    }
    this.notify();
  }

  /**
   * Find out which catalogued images are still on disk.
   *
   * One batched call rather than one per row: a commander with a few hundred
   * screenshots should not wait on a few hundred round trips to open the screen.
   *
   * A failure to ask leaves everything marked present. Showing rows as missing
   * because the check itself broke would be worse than showing a stale list.
   */
  private async checkScreenshotFiles(): Promise<void> {
    if (this.screenshotList.length === 0) {
      this.missingScreenshots = new Set();
      return;
    }
    try {
      const paths = this.screenshotList.map((r) => r.filePath);
      const present = await invoke<boolean[]>('paths_exist', { paths });
      const gone = new Set<string>();
      this.screenshotList.forEach((row, i) => {
        if (present[i] === false) gone.add(row.id);
      });
      this.missingScreenshots = gone;
      this.notify();
    } catch (err) {
      logger.warn('screenshot', 'Could not check which images are still there', {
        error: String(err),
      });
    }
  }

  /**
   * Forget every entry whose image is gone.
   *
   * Deliberately a separate, explicit action rather than something that happens
   * on load. The rows carry writing the commander did, and a drive that is
   * merely unplugged today will be back tomorrow.
   */
  readonly removeMissingFromCatalog = async (): Promise<void> => {
    const gone = [...this.missingScreenshots];
    if (gone.length === 0 || !this.db || this.discoveryFid === null) return;

    try {
      for (const id of gone) {
        await this.db.execute('DELETE FROM screenshots WHERE id = $1 AND commander_fid = $2', [
          id,
          this.discoveryFid,
        ]);
      }
      const removed = new Set(gone);
      this.screenshotList = this.screenshotList.filter((r) => !removed.has(r.id));
      this.missingScreenshots = new Set();
      this.notify();
    } catch (err) {
      logger.warn('screenshot', 'Could not remove the missing entries', { error: String(err) });
    }
  };

  readonly updateScreenshot = async (
    id: string,
    patch: Partial<ScreenshotRecord>,
  ): Promise<void> => {
    if (!this.db || this.discoveryFid === null) return;
    const i = this.screenshotList.findIndex((r) => r.id === id);
    if (i === -1) return;

    const next: ScreenshotRecord = {
      ...this.screenshotList[i]!,
      ...patch,
      tags: normaliseTags(patch.tags ?? this.screenshotList[i]!.tags),
    };

    try {
      await this.db.execute(
        `UPDATE screenshots
            SET category = $3, subject = $4, system_name = $5, body_name = $6,
                station_name = $7, tags = $8, note = $9, activity_entry_id = $10,
                updated_at = $11
          WHERE id = $1 AND commander_fid = $2`,
        [
          id,
          this.discoveryFid,
          next.category,
          next.subject,
          next.systemName,
          next.bodyName,
          next.stationName,
          JSON.stringify(next.tags),
          next.note,
          next.activityEntryId,
          new Date().toISOString(),
        ],
      );
      this.screenshotList = this.screenshotList.map((r) => (r.id === id ? next : r));
      this.notify();
    } catch (err) {
      logger.warn('screenshot', 'Could not update the catalog', { error: String(err) });
    }
  };

  /**
   * Forget a screenshot without touching the image.
   *
   * §16 requires these to be two different actions, because one is reversible
   * by re-cataloguing and the other destroys a file.
   */
  readonly removeScreenshotFromCatalog = async (id: string): Promise<void> => {
    if (!this.db || this.discoveryFid === null) return;
    try {
      await this.db.execute('DELETE FROM screenshots WHERE id = $1 AND commander_fid = $2', [
        id,
        this.discoveryFid,
      ]);
      this.screenshotList = this.screenshotList.filter((r) => r.id !== id);
      this.notify();
    } catch (err) {
      logger.warn('screenshot', 'Could not remove the catalog entry', { error: String(err) });
    }
  };

  /** Delete the image as well. Only ever from an explicit confirmation. */
  readonly deleteScreenshotImage = async (id: string): Promise<void> => {
    const row = this.screenshotList.find((r) => r.id === id);
    if (!row) return;
    try {
      await invoke<void>('delete_screenshot_file', { path: row.filePath });
    } catch (err) {
      this.screenshotError = 'The image could not be deleted.';
      logger.warn('screenshot', 'File delete failed', { error: sanitisePath(String(err)) });
      this.notify();
      return;
    }
    await this.removeScreenshotFromCatalog(id);
  };

  /** Re-check the folder, for the browser's refresh. */
  readonly refreshScreenshots = async (): Promise<void> => {
    await this.loadScreenshots();
    await this.loadJournalSync();
  };

  /** Stored queue facts, with the switch positions as they are right now. */
  private liveSharingState(): Partial<Record<IntegrationId, SharingInput>> {
    const merged: Partial<Record<IntegrationId, SharingInput>> = {};
    for (const id of Object.keys(this.integrationState) as IntegrationId[]) {
      const stored = this.sharingState[id];
      merged[id] = {
        queue: stored?.queue ?? EMPTY_QUEUE,
        lastSuccessAt: stored?.lastSuccessAt ?? null,
        lastError: stored?.lastError ?? null,
        enabled: this.integrationState[id].enabled,
        hasCredential: this.integrationState[id].hasCredential,
      };
    }
    return merged;
  }

  private screenshotView(): ScreenshotView {
    return {
      hotkey: this.screenshotHotkey,
      folder: this.screenshotFolder,
      folderWritable: this.screenshotFolderOk,
      recent: this.screenshotList,
      draft: this.screenshotDraft,
      draftInMainWindow: this.draftInMainWindow,
      missing: this.missingScreenshots,
      removeMissingFromCatalog: this.removeMissingFromCatalog,
      lastError: this.screenshotError,
    };
  }

  /* -------------------------------------------------- activity journal */

  /**
   * Derived activity, kept in memory for the UI and written through to SQLite.
   *
   * Bounded: the screen shows a timeline, not an archive. The database holds
   * everything; this is the working set, so a commander with years of history
   * does not pay for it on every render.
   */
  /* --------------------------------------------------------- presentation */

  private guidanceMode: GuidanceMode = DEFAULT_GUIDANCE_MODE;
  /** Whether the commander has ever made the choice. Drives the first-run prompt. */
  private guidanceChosen = false;
  private appearance: OverlayAppearance = { ...DEFAULT_APPEARANCE };

  /**
   * Integration state.
   *
   * Every integration starts off. Nothing contacts an external service until the
   * commander switches it on, which is asserted by a test rather than left as an
   * intention.
   */
  private integrationState: Record<IntegrationId, { enabled: boolean; hasCredential: boolean }> = {
    eddn: { enabled: false, hasCredential: false },
    edsm: { enabled: false, hasCredential: false },
    inara: { enabled: false, hasCredential: false },
    'edfm-journal': { enabled: false, hasCredential: false },
  };

  /**
   * Load integration switches for the active commander.
   *
   * Per commander, because an integration is a link to *an account*: CMDR
   * Sythan's EDSM key must never receive CMDR AltOne's flight log. Until a
   * commander is known, everything reads as off -- which is also what happens
   * when the owner cannot be established, and is the safe answer.
   */
  private async loadIntegrationState(): Promise<void> {
    const fid = this.discoveryFid;
    for (const id of Object.keys(this.integrationState) as IntegrationId[]) {
      const enabled =
        fid !== null && (await this.getSetting(`integration.${id}.${fid}.enabled`)) === 'true';
      const hasCredential = await credentialPresent(id);
      this.integrationState = { ...this.integrationState, [id]: { enabled, hasCredential } };
    }
    this.notify();
    await this.loadSharingState();
  }

  /**
   * Turn an integration on or off.
   *
   * Bound so it can travel through the snapshot to a screen without that screen
   * reaching for the singleton. Refuses an integration that is not built, so a
   * UI bug cannot make one appear active.
   */
  /**
   * Store a key for an integration that needs one.
   *
   * Written straight to the Windows Credential Manager. The value is not kept
   * anywhere in this class: the authenticated request reads it in Rust, so the
   * only copy in the process is the argument, and it goes out of scope here.
   */
  readonly setIntegrationCredential = async (
    id: IntegrationId,
    secret: string,
  ): Promise<string | null> => {
    const trimmed = secret.trim();
    if (trimmed.length === 0) return 'Paste the key before saving.';
    try {
      await credentialSet(id, trimmed);
    } catch (err) {
      // The error is logged without the value, which `credentials.rs` also
      // guarantees on its side.
      logger.warn(id, 'Could not store the key', { error: String(err) });
      return 'The key could not be saved to the Windows Credential Manager.';
    }
    await this.loadIntegrationState();
    this.notify();
    return null;
  };

  readonly clearIntegrationCredential = async (id: IntegrationId): Promise<void> => {
    try {
      await credentialClear(id);
    } catch (err) {
      logger.warn(id, 'Could not clear the key', { error: String(err) });
    }
    /*
     * Switched off at the same time. An integration that needs a key and has
     * none cannot send, so leaving the switch on would show an enabled service
     * that silently does nothing.
     */
    this.integrationState = {
      ...this.integrationState,
      [id]: { enabled: false, hasCredential: false },
    };
    const fid = this.discoveryFid;
    if (fid !== null) await this.setSetting(`integration.${id}.${fid}.enabled`, 'false');
    await this.loadIntegrationState();
    this.notify();
  };

  readonly setIntegrationEnabled = async (id: IntegrationId, enabled: boolean): Promise<void> => {
    if (!INTEGRATIONS[id]?.implemented) return;
    this.integrationState = {
      ...this.integrationState,
      [id]: { ...this.integrationState[id], enabled },
    };
    this.notify();
    // Keyed by commander: the same machine may have one commander contributing
    // and another not, and neither choice may leak into the other.
    const fid = this.discoveryFid;
    if (fid !== null) {
      await this.setSetting(`integration.${id}.${fid}.enabled`, String(enabled));
    }
  };

  /**
   * Queue depth and last-transmission facts, per integration.
   *
   * Empty until read from the database. An empty map renders as "nothing has
   * ever been sent", which is the truthful default: if the state cannot be read,
   * claiming activity would be the wrong way to be wrong.
   */
  private sharingState: Partial<Record<IntegrationId, SharingInput>> = {};

  /**
   * Read what the queue and integration state actually record.
   *
   * Scoped to the active commander for the counts that describe *their* data,
   * with one deliberate exception: `unattributed` counts rows whose owner could
   * not be established. Those are never sent to anyone, and they belong on the
   * audit screen precisely because they are nobody's -- silently omitting them
   * would make "nothing queued" mean two different things.
   */
  private async loadSharingState(): Promise<void> {
    if (!this.db) return;
    const fid = this.discoveryFid;
    const next: Partial<Record<IntegrationId, SharingInput>> = {};

    for (const id of Object.keys(this.integrationState) as IntegrationId[]) {
      const switches = this.integrationState[id];
      let queue: QueueSummary = EMPTY_QUEUE;
      let lastSuccessAt: string | null = null;
      let lastError: string | null = null;

      try {
        const counts =
          fid === null
            ? []
            : await this.db.select<Array<{ status: string; n: number }>>(
                `SELECT status, COUNT(*) AS n FROM integration_queue
                  WHERE integration = $1 AND commander_fid = $2 GROUP BY status`,
                [id, fid],
              );

        const orphans = await this.db.select<Array<{ n: number }>>(
          `SELECT COUNT(*) AS n FROM integration_queue
            WHERE integration = $1 AND commander_fid IS NULL`,
          [id],
        );

        const due =
          fid === null
            ? []
            : await this.db.select<Array<{ next_attempt_at: string | null }>>(
                `SELECT MIN(next_attempt_at) AS next_attempt_at FROM integration_queue
                  WHERE integration = $1 AND commander_fid = $2 AND status = 'retryable'`,
                [id, fid],
              );

        const at = (status: string): number =>
          Number(counts.find((r) => r.status === status)?.n ?? 0);

        queue = {
          queued: at('queued'),
          attempting: at('attempting'),
          accepted: at('accepted'),
          retryable: at('retryable'),
          rejected: at('rejected'),
          unattributed: Number(orphans[0]?.n ?? 0),
          nextAttemptAt: due[0]?.next_attempt_at ?? null,
        };

        if (fid !== null) {
          const state = await this.db.select<
            Array<{ last_success_at: string | null; last_error: string | null }>
          >(
            `SELECT last_success_at, last_error FROM integration_state
              WHERE integration = $1 AND commander_fid = $2`,
            [id, fid],
          );
          lastSuccessAt = state[0]?.last_success_at ?? null;
          lastError = state[0]?.last_error ?? null;
        }
      } catch (err) {
        // A failed read must not become a claim. Leaving the defaults in place
        // reports "nothing sent" rather than inventing a state.
        logger.warn('integrations', 'Could not read sharing state', {
          integration: id,
          error: String(err),
        });
      }

      next[id] = {
        enabled: switches.enabled,
        hasCredential: switches.hasCredential,
        queue,
        lastSuccessAt,
        lastError,
      };
    }

    this.sharingState = next;
    this.notify();
  }

  /**
   * Bring forward every waiting retry for one integration.
   *
   * Clears the stored backoff so the next drain picks the rows up. It does not
   * reset the attempt count: the commander asking sooner is not a reason to
   * grant more attempts against a service that keeps refusing.
   */
  readonly retrySharingNow = async (id: IntegrationId): Promise<void> => {
    if (!this.db || this.discoveryFid === null) return;
    if (!INTEGRATIONS[id]?.implemented) return;
    try {
      await this.db.execute(
        `UPDATE integration_queue
            SET status = 'queued', next_attempt_at = NULL, updated_at = $3
          WHERE integration = $1 AND commander_fid = $2 AND status = 'retryable'`,
        [id, this.discoveryFid, new Date().toISOString()],
      );
    } catch (err) {
      logger.warn('integrations', 'Retry request failed', { integration: id, error: String(err) });
    }
    await this.loadSharingState();
  };

  /**
   * Discard permanently-rejected items.
   *
   * Only `rejected` rows, and only this commander's: those will never be sent
   * however long they are kept, so removing them is the one queue deletion that
   * loses nothing. Anything still retryable is left alone.
   */
  readonly clearSharingRejected = async (id: IntegrationId): Promise<void> => {
    if (!this.db || this.discoveryFid === null) return;
    try {
      await this.db.execute(
        `DELETE FROM integration_queue
          WHERE integration = $1 AND commander_fid = $2 AND status = 'rejected'`,
        [id, this.discoveryFid],
      );
    } catch (err) {
      logger.warn('integrations', 'Clearing rejected items failed', {
        integration: id,
        error: String(err),
      });
    }
    await this.loadSharingState();
  };

  private readonly activity = new ActivityEngine({ commanderFid: null });
  /**
   * What the commander is doing right now, as opposed to what they have done.
   *
   * Transient and never persisted: it is rebuilt from live events, and storing it
   * would turn "in progress" into a claim that outlived the session it described.
   */
  private readonly liveActivity = new LiveActivityTracker({ commanderFid: null });
  private activityEntries: ActivityEntry[] = [];
  private static readonly ACTIVITY_IN_MEMORY = 500;

  private overlayEnabled = false;
  /** Mirrors the overlay's own `hide_when_inactive`, so it can be restored with it. */
  private overlayHideInactive = true;
  /**
   * Starts on the bundled rule set so context works offline and on first run
   * (§22). A server-supplied set supersedes it via `setContextRules`.
   */
  private readonly resolver = new ContextResolver(BUNDLED_RULES, { maxActive: 3 });
  private readonly missions = new MissionStore();
  /** Set when mission state changed and has not yet been written to disk. */
  private missionsDirty = false;

  /**
   * What this commander's own game has revealed. The sole basis for spoiler
   * gating — EDFM's data is deliberately not an input.
   */
  private discovery = new DiscoveryState(null);
  private discoveryDirty = false;
  /** FID the current discovery state belongs to, for switch detection. */
  private discoveryFid: string | null = null;

  /**
   * Off until the commander turns it on.
   *
   * §21: nothing is uploaded by default. A reference lookup is keyed by
   * MarketID, so making one tells the server which station this commander is
   * docked at. That is a location disclosure and needs consent, even though
   * nothing is being submitted yet.
   */
  private verificationEnabled = false;

  /**
   * Reference data for comparison.
   *
   * Verification-only. It may describe places this commander has never been,
   * so nothing here may reach the UI: it goes to the engine and nowhere else.
   * See docs/SPOILERS.md.
   */
  private readonly reference: ReferenceClient = createReferenceClient({
    baseUrl: API_BASE_URL,
    // Native HTTP, not the WebView's. See lib/http.ts for why.
    fetchImpl: httpFetch,
    isEnabled: () => this.verificationEnabled,
    // A lookup during ingest can only miss, because it cannot wait for the
    // network. When the data lands, the event that missed is compared again --
    // otherwise the first visit to every station would silently never be
    // verified.
    onArrived: (entityType, entityId) => this.recheck(entityType, entityId),
    log: (message, detail) => logger.info('reference', message, detail ?? {}),
  });

  /**
   * The most recent event per entity, held so `onArrived` has something to
   * re-compare. One entry per entity, not a queue: only the newest observation
   * of a station is worth re-checking, and an unbounded backlog of journal
   * events is a leak.
   */
  private readonly pendingRecheck = new Map<string, NormalizedEvent>();

  private readonly verification = new VerificationEngine({
    onNotify: (n) =>
      logger.info('verification', `discrepancy ${n.reason}`, {
        // Never the values: this log can be attached to a bug report, and a
        // discrepancy may describe something the commander has not discovered.
        entityType: n.discrepancy.entityType,
        field: n.discrepancy.field,
        confirmations: n.discrepancy.independentConfirmations,
      }),
  });
  private verificationDirty = false;

  /**
   * Field research (§12).
   *
   * Runs unconditionally and entirely locally: recording an observed session is
   * not a contribution, and nothing is uploaded. Whether to submit is a
   * separate, later decision -- which is why `submitted_at` is its own column.
   */
  private readonly research = new SessionTracker({
    project: SETTLEMENT_MATERIALS,
    companionVersion: COMPANION_VERSION,
    onSessionClosed: (session) => {
      this.researchDirty = true;
      logger.info('research', 'Observed session recorded', {
        project: session.projectId,
        // Never the settlement or what was found: this log can be attached to
        // a bug report.
        outcome: session.outcome,
        observations: session.observations.length,
        durationSeconds: session.durationSeconds,
      });
      this.notify();
    },
  });
  private researchDirty = false;

  /** S20: anonymous unless the commander chooses to be credited. */
  private identityMode: IdentityMode = 'anonymous';

  private readonly submitter: Submitter = createSubmitter({
    baseUrl: API_BASE_URL,
    fetchImpl: httpFetch,
    // Consulted per call, so revoking consent stops submission immediately
    // rather than at the next restart.
    isEnabled: () => this.verificationEnabled,
    identityMode: () => this.identityMode,
    clientVersion: COMPANION_VERSION,
    log: (message, detail) => logger.info('submit', message, detail ?? {}),
  });
  /** Guards against two flushes overlapping on a slow network. */
  private flushingQueue = false;

  private pluginView: PluginView = {
    loaded: [],
    rejected: [],
    directory: null,
    contributedRules: 0,
    source: 'none',
    fallbackReason: null,
    unreadable: [],
    disabledIds: [],
  };

  /** Persisted across restarts; read before the first load. */
  private disabledPlugins = new Set<string>();

  /** Construction sites, keyed by depot MarketID. */
  private sites = new Map<string, ConstructionSite>();
  private sitesDirty = false;
  private plan: SourcingPlan | null = null;
  private planningState: 'idle' | 'searching' | 'error' = 'idle';
  private planError: string | null = null;
  private candidatesConsidered = 0;
  private plannedAt: string | null = null;
  private contributions: ContributionView = {
    enabled: false,
    identityMode: 'anonymous',
    submitted: 0,
    pending: 0,
    failed: 0,
    findingsFromSubmissions: 0,
    discrepanciesDetected: 0,
    researchSessions: 0,
    lastContributionAt: null,
  };
  private widgets: OverlayWidgets = { ...DEFAULT_WIDGETS };
  private cachedSnapshot: CompanionSnapshot | null = null;
  private db: Database | null = null;
  private engine: JournalEngine | null = null;
  private state: CommanderState = initialState();
  private connection: ConnectionState = 'starting';
  private directory: string | null = null;
  private directoryDetail = '';
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();
  /** Coalesces renders: the UI does not need one per journal line. */
  private notifyScheduled = false;
  private dirtyCheckpoint: JournalCheckpoint | null = null;

  constructor() {
    // One provider today. Adding body or settlement verification later is a
    // register() call, not a change to the engine.
    this.verification.register(
      createStationProvider({
        companionVersion: COMPANION_VERSION,
        // Left off while EDFM has no station coverage: a sparse reference would
        // make every real service look like a finding.
        reportExtras: false,
      }),
    );
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Current snapshot.
   *
   * MUST return a referentially stable value between changes. React's
   * `useSyncExternalStore` compares snapshots by identity: returning a fresh
   * object on every call makes it believe the store changed during render, and
   * it throws rather than looping forever. The cache is invalidated in `notify`.
   */
  snapshot(): CompanionSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = {
        state: { ...this.state },
        stats: this.engine?.stats ?? EMPTY_STATS,
        connection: this.connection,
        directory: this.directory,
        directoryDetail: this.directoryDetail,
        activeFile: this.engine?.currentFile ?? null,
        lastError: this.lastError,
        contexts: this.projectedContexts(),
        carrierJumps: this.projectCarrierJumps(),
        activity: groupActivity(this.activityEntries),
        guidance: this.guidanceMode,
        guidanceChosen: this.guidanceChosen,
        appearance: this.appearance,
        integrations: this.integrationState,
        setIntegrationEnabled: this.setIntegrationEnabled,
        setIntegrationCredential: this.setIntegrationCredential,
        clearIntegrationCredential: this.clearIntegrationCredential,
        sharing: sharingAudit({
          descriptors: integrationsList(),
          /*
           * Switch positions come from the live state, not the cached row.
           *
           * `sharingState` is a database read, refreshed on its own schedule.
           * Toggling an integration updated the switch in memory but left the
           * row stale, so the checkbox snapped straight back — it was bound to
           * the row. Merging here fixes every such path at once rather than
           * adding a reload to one of them.
           */
          state: this.liveSharingState(),
          commanderName: isKnown(this.state.commander) ? this.state.commander : null,
          commanderFid: this.discoveryFid,
        }),
        diagnostics: {
          appVersion: COMPANION_VERSION,
          gameVersion: isKnown(this.state.gameVersion) ? this.state.gameVersion : null,
          anomalies: this.anomalyLedger.anomalies(),
          eventsTracked: this.anomalyLedger.eventsTracked,
          fieldsTracked: this.anomalyLedger.fieldsTracked,
          truncated: this.anomalyLedger.truncatedCount,
        },
        retrySharingNow: this.retrySharingNow,
        clearSharingRejected: this.clearSharingRejected,
        contextRuleVersion: this.resolver.version,
        contextRuleSource: this.resolver.source,
        missions: this.missionView(),
        verification: this.verification.stats(),
        verificationEnabled: this.verificationEnabled,
        research: this.researchView(),
        plugins: this.pluginView,
        screenshots: this.screenshotView(),
        journalSync: this.journalSyncView(),
        connectJournalSync: this.connectJournalSync,
        disconnectJournalSync: this.disconnectJournalSync,
        syncJournalNow: this.syncJournalNow,
        journalBackfillPreview: this.journalBackfillPreview,
        backfillJournalSync: this.backfillJournalSync,
        cancelJournalBackfill: this.cancelJournalBackfill,
        rebuildActivityHistory: this.rebuildActivityHistory,
        cancelActivityRebuild: this.cancelActivityRebuild,
        captureScreenshot: this.captureScreenshot,
        saveScreenshot: this.saveScreenshot,
        discardScreenshotDraft: this.discardScreenshotDraft,
        setScreenshotHotkey: this.setScreenshotHotkey,
        setScreenshotFolder: this.setScreenshotFolder,
        updateScreenshot: this.updateScreenshot,
        removeScreenshotFromCatalog: this.removeScreenshotFromCatalog,
        refreshScreenshots: this.refreshScreenshots,
        deleteScreenshotImage: this.deleteScreenshotImage,
        logistics: {
          sites: [...this.sites.values()].sort(
            (a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
          ),
          requirements: combinedRequirements([...this.sites.values()]),
          plan: this.plan,
          planningState: this.planningState,
          planError: this.planError,
          candidatesConsidered: this.candidatesConsidered,
          plannedAt: this.plannedAt,
        },
        contributions: {
          ...this.contributions,
          enabled: this.verificationEnabled,
          identityMode: this.identityMode,
          researchSessions: this.research.sessions().length,
        },
      };
    }
    return this.cachedSnapshot;
  }

  /**
   * Active contexts with their resources filtered to what this commander may see.
   *
   * The resolver matched these rules against everything it knows; this is where
   * anything naming an undiscovered species or body is removed. Nothing else in
   * the app is permitted to read `resolver.current()` directly — that is the
   * point of doing it here rather than in each component.
   */
  private projectedContexts(): readonly ActiveContext[] {
    const policy = policyFor(this.discovery);
    return this.resolver.current().map((ctx) => ({
      ...ctx,
      rule: {
        ...ctx.rule,
        resources: projectResources(ctx.rule.resources, this.state, policy),
      },
    }));
  }

  private notify(): void {
    // Invalidate immediately: a listener may read the snapshot before the
    // scheduled flush runs, and must not be handed a stale one.
    this.cachedSnapshot = null;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.cachedSnapshot = null;
      for (const fn of this.listeners) fn();
    });
  }

  /**
   * Start ingest.
   *
   * Never rejects. Startup touches the native layer, the database and the disk,
   * and an escaping rejection here is the worst-behaved failure this app has:
   * `connection` stays on `'starting'`, so the window sits on "Starting"
   * indefinitely with nothing to click and nothing in the UI saying why. An
   * error state is recoverable — the commander can read it, set a path, and
   * restart — so every unexpected throw is turned into one.
   *
   * The individual `try`/`catch` blocks inside `bootstrap` are still worth
   * having: each one lets startup *continue* past a failure that is survivable.
   * This is the backstop for the ones nobody predicted.
   */
  async start(): Promise<void> {
    // Idempotent: React StrictMode intentionally mounts effects twice in
    // development, and starting two engines against one journal would double
    // every event.
    if (this.started) return;
    this.started = true;

    try {
      await this.bootstrap();
    } catch (err) {
      this.connection = 'error';
      this.lastError = `Startup failed: ${String(err)}`;
      logger.error('app', 'Startup failed', { error: String(err) });
      this.notify();
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      this.db = await Database.load('sqlite:edfm-companion.db');
      logger.info('db', 'Local database ready');
    } catch (err) {
      this.lastError = `Database unavailable: ${String(err)}`;
      logger.error('db', 'Failed to open local database', { error: String(err) });
    }

    // Opt-in, and read before ingest starts so no lookup can happen first.
    this.verificationEnabled = (await this.getSetting('verificationEnabled')) === 'true';

    const storedMode = await this.getSetting('identityMode');
    this.identityMode = storedMode === 'commander' ? 'commander' : 'anonymous';

    // Loaded before ingest starts, so a restart continues the record rather
    // than beginning a second one.
    // Before the plugins are read, so a disabled plugin never contributes
    // even briefly.
    const storedDisabled = await this.getSetting('disabledPlugins');
    if (storedDisabled !== null) {
      try {
        const ids = JSON.parse(storedDisabled) as unknown;
        if (Array.isArray(ids)) {
          this.disabledPlugins = new Set(ids.filter((v): v is string => typeof v === 'string'));
        }
      } catch {
        // A corrupt setting must not stop the app; every plugin simply stays on.
      }
    }

    // Before ingest, so a contributed rule is live for the first event.
    await this.loadPluginsFromDisk();

    await this.loadResearch();
    await this.loadSites();
    await this.refreshContributions();

    // Read here with the other overlay settings; actually starting it happens at
    // the end of start(), once there is state worth pushing to it.
    /*
     * Guidance mode, and whether it was ever chosen.
     *
     * An existing installation must not be dropped into a first-run prompt for a
     * setting that did not exist when they installed. So an unset mode is only
     * treated as "never asked" when the settings table is otherwise empty --
     * anything already stored means this is an upgrade, which silently takes the
     * Standard default.
     */
    const storedGuidance = await this.getSetting('guidanceMode');
    if (storedGuidance === 'standard' || storedGuidance === 'new-cmdr') {
      this.guidanceMode = storedGuidance;
      this.guidanceChosen = true;
    } else {
      this.guidanceMode = DEFAULT_GUIDANCE_MODE;
      this.guidanceChosen = await this.hasAnySetting();
    }

    this.appearance = {
      backgroundOpacity: clampOpacity(
        await this.getSetting('overlayBackgroundOpacity'),
        DEFAULT_APPEARANCE.backgroundOpacity,
        APPEARANCE_BOUNDS.background,
      ),
      textOpacity: clampOpacity(
        await this.getSetting('overlayTextOpacity'),
        DEFAULT_APPEARANCE.textOpacity,
        APPEARANCE_BOUNDS.text,
      ),
    };

    await this.loadIntegrationState();
    await this.loadScreenshotSettings();
    await this.loadScreenshots();

    this.overlayEnabled = (await this.getSetting('overlayEnabled')) === 'true';
    // Defaults to true when never set, matching the checkbox's default.
    this.overlayHideInactive = (await this.getSetting('overlayHideInactive')) !== 'false';

    const storedWidgets = await this.getSetting('overlayWidgets');
    if (storedWidgets) {
      try {
        // Merged over the defaults so a setting saved by an older build, before a
        // widget existed, does not leave that widget permanently undefined.
        this.widgets = { ...DEFAULT_WIDGETS, ...(JSON.parse(storedWidgets) as OverlayWidgets) };
      } catch {
        this.widgets = { ...DEFAULT_WIDGETS };
      }
    }

    const override = await this.getSetting('journalDirectory');
    const saved = await savedGamesDir();
    const resolution = await resolveJournalDirectory({
      manualOverride: override ?? undefined,
      savedGamesPath: saved ?? undefined,
      fs: tauriFs,
    });

    this.directory = resolution.directory;
    this.directoryDetail = resolution.detail;
    logger.info('journal', 'Directory resolution', {
      strategy: resolution.strategy,
      found: resolution.directory !== null,
    });

    if (!resolution.directory) {
      /*
       * A probe that never answered is an error, not an absence. The badge for
       * `no-directory` reads "No journal folder", which is a claim about the
       * machine that this run did not establish -- and it points the commander
       * at the folder setting, which is the wrong place when the check itself
       * is what failed. The resolver keeps those two cases apart; throwing that
       * away one layer up would waste the distinction.
       */
      this.connection = resolution.strategy === 'probe-failed' ? 'error' : 'no-directory';
      if (resolution.strategy === 'probe-failed') this.lastError = resolution.detail;
      this.notify();
      return;
    }

    // Load before ingest starts, so a carrier we are already docked at resolves
    // on the first Location/Docked event rather than after it.
    const rememberedCarriers = await this.loadKnownCarriers();
    const rememberedTraders = await this.loadKnownTraders();
    await this.loadMissions();

    const checkpoint = await this.loadCheckpoint();
    this.engine = new JournalEngine({
      directory: resolution.directory,
      checkpoint,
      fs: tauriFs,
      watchDirectory: watchJournalDirectory,
      safetyPollMs: 2000,
      onEvent: (e) => this.onEvent(e),
      onFailure: (f) =>
        // Excerpt only, never the whole line: §21.
        logger.warn('journal', `Unusable line (${f.reason})`, {
          file: f.sourceFile,
          offset: f.byteOffset,
        }),
      onCheckpoint: (c) => {
        this.dirtyCheckpoint = c;
      },
      onRotate: (from, to) => logger.info('journal', 'Rotated journal', { from, to }),
    });

    try {
      await this.engine.start();
      // Queued observations go out on their own schedule, never on the ingest
      // path.
      this.startEddnDrain();
      this.startEdsmDrain();
      this.connection = 'watching';
      logger.info('journal', 'Watching', { file: this.engine.currentFile });
    } catch (err) {
      this.connection = 'error';
      this.lastError = String(err);
      logger.error('journal', 'Engine failed to start', { error: String(err) });
    }

    // Checkpoints are written on a timer rather than per event: at 45k events per
    // session a write per event would be pointless disk churn.
    setInterval(() => {
      void this.flushCheckpoint();
      if (this.missionsDirty) {
        this.missionsDirty = false;
        void this.saveMissions();
      }
      if (this.discoveryDirty) {
        this.discoveryDirty = false;
        void this.saveDiscovery();
      }
      if (this.verificationDirty) {
        this.verificationDirty = false;
        void this.saveVerificationQueue();
      }
      if (this.researchDirty) {
        this.researchDirty = false;
        void this.saveResearch();
      }
      if (this.sitesDirty) {
        this.sitesDirty = false;
        void this.saveSites();
      }
      // Never awaited: an unreachable server must not become journal latency.
      void this.flushObservations();
    }, 3000);
    this.notify();

    // Deliberately not awaited: this reads historical journals and must never
    // delay live ingest. Only runs when nothing is remembered yet.
    if (rememberedCarriers === 0) {
      void this.backfillCarrierIdentities(resolution.directory);
    }
    if (rememberedTraders === 0) {
      void this.backfillTraderIdentities(resolution.directory);
    }
    // Always, not just on first run: the commander may have scanned in a session
    // the app was not watching, and the count is derived rather than stored.
    void this.backfillExobiologyHoldings(resolution.directory);

    // A jump can be scheduled a quarter of an hour ahead and requested from
    // anywhere -- 52% of them were made away from the carrier -- so one may well
    // have been booked in a session this app never saw.
    void this.backfillCarrierJumps(resolution.directory);

    // Bring the overlay back if it was on when the app last closed. Last, so the
    // first frame it receives describes where the commander actually is rather
    // than an empty state that would flash Unknown across every field.
    if (this.overlayEnabled) void this.restoreOverlay();
  }

  /**
   * Re-open the overlay after a restart.
   *
   * Failure is logged and the flag cleared rather than thrown: the overlay is a
   * convenience, and a commander whose display setup has changed since last launch
   * must still get a working app.
   */
  private async restoreOverlay(): Promise<void> {
    try {
      await overlayApi.start(this.overlayHideInactive);
      this.pushOverlayState();
      logger.info('overlay', 'Restored overlay from the previous session', {
        hideWhenInactive: this.overlayHideInactive,
      });
    } catch (err) {
      this.overlayEnabled = false;
      logger.warn('overlay', 'Could not restore the overlay', { error: String(err) });
      this.notify();
    }
  }

  stop(): void {
    this.engine?.stop();
    this.connection = 'stopped';
    // An open session whose end was never observed is recorded as interrupted
    // rather than silently closed: "the app shut down" is different evidence
    // from "the commander left", and §13 wants incomplete sessions counted.
    this.research.finish();
    void this.saveResearch();
    void this.flushCheckpoint();
    this.notify();
  }

  /**
   * Structural anomalies seen this session.
   *
   * Machine-local and session-scoped rather than per commander: a field changing
   * type is a fact about the *game build*, not about whose save it is, and
   * attributing it to a commander would imply their data caused it. Not
   * persisted -- it rebuilds from the journal on every launch, and a stored
   * baseline would carry an old build's shapes forward as if they were current.
   */
  private readonly anomalyLedger = new AnomalyLedger();

  private onEvent(event: NormalizedEvent): void {
    applyEvent(this.state, event);

    // Before anything interprets the event: record whether its shape is what it
    // has been. Types only, never values -- see packages/elite-journal/src/anomalies.ts.
    this.anomalyLedger.observe(event.source.event, event.source.raw, {
      gameVersion: event.source.provenance.gameVersion,
      timestamp: event.source.provenance.timestamp,
    });

    // A commander switch must not inherit the previous commander's discoveries.
    // Checked before anything is recorded against the new state.
    const fid = isKnown(this.state.fid) ? this.state.fid : null;
    if (fid !== null && fid !== this.discoveryFid) {
      void this.swapDiscoveryCommander(fid);
    }

    if (this.discovery.observe(event)) {
      this.discoveryDirty = true;
      // A new discovery can un-hide context resources, so the UI must re-project.
      this.notify();
    }

    // Verification runs regardless of what the commander can see: verify
    // aggressively, reveal conservatively.
    if (this.verification.observe(event, this.reference).length > 0) {
      this.verificationDirty = true;
    }
    this.rememberForRecheck(event);
    void this.queueObservation(event);

    // Research is local-only and runs regardless of contribution settings:
    // recording what happened is not the same as offering it to anyone.
    this.research.observe(event, this.state);

    if (event.kind === 'colonisation-depot') this.observeConstructionDepot(event);

    if (this.missions.observe(event)) {
      this.missionsDirty = true;
      this.notify();
    }

    // Carrier identities are stable reference data: learn once, remember forever.
    if (event.kind === 'carrier-identity') void this.saveCarrierIdentity(event);
    // Likewise the kind of Material Trader a station has, which is only ever
    // revealed by trading there.
    if (event.kind === 'trader-identity') void this.saveTraderIdentity(event);

    // The field journal. Most events produce nothing, so this is a cheap call on
    // the high-frequency path and only notifies when something was actually
    // recorded -- a render per journal line would be unusable during a scan run.
    const activity = this.activity.observe(event);
    if (activity.length > 0) {
      this.activityEntries = [...activity, ...this.activityEntries].slice(
        0,
        Companion.ACTIVITY_IN_MEMORY,
      );
      void this.saveActivity(activity);
      // Offered to EDFM if Phase 1 covers them. Never awaited: syncing a record
      // of the game must not gate reading it.
      void this.enqueueJournalEntries(activity);
      this.notify();
    }

    /*
     * Live progress, which is a different question from the entry above: "what am
     * I in the middle of" rather than "what did I just finish".
     *
     * Ordered after the engine so the body-name map already contains anything
     * this event taught it -- a `Touchdown` naming the body the commander is
     * about to sample on arrives before the first `ScanOrganic`.
     */
    let liveChanged = this.liveActivity.observe(event, this.activity.bodyNameMap);
    // A body may be named by a later event than the scan that referenced it.
    if (this.liveActivity.resolveBodyName(this.activity.bodyNameMap)) liveChanged = true;

    // Arriving somewhere asks for that body's stored rows; changes ask to be
    // written back. Both are async and neither gates ingest.
    // A commander already on a planet when the app started gets no
    // `ApproachBody`; their location is known from state instead.
    this.enterCurrentBody();

    const hydrate = this.liveActivity.takeHydrationRequest();
    if (hydrate !== null) void this.hydrateBodyRoster(hydrate);

    const dirty = this.liveActivity.takeDirtyRows();
    if (dirty.length > 0) void this.saveExobiologyRows(this.liveActivity.currentBody, dirty);

    // Genus lists for bodies scanned from orbit. Written now so that landing on
    // one later is a read rather than a rescan.
    for (const pending of this.liveActivity.takePendingRosters()) {
      void this.saveExobiologyRows(pending.body, pending.rows);
    }

    if (liveChanged) {
      this.liveActivity.setSystem(
        isKnown(this.state.starSystem) ? this.state.starSystem : null,
        isKnown(this.state.systemAddress) ? this.state.systemAddress : null,
      );
      this.notify();
    }

    // Offered to EDDN. Returns immediately for all but seven event names, and
    // queues rather than sends, so the network is never on the ingest path.
    // Draining happens on its own timer; see `startEddnDrain`.
    this.observeForEddn(event);
    this.observeForEdsm(event);
    this.observeForInara(event);

    // Context resolution runs on every event, including the high-frequency ones:
    // a rule may legitimately key on them, and evaluating a dozen declarative
    // conditions is far cheaper than a React render.
    const contextChanged = this.resolver.observe(event, this.state);

    if (contextChanged || !HIGH_FREQUENCY_NOISE.has(event.source.event)) {
      logger.trace('journal', event.source.event, { id: event.source.provenance.eventId });
      this.notify();
      if (this.overlayEnabled) this.pushOverlayState();
    }
  }

  /* -------------------------------------------------------- carrier jumps */

  /**
   * Scheduled jumps for the commander's own carriers, soonest first.
   *
   * A record is dropped once its departure is more than an hour past. Completion
   * normally arrives as a `CarrierLocation` at the destination, but a commander who
   * was offline when the carrier jumped may not see one for a long time, and a
   * countdown that has been "departing" since yesterday is noise rather than
   * information.
   */
  /**
   * Scheduled jumps for the commander's own carriers, soonest first.
   *
   * Private, and surfaced through `snapshot()` rather than as its own getter.
   * That is not a style preference: `useSyncExternalStore` compares snapshots by
   * identity, and this rebuilds its array every call. Exposed directly it was read
   * as a state change on every render and React aborted with "Maximum update depth
   * exceeded" -- on an empty list too, because even `[]` was a fresh reference, so
   * the app failed to start at all. `snapshot()` is already cached and invalidated
   * in `notify`, so going through it makes the identity correct by construction
   * instead of relying on a second cache staying right.
   *
   * A record is dropped once its departure is more than an hour past. Completion
   * normally arrives as a `CarrierLocation` at the destination, but a commander who
   * was offline when the carrier jumped may not see one for a long time, and a
   * countdown that has read "departing" since yesterday is noise.
   */
  private projectCarrierJumps(): OverlayCarrierJump[] {
    /*
     * How long an unconfirmed departure may keep saying "Departing".
     *
     * Was an hour, which was far too generous and is what left a jump showing
     * long after it had arrived. Measured across 138 real requests: 93% are
     * confirmed within five minutes of the stated departure, median zero. Past
     * that the commander is almost certainly offline, and confirmation may not
     * arrive for hours -- so continuing to assert a departure tells them nothing
     * true, and quietly stopping is the honest end.
     */
    const STALE_AFTER_MS = 10 * 60 * 1000;
    const now = Date.now();

    return Object.values(this.state.carrierJumps)
      .filter((j) => {
        const departs = Date.parse(j.departureTime);
        return !Number.isFinite(departs) || now - departs < STALE_AFTER_MS;
      })
      .sort((a, b) => Date.parse(a.departureTime) - Date.parse(b.departureTime))
      .map((j) => ({
        carrierId: j.carrierId,
        // knownCarriers is populated only from CarrierStats / CarrierNameChange /
        // CarrierBuy, all of which the game writes solely for carriers the
        // commander commands -- so a name here is itself the ownership proof.
        name: this.state.knownCarriers[j.carrierId] ?? `Carrier ${j.carrierId}`,
        system: j.system,
        body: isKnown(j.body) ? j.body : null,
        departureTime: j.departureTime,
      }));
  }

  /* --------------------------------------------------------------- overlay */

  /** Whether the overlay is currently on. Restored across restarts. */
  get overlayOn(): boolean {
    return this.overlayEnabled;
  }

  get overlayHideWhenInactive(): boolean {
    return this.overlayHideInactive;
  }

  /**
   * Turn the overlay on or off, and remember the choice.
   *
   * Persisted because the overlay is not a transient view: someone who plays with
   * it on wants it on, and having to re-enable it after every launch made it feel
   * like a setting that did not stick.
   */
  setOverlayEnabled(enabled: boolean, hideWhenInactive?: boolean): void {
    this.overlayEnabled = enabled;
    if (hideWhenInactive !== undefined) this.overlayHideInactive = hideWhenInactive;
    if (enabled) this.pushOverlayState();
    this.notify();

    // Not awaited: a settings write must never make a toggle feel sluggish.
    void this.setSetting('overlayEnabled', String(enabled));
    void this.setSetting('overlayHideInactive', String(this.overlayHideInactive));
  }

  /**
   * Send the overlay a flattened view of current state.
   *
   * Only the handful of fields the widget renders — not the whole state object —
   * so the overlay never holds commander data it has no use for.
   */
  pushOverlayState(): void {
    const s = this.state;
    const text = (v: Known<string>): string | null => (isKnown(v) ? v : null);
    // The whole ranked set, not just the winner. One context alone meant a fact
    // that was true right now could be completely hidden by an activity that had
    // merely happened recently -- docked at a Material Trader while the overlay
    // read "Engineering", from another system.
    const [top = null, ...alsoActive] = this.resolver.current();

    void overlayApi
      .pushState({
        commander: text(s.commander),
        starSystem: text(s.starSystem),
        // Carrier name and callsign go on one line: two rows for one place wasted
        // scarce overlay space and read as two separate things.
        //
        // When not docked, this row shows what the commander is *doing* instead of
        // "Unknown". There is no station, and saying so as though it were missing
        // data misrepresents a perfectly known situation.
        station: isKnown(s.stationName)
          ? isKnown(s.carrierName)
            ? `${s.carrierName} (${s.stationName})`
            : s.stationName
          : travelLabel(s.travel),
        // Body is omitted when it merely repeats the station. BodyType "Station"
        // means the journal reported Body='Elder Hub' next to
        // StationName='Elder Hub'; a carrier is Planet or Star, so its body is
        // genuinely different information and stays.
        body: isKnown(s.bodyType) && s.bodyType === 'Station' ? null : text(s.body),
        docking: s.docking === 'unknown' ? null : s.docking,
        vehicle: s.vehicle === 'unknown' ? null : s.vehicle,
        // Destination and route progress, shown only while actually travelling.
        jumpTarget: isKnown(s.jumpTarget) ? s.jumpTarget : null,
        remainingJumps: isKnown(s.remainingJumps) ? s.remainingJumps : null,
        // The highest-ranked context is rendered in full. The rest are titles only,
        // so the commander still learns what else is true here without being handed
        // a wall of links mid-flight, which §6 is explicit about.
        missions: this.overlayMissions(),
        widgets: this.widgets,
        alsoActive: alsoActive.map((c) => ({
          title: c.title,
          subtitle: c.subtitle,
        })),
        carrierJumps: this.projectCarrierJumps(),
        appearance: this.appearance,
        guidance: this.guidanceMode,
        liveJournal: this.projectLiveJournal(),
        liveActivity: this.projectLiveActivity(),
        context: top
          ? {
              title: top.title,
              subtitle: top.subtitle,
              actions: top.rule.actions ?? [],
              note: top.rule.note ?? null,
              // Sent always; the overlay decides whether to draw it based on the
              // mode, so changing the mode does not need a fresh journal event.
              guidance: top.rule.guidance?.beginner ?? null,
              resources: top.rule.resources
                .map((r) => ({ label: r.label, url: resourceUrl(r) }))
                .filter((r): r is { label: string; url: string } => r.url !== null)
                .slice(0, 3),
            }
          : null,
      })
      .catch(() => undefined); // overlay may not be open; not an error
  }

  /** Widgets the overlay should draw. Persisted, and pushed on every update. */
  get overlayWidgets(): OverlayWidgets {
    return this.widgets;
  }

  /**
   * Record the commander's guidance choice.
   *
   * Writing it is what dismisses the first-run prompt, so choosing Standard --
   * the default -- still counts as choosing.
   */
  async setGuidanceMode(mode: GuidanceMode): Promise<void> {
    this.guidanceMode = mode;
    this.guidanceChosen = true;
    this.notify();
    this.pushOverlayState();
    await this.setSetting('guidanceMode', mode);
  }

  /**
   * Overlay appearance.
   *
   * Pushed before it is persisted, so the slider moves the real overlay as it is
   * dragged rather than after a database round trip.
   */
  async setAppearance(appearance: OverlayAppearance): Promise<void> {
    this.appearance = {
      backgroundOpacity: clampNumber(appearance.backgroundOpacity, APPEARANCE_BOUNDS.background),
      textOpacity: clampNumber(appearance.textOpacity, APPEARANCE_BOUNDS.text),
    };
    this.notify();
    this.pushOverlayState();
    await this.setSetting('overlayBackgroundOpacity', String(this.appearance.backgroundOpacity));
    await this.setSetting('overlayTextOpacity', String(this.appearance.textOpacity));
  }

  /** Whether anything has ever been written to settings. See the guidance load. */
  private async hasAnySetting(): Promise<boolean> {
    if (!this.db) return false;
    try {
      const rows = await this.db.select<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM settings',
      );
      return (rows[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async setOverlayWidgets(widgets: OverlayWidgets): Promise<void> {
    this.widgets = widgets;
    await this.setSetting('overlayWidgets', JSON.stringify(widgets));
    this.pushOverlayState();
    this.notify();
  }

  /**
   * Mission data shaped for the overlay.
   *
   * Two constraints drive the shape. Expiry is pre-formatted here because the
   * overlay is a passive view with no clock of its own, and the row list is
   * capped because an overlay listing forty missions is unreadable in flight —
   * the main window is where the full list belongs.
   */
  private overlayMissions(): OverlayMissions {
    const { groups, withoutDestination } = this.missions.byDestination();
    const summary = this.missions.summary();
    const top = groups[0] ?? null;

    const rows: OverlayMissionRow[] = this.missions
      .byExpiry()
      .slice(0, OVERLAY_MISSION_ROWS)
      .map((m) => ({
        id: m.missionId,
        name: isKnown(m.localisedName) ? m.localisedName : m.name,
        destination: isKnown(m.destinationSystem)
          ? isKnown(m.destinationStation)
            ? `${m.destinationSystem} · ${m.destinationStation}`
            : m.destinationSystem
          : null,
        expiry: isKnown(m.expiry) ? relativeExpiry(m.expiry) : null,
        cargo: cargoLabel(m),
        awaitingTurnIn: isAwaitingTurnIn(m),
        note: this.widgets.edfmNotes ? explainMission(m) : null,
      }));

    return {
      active: summary.active,
      cargo: summary.totalCargo,
      expiringSoon: summary.expiringSoon,
      withoutDestination: withoutDestination.length,
      nextStop: top
        ? {
            system: top.system,
            station: top.station,
            missions: top.missionCount,
            cargo: top.cargoRequired,
            cargoIncomplete: top.cargoIncomplete,
            kills: top.killsRequired,
            expiry: top.earliestExpiry ? relativeExpiry(top.earliestExpiry) : null,
          }
        : null,
      rows,
      more: Math.max(0, summary.active - rows.length),
    };
  }

  /**
   * Replace the context rules, e.g. from the backend once one exists.
   *
   * Kept here rather than inside the resolver so the fetch, caching and version
   * policy stay in application code where they can be logged and surfaced.
   */
  setContextRules(ruleSet: Parameters<ContextResolver['setRuleSet']>[0]): void {
    // Plugin rules are merged back in, because this replaces the whole set.
    // Without it a server rule update would silently delete every installed
    // plugin's contributions -- they would work until the first update and
    // then vanish, which is precisely the kind of failure a commander cannot
    // diagnose.
    const merged = mergeContextRules(
      ruleSet,
      this.pluginView.loaded.filter((p) => !this.disabledPlugins.has(p.manifest.id)),
    );
    this.resolver.setRuleSet(merged);
    logger.info('context', 'Rule set replaced', {
      version: this.resolver.version,
      source: this.resolver.source,
      pluginRules: merged.rules.length - ruleSet.rules.length,
    });
    this.notify();
  }

  /* ------------------------------------------------------- verification */

  /**
   * Persist pending discrepancies locally.
   *
   * Queued rather than submitted immediately: §22 requires an offline session to
   * lose nothing, and §14/§21 make submission an opt-in act separate from
   * detection. Nothing leaves the machine until a backend exists and the
   * commander has enabled contribution.
   *
   * The visibility gate is stored alongside so redaction is decided by the
   * record, not by whichever code path later renders or notifies.
   */
  private async saveVerificationQueue(): Promise<void> {
    if (!this.db) return;
    const pending = this.verification.all();
    if (pending.length === 0) return;

    try {
      for (const d of pending) {
        await this.db.execute(
          `INSERT INTO verification_queue (
             key, entity_type, entity_id, field, kind, status, volatility, visibility,
             expected_value, observed_value, observations, independent,
             first_seen_at, last_seen_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT(key) DO UPDATE SET
             status = excluded.status,
             observations = excluded.observations,
             independent = excluded.independent,
             last_seen_at = excluded.last_seen_at`,
          [
            d.key,
            d.entityType,
            d.entityId,
            d.field,
            d.kind,
            d.status,
            d.volatility,
            JSON.stringify(d.visibility),
            d.expectedValue,
            d.observedValue,
            JSON.stringify(d.observations),
            d.independentConfirmations,
            d.firstObservedAt,
            d.lastObservedAt,
          ],
        );
      }
    } catch (err) {
      logger.warn('db', 'Could not save verification queue', { error: String(err) });
    }
  }

  /* ------------------------------------------------ discovery / spoilers */

  /**
   * Switch to a different commander's discovery state.
   *
   * Flushes the outgoing commander's state first, then loads the incoming one —
   * or starts empty. Never carries anything across: inheriting discoveries would
   * reveal to one commander what another had found, which is exactly the leak
   * the whole model exists to prevent.
   */
  private async swapDiscoveryCommander(fid: string): Promise<void> {
    const previous = this.discoveryFid;
    if (previous !== null && this.discoveryDirty) await this.saveDiscovery();

    this.discoveryFid = fid;
    this.discovery = await this.loadDiscovery(fid);
    this.discoveryDirty = false;

    // The field journal is scoped the same way and for the same reason: two
    // commanders on one machine must not inherit each other's history. The
    // engine is told first so nothing is recorded against the outgoing FID.
    this.activity.setCommander(fid);
    this.liveActivity.setCommander(fid);
    this.activityEntries = [];
    await this.loadActivity(fid);

    /*
     * Missions and colonisation sites are personal too, and were not swapped.
     * A second commander on the same machine inherited the first one's
     * outstanding missions and construction requirements -- their cargo owed,
     * their deadlines, their sites.
     *
     * Cleared before loading rather than merged, so nothing from the outgoing
     * commander can survive into the incoming one's view.
     */
    this.missions.load([]);
    this.sites.clear();
    await this.loadMissions();
    await this.loadSites();
    this.missionsDirty = false;
    this.sitesDirty = false;

    // Integrations belong to the commander whose account they are linked to.
    // Reloaded so one commander's switches never apply to another's data.
    await this.loadIntegrationState();
    await this.loadScreenshotSettings();
    await this.loadScreenshots();
    /*
     * The journal connection is keyed per commander, and the FID only becomes
     * known once the game says who is playing — which is after startup. Without
     * this reload the watermark and last-success were read under an "unknown"
     * key at launch and never corrected, so a connected account looked
     * unconfigured and nothing was ever eligible to sync.
     */
    await this.loadJournalSync();

    logger.info('discovery', 'Commander changed; discovery state swapped', {
      // FIDs identify a person's account; only whether one was present is logged.
      hadPrevious: previous !== null,
    });
    this.notify();
  }

  private async loadDiscovery(fid: string): Promise<DiscoveryState> {
    if (!this.db) return new DiscoveryState(fid);
    try {
      const rows = await this.db.select<Array<{ state: string }>>(
        'SELECT state FROM discovery_state WHERE commander_fid = $1',
        [fid],
      );
      const raw = rows[0]?.state;
      if (!raw) return new DiscoveryState(fid);
      // fromJSON re-checks the FID rather than trusting the row.
      return DiscoveryState.fromJSON(JSON.parse(raw), fid);
    } catch {
      // Failing to load means the commander sees less, never more.
      return new DiscoveryState(fid);
    }
  }

  private async saveDiscovery(): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    try {
      await this.db.execute(
        `INSERT INTO discovery_state (commander_fid, state, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT(commander_fid) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        [this.discoveryFid, JSON.stringify(this.discovery), new Date().toISOString()],
      );
    } catch (err) {
      logger.warn('db', 'Could not save discovery state', { error: String(err) });
    }
  }

  /* -------------------------------------------------------------- missions */

  private missionView(): MissionView {
    const { groups, withoutDestination } = this.missions.byDestination();
    return {
      summary: this.missions.summary(),
      groups,
      withoutDestination,
      byExpiry: this.missions.byExpiry(),
    };
  }

  private async loadMissions(): Promise<void> {
    if (!this.db) return;
    try {
      /*
       * Strictly this commander's.
       *
       * A NULL owner means migration 12 could not establish one -- more than one
       * commander has used this installation, so the rows could belong to either.
       * They are excluded from every commander's view rather than shown to all of
       * them, and are kept on disk for a future rebuild to attribute properly.
       */
      const rows = await this.db.select<MissionRow[]>(
        'SELECT * FROM missions WHERE commander_fid = $1',
        [this.discoveryFid],
      );
      this.missions.load(rows.map(fromRow));
      logger.info('missions', 'Loaded from storage', { count: rows.length });
    } catch (err) {
      logger.warn('db', 'Could not load missions', { error: String(err) });
    }
  }

  /**
   * Persist every mission the store currently holds.
   *
   * Written wholesale rather than per-change because a single `Missions`
   * reconciliation can alter many rows at once, and the set is small — the
   * busiest snapshot in the corpus held 20 active missions.
   */
  private async saveMissions(): Promise<void> {
    if (!this.db) return;
    const all = this.missions.all();
    if (all.length === 0) return;

    // The owner is written with the row. Without it a new mission would be
    // stored unattributed, and unattributed rows are visible to every commander
    // -- which is the leak migration 11 exists to close.
    const columns = [...MISSION_COLUMNS, 'commander_fid'];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    try {
      for (const mission of all) {
        const row = toRow(mission) as unknown as Record<string, unknown>;
        await this.db.execute(
          `INSERT OR REPLACE INTO missions (${columns.join(', ')}) VALUES (${placeholders})`,
          [...MISSION_COLUMNS.map((c) => row[c] ?? null), this.discoveryFid],
        );
      }
    } catch (err) {
      logger.warn('db', 'Could not save missions', { error: String(err) });
    }
  }

  /* ------------------------------------------------- carrier identities */

  /**
   * Load remembered carrier names into state before ingest begins.
   *
   * `CarrierStats` is emitted when carrier management is opened, not at session
   * start, so in most sessions the name is never mentioned at all. Remembering it
   * is the only way the name is available while simply docked.
   */
  private async loadKnownCarriers(): Promise<number> {
    if (!this.db) return 0;
    try {
      const rows = await this.db.select<Array<{ carrier_id: number; name: string }>>(
        'SELECT carrier_id, name FROM known_carriers',
      );
      for (const row of rows) this.state.knownCarriers[row.carrier_id] = row.name;
      return rows.length;
    } catch {
      return 0;
    }
  }

  private async saveCarrierIdentity(event: NormalizedEvent): Promise<void> {
    if (!this.db) return;
    const d = event.data as { carrierId: unknown; name: unknown; callsign: unknown };
    if (typeof d.carrierId !== 'number' || typeof d.name !== 'string' || d.name.length === 0) return;

    try {
      await this.db.execute(
        `INSERT INTO known_carriers (carrier_id, name, callsign, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(carrier_id) DO UPDATE SET
           name = excluded.name, callsign = excluded.callsign, updated_at = excluded.updated_at`,
        [
          d.carrierId,
          d.name,
          typeof d.callsign === 'string' ? d.callsign : null,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      logger.warn('db', 'Could not remember carrier identity', { error: String(err) });
    }
  }


  /* ------------------------------------------------------------ backfills */

  /*
   * Recovering state from journals the app was not running for.
   *
   * The routines live in lib/backfill.ts: four variations on one shape, sharing
   * one hazard worth isolating -- none may go through `applyEvent`, or a
   * month-old event would be reported as the latest thing that happened. Their
   * coupling back to here is five things, passed in.
   */

  private backfillContext(): BackfillContext {
    return {
      state: this.state,
      saveCarrierIdentity: (event) => this.saveCarrierIdentity(event),
      saveTraderIdentity: (event) => this.saveTraderIdentity(event),
      changed: () => {
        this.notify();
        if (this.overlayEnabled) this.pushOverlayState();
      },
    };
  }

  private backfillCarrierIdentities(directory: string): Promise<void> {
    return backfillCarrierIdentities(this.backfillContext(), directory);
  }

  private backfillTraderIdentities(directory: string): Promise<void> {
    return backfillTraderIdentities(this.backfillContext(), directory);
  }

  private backfillCarrierJumps(directory: string): Promise<void> {
    return backfillCarrierJumps(this.backfillContext(), directory);
  }

  private backfillExobiologyHoldings(directory: string): Promise<void> {
    return backfillExobiologyHoldings(this.backfillContext(), directory);
  }

  /* --------------------------------------------------- trader identities */

  /**
   * Load remembered Material Trader kinds before ingest begins.
   *
   * Same reasoning as `loadKnownCarriers`: the `MaterialTrade` that revealed a
   * station's kind may have been months ago, so without this the answer is lost on
   * every restart and the app falls back to "kind unknown" at a station the
   * commander has used repeatedly.
   */
  private async loadKnownTraders(): Promise<number> {
    if (!this.db) return 0;
    try {
      const rows = await this.db.select<Array<{ market_id: number; trader_type: string }>>(
        'SELECT market_id, trader_type FROM known_traders',
      );
      for (const row of rows) this.state.knownTraders[row.market_id] = row.trader_type;
      return rows.length;
    } catch {
      return 0;
    }
  }

  private async saveTraderIdentity(event: NormalizedEvent): Promise<void> {
    if (!this.db) return;
    const d = event.data as { marketId: unknown; traderType: unknown };
    if (typeof d.marketId !== 'number' || typeof d.traderType !== 'string') return;
    // Mirror learnTrader's filter, so an unrecognised kind is not persisted and
    // then loaded back as though it had been validated.
    const type = d.traderType.toLowerCase();
    if (type !== 'encoded' && type !== 'raw' && type !== 'manufactured') return;

    try {
      await this.db.execute(
        `INSERT INTO known_traders (market_id, trader_type, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(market_id) DO UPDATE SET
           trader_type = excluded.trader_type, updated_at = excluded.updated_at`,
        [d.marketId, type, new Date().toISOString()],
      );
    } catch (err) {
      logger.warn('db', 'Could not remember material trader kind', { error: String(err) });
    }
  }



  /**
   * The newest activity, for the overlay.
   *
   * One entry plus two counts. The overlay answers "what did I just record";
   * reading back through history is what the Journal screen is for, and a
   * scrollable list over a game would be neither.
   */
  private projectLiveJournal(): LiveJournalState | null {
    const newest = this.activityEntries[0];
    if (!newest) return null;

    // How much happened at this same body -- the number a commander actually
    // wants while working one: "2 species recorded here".
    const hereCount = this.activityEntries.filter(
      (e) => e.bodyName === newest.bodyName && e.systemName === newest.systemName,
    ).length;

    return {
      title: newest.title,
      detail: newest.detail,
      systemName: newest.systemName,
      bodyName: newest.bodyName,
      occurredAt: newest.occurredAt,
      hereCount,
      sessionCount: this.activityEntries.length,
    };
  }

  /* -------------------------------------------------- activity journal */

  /**
   * Load a body's stored exobiology rows when the commander arrives.
   *
   * This is what makes a half-finished specimen survive leaving the planet, the
   * system, or the app. Progress is kept as current state rather than as events,
   * so coming back is a read rather than a replay.
   */
  private async hydrateBodyRoster(ref: BodyRef): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    try {
      const rows = await this.db.select<
        Array<{
          genus_token: string;
          genus: string;
          species_token: string | null;
          species: string | null;
          colour: string | null;
          samples_taken: number | null;
          samples_required: number;
          completed: number;
          started_at: string | null;
          updated_at: string;
        }>
      >(
        `SELECT genus_token, genus, species_token, species, colour,
                samples_taken, samples_required, completed, started_at, updated_at
           FROM exobiology_progress
          WHERE commander_fid = $1 AND system_address = $2 AND body_id = $3
          ORDER BY sort_order, genus`,
        [this.discoveryFid, ref.systemAddress ?? 0, ref.bodyId],
      );

      this.liveActivity.hydrate(
        ref,
        rows.map((r) => ({
          genusToken: r.genus_token,
          genus: r.genus,
          speciesToken: r.species_token,
          species: r.species,
          colour: r.colour,
          samplesTaken: r.samples_taken,
          samplesRequired: r.samples_required,
          completed: r.completed === 1,
          startedAt: r.started_at,
          updatedAt: r.updated_at,
        })),
      );
      await this.applyJournalCompletions(ref);

      this.notify();
      if (this.overlayEnabled) this.pushOverlayState();
    } catch (err) {
      // A failed read leaves the roster as whatever this session has observed,
      // which is incomplete rather than wrong.
      logger.warn('activity', 'Could not read exobiology progress', { error: String(err) });
    }
  }

  /**
   * Let the Activity Journal correct the roster.
   *
   * The Journal is the durable record of what was actually finished: one
   * `sample-completed` entry per specimen, derived from an `Analyse` event, with
   * an id stable across restart and replay. The progress table beside it only
   * knows what this process watched happen, so a specimen completed before the
   * table existed — or in a session whose writes were lost — reads as unscanned
   * until this runs.
   *
   * Cheap: one indexed read per body entered, against rows that are already
   * commander-scoped.
   */
  private async applyJournalCompletions(ref: BodyRef): Promise<void> {
    if (!this.db || this.discoveryFid === null) return;
    try {
      const rows = await this.db.select<Array<{ data: string }>>(
        `SELECT data FROM activity_entries
          WHERE commander_fid = $1 AND subtype = 'sample-completed' AND body_id = $2
            AND (system_address IS NULL OR system_address = $3)`,
        [this.discoveryFid, ref.bodyId, ref.systemAddress ?? 0],
      );

      const records: CompletedRecord[] = [];
      for (const row of rows) {
        try {
          const data = JSON.parse(row.data) as Record<string, unknown>;
          const text = (k: string): string | null =>
            typeof data[k] === 'string' && data[k] !== '' ? (data[k] as string) : null;
          records.push({
            genusToken: text('genusToken'),
            genus: text('genus'),
            // The entry carries the species and variant, so a recovered
            // specimen reads with its full name and value rather than the bare
            // genus a surface scan would have given.
            speciesToken: text('speciesToken'),
            species: text('species'),
            colour: text('colour'),
          });
        } catch {
          // A single unreadable entry must not stop the rest correcting the roster.
        }
      }

      if (this.liveActivity.applyCompleted(records)) {
        const dirty = this.liveActivity.takeDirtyRows();
        if (dirty.length > 0) {
          await this.saveExobiologyRows(this.liveActivity.currentBody, dirty);
        }
        this.notify();
      }
    } catch (err) {
      logger.warn('activity', 'Could not read completions from the journal', {
        error: String(err),
      });
    }
  }

  /**
   * Show the roster for the body the commander is already on.
   *
   * At startup the reader resumes from a byte offset, so somebody standing on a
   * planet produces no `ApproachBody` and the panel stayed empty until they
   * happened to scan something. The current location is known from state, so it
   * is used directly.
   */
  private enterCurrentBody(): void {
    if (this.liveActivity.currentBody !== null) return;
    if (!isKnown(this.state.bodyId)) return;

    const entered = this.liveActivity.enterKnownBody({
      systemAddress: isKnown(this.state.systemAddress) ? this.state.systemAddress : null,
      bodyId: this.state.bodyId,
      bodyName: isKnown(this.state.body) ? this.state.body : null,
      systemName: isKnown(this.state.starSystem) ? this.state.starSystem : null,
    });

    if (entered) {
      const request = this.liveActivity.takeHydrationRequest();
      if (request !== null) void this.hydrateBodyRoster(request);
    }
  }

  /**
   * Write changed rows back.
   *
   * Upsert on the natural key rather than append: this table is state, not a
   * log, so a body with four genera has four rows however many samples were
   * taken. `sort_order` preserves the order the surface scan reported.
   */
  private async saveExobiologyRows(
    ref: BodyRef | null,
    rows: readonly SpeciesProgress[],
  ): Promise<void> {
    if (!this.db || this.discoveryFid === null || ref === null || rows.length === 0) return;
    const now = new Date().toISOString();

    try {
      for (const row of rows) {
        await this.db.execute(
          `INSERT INTO exobiology_progress
             (commander_fid, system_address, body_id, genus_token, genus,
              species_token, species, colour, samples_taken, samples_required,
              completed, sort_order, system_name, body_name, started_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (commander_fid, system_address, body_id, genus_token)
           DO UPDATE SET
             genus = excluded.genus,
             species_token = excluded.species_token,
             species = excluded.species,
             colour = excluded.colour,
             samples_taken = excluded.samples_taken,
             completed = excluded.completed,
             system_name = COALESCE(excluded.system_name, exobiology_progress.system_name),
             body_name = COALESCE(excluded.body_name, exobiology_progress.body_name),
             started_at = COALESCE(exobiology_progress.started_at, excluded.started_at),
             updated_at = excluded.updated_at`,
          [
            this.discoveryFid,
            ref.systemAddress ?? 0,
            ref.bodyId,
            row.genusToken,
            row.genus,
            row.speciesToken,
            row.species,
            row.colour,
            row.samplesTaken,
            row.samplesRequired,
            row.completed ? 1 : 0,
            rows.indexOf(row),
            ref.systemName,
            ref.bodyName,
            row.startedAt,
            row.updatedAt || now,
          ],
        );
      }
    } catch (err) {
      logger.warn('activity', 'Could not save exobiology progress', { error: String(err) });
    }
  }

  /**
   * Live activity for the overlay.
   *
   * Projected to exactly what the widget draws, so the overlay window holds no
   * logic that could disagree with this one. Null when nothing is in progress,
   * which is what lets the widget fall back to the newest recorded entry.
   */
  private projectLiveActivity(): OverlayLiveActivity | null {
    const live = this.liveActivity.state;
    if (live === null) return null;
    const e = live.exobiology;
    return {
      kind: 'exobiology',
      bodyName: e.bodyName,
      rows: e.rows.map((r) => {
        // Looked up at projection rather than stored: reference data changes
        // with the game, and a value frozen into a row would quietly go stale.
        const info = speciesInfo(r.species);
        return {
          genus: r.genus,
          species: r.species,
          colour: r.colour,
          status: rowStatus(r),
          samplesTaken: r.samplesTaken,
          samplesRequired: r.samplesRequired,
          value: info ? formatCredits(info.value) : null,
          sampleDistance: info?.sampleDistance ?? null,
        };
      }),
      completedCount: e.completedCount,
      unscannedCount: e.unscannedCount,
      total: e.total,
      updatedAt: e.updatedAt,
    };
  }

  /**
   * Write new activity through to SQLite.
   *
   * `INSERT OR IGNORE`, because the id is derived from the journal event and is
   * therefore already stable across restart and replay. Re-reading a file
   * re-derives the same ids and the write is simply dropped -- deduplication is
   * a property of the key rather than a procedure to get right.
   *
   * Never awaited by the caller: the field journal is a record, not a gate on
   * ingest.
   */
  private async saveActivity(entries: readonly ActivityEntry[]): Promise<void> {
    if (!this.db || entries.length === 0) return;
    const now = new Date().toISOString();

    try {
      for (const e of entries) {
        await this.db.execute(
          `INSERT OR IGNORE INTO activity_entries
             (id, commander_fid, occurred_at, category, subtype,
              system_name, system_address, body_name, body_id, location_name,
              title, detail, data, sources, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            e.id,
            e.commanderFid,
            e.occurredAt,
            e.category,
            e.subtype,
            e.systemName,
            e.systemAddress,
            e.bodyName,
            e.bodyId,
            e.locationName,
            e.title,
            e.detail,
            JSON.stringify(e.data),
            JSON.stringify(e.sources),
            now,
          ],
        );
      }
      // Count and category only. Titles carry system names, body names and
      // organism discoveries, and none of that belongs in a log (§21).
      logger.info('activity', 'Recorded activity', {
        count: entries.length,
        categories: [...new Set(entries.map((e) => e.category))],
      });
    } catch (err) {
      logger.warn('db', 'Could not record activity', { error: String(err) });
    }
  }

  /**
   * Load this commander's recent activity.
   *
   * Scoped by FID so two commanders on one machine never see each other's
   * history. Bounded, because the screen is a timeline rather than an archive.
   */
  private async loadActivity(fid: string): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db.select<ActivityRow[]>(
        // Footfall entries are no longer recorded. Rows from before that are
        // left on disk but not shown.
        `SELECT * FROM activity_entries
          WHERE commander_fid = $1
            AND subtype <> 'footfall'
          ORDER BY occurred_at DESC
          LIMIT $2`,
        [fid, Companion.ACTIVITY_IN_MEMORY],
      );

      this.activityEntries = rows.map(activityFromRow);
      this.notify();
    } catch (err) {
      logger.warn('db', 'Could not load activity', { error: String(err) });
    }
  }

  /* ------------------------------------------------ exobiology holdings */


  /* -------------------------------------------------------- reference data */

  /** Whether the commander has opted in to verification. */
  get verificationConsent(): boolean {
    return this.verificationEnabled;
  }

  /**
   * Turn verification on or off.
   *
   * Turning it off drops the cache as well as stopping new lookups. Keeping
   * reference data the commander has withdrawn consent for would be a quiet
   * way of not honouring the setting.
   */
  async setVerificationEnabled(enabled: boolean): Promise<void> {
    this.verificationEnabled = enabled;
    if (!enabled) {
      this.reference.clear();
      this.pendingRecheck.clear();
    }
    await this.setSetting('verificationEnabled', String(enabled));
    // Queued observations are deliberately kept: they are local, inert without
    // consent, and deleting them would mean opting back in loses history the
    // commander never asked to discard.
    await this.refreshContributions();
    this.notify();
  }

  /**
   * Hold the newest station event so it can be compared once reference data
   * arrives. Without this, the first visit to any station is never verified:
   * the lookup misses, the fetch completes moments later, and nothing goes
   * back to look again.
   */
  private rememberForRecheck(event: NormalizedEvent): void {
    if (!this.verificationEnabled) return;
    const observation = observeStation(event);
    if (observation === null) return;

    // Fleet carriers are never compared -- their services are the owner's
    // current configuration, not a fact about the galaxy -- so the server can
    // only ever return zero findings for one. Uploading them anyway would be
    // traffic that cannot produce a result, and S21 asks for the minimum
    // payload the feature needs.
    if (isCarrier(observation)) return;

    const key = `station:${String(observation.marketId)}`;
    this.pendingRecheck.delete(key);
    this.pendingRecheck.set(key, event);
    while (this.pendingRecheck.size > MAX_PENDING_RECHECK) {
      const oldest = this.pendingRecheck.keys().next();
      if (oldest.done) break;
      this.pendingRecheck.delete(oldest.value);
    }
  }

  /** Re-compare the held event now that the reference for it is cached. */
  private recheck(entityType: string, entityId: string): void {
    const key = `${entityType}:${entityId}`;
    const event = this.pendingRecheck.get(key);
    if (event === undefined) return;
    this.pendingRecheck.delete(key);

    try {
      if (this.verification.observe(event, this.reference).length > 0) {
        this.verificationDirty = true;
        this.notify();
      }
    } catch (err) {
      // A re-check is best effort. It must never take down ingest.
      logger.warn('verification', 'Re-check failed', { error: String(err) });
    }
  }

  /* --------------------------------------------------------------- plugins */

  /**
   * Load plugins from disk and merge what they contribute.
   *
   * Runs once at startup, before ingest, so a contributed context rule is live
   * for the first journal line rather than the second. Failure is contained:
   * the loader never throws, a bad plugin is reported rather than fatal, and
   * the application starts normally with no plugins at all.
   */
  private async loadPluginsFromDisk(): Promise<void> {
    try {
      const scan = await invoke<{
        directory: string | null;
        source: string;
        fallback_reason: string | null;
        plugins: Array<{ directory: string; json: string }>;
        errors: Array<{ directory: string; message: string }>;
      }>('plugins_read');

      const result = loadPlugins(scan.plugins);

      // Built-ins first: if a namespacing bug ever let an id collide, the
      // shipped rule wins. A plugin quietly replacing a built-in context would
      // be invisible to the commander.
      const enabled = result.loaded.filter((p) => !this.disabledPlugins.has(p.manifest.id));
      const merged = mergeContextRules(BUNDLED_RULES, enabled);
      this.resolver.setRuleSet(merged);

      this.pluginView = {
        loaded: result.loaded,
        rejected: result.rejected,
        directory: scan.directory,
        contributedRules: merged.rules.length - BUNDLED_RULES.rules.length,
        source: scan.source,
        fallbackReason: scan.fallback_reason,
        unreadable: scan.errors,
        disabledIds: [...this.disabledPlugins],
      };

      for (const plugin of result.loaded) {
        logger.info('plugins', 'Loaded', {
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          contextRules: plugin.contextRules.length,
          researchProjects: plugin.researchProjects.length,
          warnings: plugin.warnings.length,
        });
      }
      for (const bad of result.rejected) {
        logger.warn('plugins', 'Refused', {
          directory: bad.directory,
          reason: bad.problems[0]?.message ?? 'unknown',
        });
      }
      for (const unreadable of scan.errors) {
        logger.warn('plugins', 'Unreadable', {
          directory: unreadable.directory,
          reason: unreadable.message,
        });
      }
      if (scan.fallback_reason !== null) {
        logger.info('plugins', 'Using a fallback folder', {
          source: scan.source,
          reason: scan.fallback_reason,
        });
      }
      this.notify();
    } catch (err) {
      // A plugin system that can stop the app from starting is worse than no
      // plugin system.
      logger.warn('plugins', 'Could not read plugins folder', { error: String(err) });
    }
  }

  /** Reload without restarting, so an author can iterate. */
  async reloadPlugins(): Promise<void> {
    await this.loadPluginsFromDisk();
  }

  /**
   * Switch a plugin on or off.
   *
   * Takes effect immediately by rebuilding the rule set, rather than asking
   * for a restart: a toggle that needs a restart is a toggle people distrust.
   */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (enabled) this.disabledPlugins.delete(id);
    else this.disabledPlugins.add(id);

    await this.setSetting('disabledPlugins', JSON.stringify([...this.disabledPlugins]));

    const active = this.pluginView.loaded.filter((p) => !this.disabledPlugins.has(p.manifest.id));
    this.resolver.setRuleSet(mergeContextRules(BUNDLED_RULES, active));

    this.pluginView = { ...this.pluginView, disabledIds: [...this.disabledPlugins] };
    logger.info('plugins', enabled ? 'Enabled' : 'Disabled', { id });
    this.notify();
  }

  isPluginEnabled(id: string): boolean {
    return !this.disabledPlugins.has(id);
  }

  async openPluginsFolder(): Promise<void> {
    try {
      await invoke('plugins_open_folder');
    } catch (err) {
      logger.warn('plugins', 'Could not open plugins folder', { error: String(err) });
    }
  }

  /* ------------------------------------------------------------- logistics */

  /**
   * A depot event is a complete snapshot, so the site is replaced, not merged.
   *
   * Commander-assigned name and priority survive, because they are the one
   * part of the record the game does not supply and must not be lost every
   * time the depot reports.
   */
  private observeConstructionDepot(event: NormalizedEvent): void {
    const marketId = String((event.data as { marketId?: unknown }).marketId ?? '');
    const site = siteFromDepot(event, this.sites.get(marketId));
    if (site === null) return;

    const previous = this.sites.get(site.marketId);
    const merged: ConstructionSite = previous
      ? { ...site, name: previous.name, priority: previous.priority }
      : site;

    // Only notify when something a commander would notice actually moved.
    const changed =
      previous === undefined ||
      previous.complete !== merged.complete ||
      previous.failed !== merged.failed ||
      previous.resources.length !== merged.resources.length ||
      previous.resources.some((r, i) => r.remaining !== merged.resources[i]?.remaining);

    this.sites.set(site.marketId, merged);
    if (changed) {
      this.sitesDirty = true;
      this.notify();
    }
  }

  async setSiteName(marketId: string, name: string): Promise<void> {
    const site = this.sites.get(marketId);
    if (site === undefined) return;
    this.sites.set(marketId, { ...site, name: name.trim() === '' ? null : name.trim() });
    this.sitesDirty = true;
    this.notify();
    await this.saveSites();
  }

  async setSitePriority(marketId: string, priority: number): Promise<void> {
    const site = this.sites.get(marketId);
    if (site === undefined) return;
    this.sites.set(marketId, { ...site, priority: Math.max(1, Math.round(priority)) });
    this.sitesDirty = true;
    this.notify();
    await this.saveSites();
  }

  /** How a purchase should be split between sites (S17). */
  allocationFor(commodity: string, amount: number) {
    return allocate(commodity, amount, [...this.sites.values()]);
  }

  /**
   * Build a sourcing plan.
   *
   * Commander-initiated, never background. The market search is required
   * traffic for a feature the commander just asked for, which S21 keeps
   * distinct from optional contribution -- so it is not gated behind the
   * contribution setting, and it does not happen unless asked.
   */
  async buildSourcingPlan(options: PlanOptions = {}): Promise<void> {
    const requirements = combinedRequirements([...this.sites.values()]);
    if (requirements.length === 0) {
      this.plan = null;
      this.planningState = 'idle';
      this.planError = 'No outstanding requirements.';
      this.notify();
      return;
    }

    this.planningState = 'searching';
    this.planError = null;
    this.notify();

    try {
      const response = await httpFetch(API_BASE_URL + '/v1/market/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commodities: requirements.map((r) => r.commodity).slice(0, 64),
          minStock: 1,
          limit: 120,
          includeFleetCarriers: options.allowFleetCarriers === true,
          ...(options.allowPlanetary === false ? { includePlanetary: false } : {}),
          ...(options.maxDataAgeSeconds === undefined
            ? {}
            : { maxAgeSeconds: options.maxDataAgeSeconds }),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error('market search failed (' + String(response.status) + ')');
      }
      const body = (await response.json()) as { candidates: CandidateStation[] };
      this.candidatesConsidered = body.candidates.length;

      // Planning happens here, not on the server: the reasoning stays where
      // the commander can inspect it.
      this.plan = buildPlan(requirements, body.candidates, options);
      this.plannedAt = new Date().toISOString();
      this.planningState = 'idle';
      logger.info('logistics', 'Sourcing plan built', {
        requirements: requirements.length,
        candidates: body.candidates.length,
        stops: this.plan.totalStops,
        unfulfilled: this.plan.unfulfilled.length,
      });
    } catch (error) {
      this.planningState = 'error';
      this.planError =
        (error as Error).name === 'TimeoutError'
          ? 'The market service did not respond in time.'
          : (error as Error).message;
      logger.warn('logistics', 'Sourcing plan failed', { error: this.planError });
    }
    this.notify();
  }

  private async saveSites(): Promise<void> {
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      for (const site of this.sites.values()) {
        await this.db.execute(
          `INSERT INTO construction_sites
             (market_id, progress, complete, failed, resources, name, priority,
              updated_at, first_seen_at, commander_fid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(market_id) DO UPDATE SET
             progress = excluded.progress,
             complete = excluded.complete,
             failed = excluded.failed,
             resources = excluded.resources,
             name = excluded.name,
             priority = excluded.priority,
             updated_at = excluded.updated_at`,
          [
            site.marketId, site.progress, site.complete ? 1 : 0, site.failed ? 1 : 0,
            JSON.stringify(site.resources), site.name, site.priority, site.updatedAt, now,
            // Same reason as missions: an unattributed row is a visible-to-all row.
            this.discoveryFid,
          ],
        );
      }
    } catch (err) {
      logger.warn('db', 'Could not save construction sites', { error: String(err) });
    }
  }

  private async loadSites(): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db.select<Array<Record<string, unknown>>>(
        `SELECT * FROM construction_sites
          WHERE commander_fid = $1
          ORDER BY priority, updated_at DESC`,
        [this.discoveryFid],
      );
      for (const r of rows) {
        this.sites.set(String(r.market_id), {
          marketId: String(r.market_id),
          progress: r.progress === null ? null : Number(r.progress),
          complete: Number(r.complete) === 1,
          failed: Number(r.failed) === 1,
          resources: JSON.parse(String(r.resources)) as ConstructionSite['resources'],
          updatedAt: String(r.updated_at),
          priority: Number(r.priority),
          name: r.name === null ? null : String(r.name),
        });
      }
    } catch (err) {
      logger.warn('db', 'Could not load construction sites', { error: String(err) });
    }
  }

  /* ----------------------------------------------------------- contribution */

  get contributionIdentityMode(): IdentityMode {
    return this.identityMode;
  }

  async setIdentityMode(mode: IdentityMode): Promise<void> {
    this.identityMode = mode;
    await this.setSetting('identityMode', mode);
    this.notify();
  }

  /**
   * Queue a station observation for submission.
   *
   * Queued regardless of consent, and sent only with it. An observation that
   * was never queued cannot be offered later if the commander opts in, and
   * queueing is purely local -- the row is inert until a flush reads it.
   */
  private async queueObservation(event: NormalizedEvent): Promise<void> {
    if (!this.db) return;
    const observation = observeStation(event);
    if (observation === null) return;

    try {
      await this.db.execute(
        `INSERT INTO observation_queue
           (source_event_id, entity_type, entity_id, payload, observed_at, queued_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(source_event_id) DO NOTHING`,
        [
          observation.sourceEventId,
          'station',
          String(observation.marketId),
          JSON.stringify(observation),
          observation.observedAt,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      logger.warn('db', 'Could not queue observation', { error: String(err) });
    }
  }

  /**
   * Send what is queued.
   *
   * Bounded per pass and never awaited by ingest: a slow or unreachable server
   * must not become the commander's journal latency.
   */
  private async flushObservations(): Promise<void> {
    if (!this.db || !this.verificationEnabled || this.flushingQueue) return;
    this.flushingQueue = true;

    try {
      const rows = await this.db.select<Array<{ source_event_id: string; payload: string; attempts: number }>>(
        `SELECT source_event_id, payload, attempts FROM observation_queue
          WHERE submitted_at IS NULL AND attempts < 5
          ORDER BY queued_at LIMIT 10`,
      );

      for (const row of rows) {
        let observation;
        try {
          observation = JSON.parse(row.payload) as ReturnType<typeof observeStation>;
        } catch {
          await this.db.execute(
            `UPDATE observation_queue SET attempts = 99, last_error = $2
              WHERE source_event_id = $1`,
            [row.source_event_id, 'unreadable payload'],
          );
          continue;
        }
        if (observation === null) continue;

        const outcome = await this.submitter.submit(observation);

        if (outcome.kind === 'accepted') {
          await this.db.execute(
            `UPDATE observation_queue
                SET submitted_at = $2, findings = $3, last_error = NULL
              WHERE source_event_id = $1`,
            [row.source_event_id, new Date().toISOString(), outcome.findings],
          );
        } else if (outcome.kind === 'rejected') {
          // Our mistake. Attempts is exhausted rather than retried, because
          // sending it again sends the same mistake.
          await this.db.execute(
            `UPDATE observation_queue SET attempts = 99, last_error = $2
              WHERE source_event_id = $1`,
            [row.source_event_id, outcome.detail],
          );
        } else if (outcome.kind === 'unavailable') {
          // Offline or a server error: count the attempt and try again later.
          await this.db.execute(
            `UPDATE observation_queue SET attempts = attempts + 1, last_error = $2
              WHERE source_event_id = $1`,
            [row.source_event_id, outcome.detail],
          );
          // One outage stops the pass; hammering a down server helps nobody.
          break;
        } else {
          break; // skipped: consent went off mid-flush
        }
      }

      await this.refreshContributions();
    } catch (err) {
      logger.warn('submit', 'Flush failed', { error: String(err) });
    } finally {
      this.flushingQueue = false;
    }
  }

  private async refreshContributions(): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db.select<Array<Record<string, unknown>>>(
        `SELECT
           COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)              AS submitted,
           COUNT(*) FILTER (WHERE submitted_at IS NULL AND attempts < 5) AS pending,
           COUNT(*) FILTER (WHERE submitted_at IS NULL AND attempts >= 5) AS failed,
           COALESCE(SUM(findings), 0)                                    AS findings,
           MAX(submitted_at)                                             AS last_at
         FROM observation_queue`,
      );
      const r = rows[0] ?? {};
      const detected = await this.db.select<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM verification_queue',
      );

      this.contributions = {
        ...this.contributions,
        submitted: Number(r.submitted ?? 0),
        pending: Number(r.pending ?? 0),
        failed: Number(r.failed ?? 0),
        findingsFromSubmissions: Number(r.findings ?? 0),
        discrepanciesDetected: Number(detected[0]?.n ?? 0),
        lastContributionAt: r.last_at === null || r.last_at === undefined ? null : String(r.last_at),
      };
      this.notify();
    } catch (err) {
      logger.warn('db', 'Could not read contribution counts', { error: String(err) });
    }
  }

  /* --------------------------------------------------------------- research */

  private researchView(): ResearchView {
    const sessions = this.research.sessions();
    return {
      projectTitle: SETTLEMENT_MATERIALS.title,
      projectVersion: SETTLEMENT_MATERIALS.version,
      sessions: [...sessions].reverse().slice(0, 50),
      active: this.research.openSession,
      quality: summarise(sessions, SETTLEMENT_MATERIALS),
      byEconomy: groupBy(sessions, SETTLEMENT_MATERIALS, 'economy'),
      items: itemTally(sessions, SETTLEMENT_MATERIALS).slice(0, 20),
      unavailableFields: SETTLEMENT_MATERIALS.unavailableFields ?? [],
    };
  }

  /** §12: the commander may mark a session, but is never prompted to. */
  async markSessionCompleteness(id: string, completeness: Completeness): Promise<void> {
    if (!this.research.markCompleteness(id, completeness)) return;
    this.researchDirty = true;
    this.notify();
    await this.saveResearch();
  }

  private async saveResearch(): Promise<void> {
    if (!this.db) return;
    try {
      for (const s of this.research.sessions()) {
        await this.db.execute(
          `INSERT INTO research_sessions
             (id, project_id, project_version, started_at, ended_at, duration_s,
              context, observations, outcome, end_event, completeness,
              commander, commander_fid, game_version, game_build,
              companion_version, session_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT(id) DO UPDATE SET
             ended_at = excluded.ended_at,
             duration_s = excluded.duration_s,
             observations = excluded.observations,
             outcome = excluded.outcome,
             end_event = excluded.end_event,
             completeness = excluded.completeness`,
          [
            s.id, s.projectId, s.projectVersion, s.startedAt, s.endedAt, s.durationSeconds,
            JSON.stringify(s.context), JSON.stringify(s.observations),
            s.outcome, s.endEvent, s.completeness,
            s.commander, s.commanderFid, s.gameVersion, s.gameBuild,
            s.companionVersion, s.sessionKey,
          ],
        );
      }
    } catch (err) {
      logger.warn('db', 'Could not save research sessions', { error: String(err) });
    }
  }

  private async loadResearch(): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db.select<Array<Record<string, unknown>>>(
        `SELECT * FROM research_sessions WHERE project_id = $1
          ORDER BY started_at DESC LIMIT 500`,
        [SETTLEMENT_MATERIALS.id],
      );
      const sessions = rows.map((r) => ({
        id: String(r.id),
        projectId: String(r.project_id),
        projectVersion: Number(r.project_version),
        startedAt: String(r.started_at),
        endedAt: r.ended_at === null ? null : String(r.ended_at),
        durationSeconds: r.duration_s === null ? null : Number(r.duration_s),
        context: JSON.parse(String(r.context)) as Record<string, string | null>,
        observations: JSON.parse(String(r.observations)) as ObservedSession['observations'],
        outcome: String(r.outcome) as ObservedSession['outcome'],
        endEvent: r.end_event === null ? null : String(r.end_event),
        completeness: String(r.completeness) as Completeness,
        commander: r.commander === null ? null : String(r.commander),
        commanderFid: r.commander_fid === null ? null : String(r.commander_fid),
        gameVersion: r.game_version === null ? null : String(r.game_version),
        gameBuild: r.game_build === null ? null : String(r.game_build),
        companionVersion: String(r.companion_version),
        sessionKey: String(r.session_key),
      })) satisfies ObservedSession[];
      // Oldest first, matching the order the tracker would have produced.
      this.research.load(sessions.reverse());
    } catch (err) {
      logger.warn('db', 'Could not load research sessions', { error: String(err) });
    }
  }

  /* ------------------------------------------------------------ persistence */

  private async getSetting(key: string): Promise<string | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<Array<{ value: string }>>(
        'SELECT value FROM settings WHERE key = $1',
        [key],
      );
      return rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!this.db) return;
    await this.db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  /**
   * Checkpoints are scoped per commander FID where known.
   *
   * A single global checkpoint would let one commander resume at another's byte
   * offset after a commander switch, which §35 calls out explicitly.
   */
  private checkpointScope(): string {
    const fid = this.state.fid;
    return typeof fid === 'string' ? `fid:${fid}` : 'default';
  }

  private async loadCheckpoint(): Promise<JournalCheckpoint | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<
        Array<{ source_file: string; byte_offset: number; last_event_id: string | null; updated_at: string }>
      >('SELECT source_file, byte_offset, last_event_id, updated_at FROM journal_checkpoint WHERE scope = $1', [
        this.checkpointScope(),
      ]);
      const row = rows[0];
      if (!row) return null;
      return {
        sourceFile: row.source_file,
        byteOffset: row.byte_offset,
        lastEventId: row.last_event_id,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  private async flushCheckpoint(): Promise<void> {
    const c = this.dirtyCheckpoint;
    if (!c || !this.db) return;
    this.dirtyCheckpoint = null;
    try {
      await this.db.execute(
        `INSERT INTO journal_checkpoint (scope, source_file, byte_offset, last_event_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(scope) DO UPDATE SET
           source_file = excluded.source_file,
           byte_offset = excluded.byte_offset,
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at`,
        [this.checkpointScope(), c.sourceFile, c.byteOffset, c.lastEventId, c.updatedAt],
      );
    } catch (err) {
      logger.warn('db', 'Checkpoint write failed', { error: String(err) });
    }
  }
}

export const companion = new Companion();
