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
import { credentialPresent } from './credentials.js';
import {
  ActivityEngine,
  groupActivity,
  type ActivityEntry,
  type ActivityGroup,
} from '@edfm/activity';
import { DEFAULT_GUIDANCE_MODE, type GuidanceMode } from '@edfm/context';
import {
  EMPTY_QUEUE,
  INTEGRATIONS,
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
    edastro: { enabled: false, hasCredential: false },
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
        sharing: sharingAudit({
          descriptors: integrationsList(),
          state: this.sharingState,
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
      this.notify();
    }

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
      const rows = await this.db.select<
        Array<{
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
        }>
      >(
        `SELECT * FROM activity_entries
          WHERE commander_fid = $1
          ORDER BY occurred_at DESC
          LIMIT $2`,
        [fid, Companion.ACTIVITY_IN_MEMORY],
      );

      this.activityEntries = rows.map((r) => ({
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
      }));
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
