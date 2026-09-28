/**
 * Recovering state from journals the app was not running for.
 *
 * Four routines that share one shape and one hazard. Each walks recent journal
 * files, applies a `learn*`-style mutation, and tells the UI something changed.
 *
 * **The hazard, stated once here rather than four times:** none of these may go
 * through `applyEvent`. These are historical events, and the reducer maintains
 * "what just happened" — replaying a month-old dock through it would make the
 * dashboard and the overlay report stale activity as the latest thing the
 * commander did. That is why `elite-journal` exports `learnCarrier`,
 * `learnTrader`, `recordCarrierJump`, `cancelCarrierJump` and `confirmCarrierAt`
 * separately from the reducer at all.
 *
 * Extracted from `Companion` because the group is cohesive and its coupling is
 * narrow: it needs commander state, a way to persist two kinds of learned
 * identity, and a way to say "something changed". Five dependencies, all passed
 * in, which is what made this worth lifting out of a 2,200-line class while
 * leaving the rest alone.
 *
 * Every one of these is started un-awaited and must never throw into its caller:
 * a failed backfill costs a convenience, and must not cost a working app.
 */

import {
  cancelCarrierJump,
  confirmCarrierAt,
  learnCarrier,
  learnTrader,
  listJournalFiles,
  recordCarrierJump,
  replayFile,
  type CommanderState,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import { logger } from './logger.js';
import { tauriFs } from './tauriFs.js';

export interface BackfillContext {
  readonly state: CommanderState;
  /** Persist a learned carrier identity. */
  readonly saveCarrierIdentity: (event: NormalizedEvent) => Promise<void>;
  /** Persist a learned Material Trader kind. */
  readonly saveTraderIdentity: (event: NormalizedEvent) => Promise<void>;
  /** Re-render, and push to the overlay if it is showing. */
  readonly changed: () => void;
}

/**
 * Recover fleet carrier names from historical journals.
 *
 * Runs only when nothing is remembered yet. Live ingest resumes from a
 * checkpoint, so a `CarrierStats` written before the app was ever installed would
 * otherwise never be seen — the name would stay unavailable until the commander
 * happened to open carrier management again.
 *
 * Bounded to the most recent journals and stops as soon as an identity is found,
 * so this cannot become a 220-file scan on startup (§30).
 */
export async function backfillCarrierIdentities(
  ctx: BackfillContext,
  directory: string,
  maxFiles = 25,
): Promise<void> {
  try {
    const files = (await listJournalFiles(directory, tauriFs)).filter((f) => f.sizeBytes > 0);
    const recent = files.slice(-maxFiles).reverse(); // newest first

    for (const file of recent) {
      const result = await replayFile(file.fullPath, tauriFs);
      let found = false;

      for (const event of result.events) {
        if (event.kind !== 'carrier-identity') continue;
        const d = event.data as { carrierId: unknown; name: unknown };
        if (typeof d.carrierId !== 'number' || typeof d.name !== 'string') continue;
        learnCarrier(ctx.state, d.carrierId, d.name);
        await ctx.saveCarrierIdentity(event);
        found = true;
      }

      if (found) {
        logger.info('journal', 'Learned carrier identities from history', {
          file: file.fileName,
        });
        // Re-resolve: we may already be docked at a carrier we just learned about.
        ctx.changed();
        return;
      }
    }
  } catch (err) {
    logger.warn('journal', 'Carrier identity backfill failed', { error: String(err) });
  }
}

/**
 * Recover Material Trader kinds from historical journals.
 *
 * Unlike the carrier backfill this does **not** stop at the first file that
 * yields something. Each station's kind was revealed by whenever the commander
 * happened to trade there, so the answers are scattered across the whole history
 * rather than concentrated in the newest file — in the corpus this was measured
 * at 29 distinct stations across 246 MaterialTrade events.
 *
 * Oldest file first, so if a station ever does report a different kind the most
 * recent observation is the one that survives.
 */
export async function backfillTraderIdentities(
  ctx: BackfillContext,
  directory: string,
  maxFiles = 200,
): Promise<void> {
  try {
    const files = (await listJournalFiles(directory, tauriFs)).filter((f) => f.sizeBytes > 0);
    const scan = files.slice(-maxFiles); // oldest -> newest
    let learned = 0;

    for (const file of scan) {
      const result = await replayFile(file.fullPath, tauriFs);
      for (const event of result.events) {
        if (event.kind !== 'trader-identity') continue;
        const d = event.data as { marketId: unknown; traderType: unknown };
        if (typeof d.marketId !== 'number' || typeof d.traderType !== 'string') continue;
        learnTrader(ctx.state, d.marketId, d.traderType);
        await ctx.saveTraderIdentity(event);
        learned += 1;
      }
    }

    if (learned > 0) {
      logger.info('journal', 'Learned material trader kinds from history', {
        trades: learned,
        stations: Object.keys(ctx.state.knownTraders).length,
      });
      // Re-resolve: we may already be docked at a trader we just identified.
      ctx.changed();
    }
  } catch (err) {
    logger.warn('journal', 'Material trader backfill failed', { error: String(err) });
  }
}

/**
 * Recover a pending carrier jump from recent journals.
 *
 * Applies the same three mutations the live reducer uses, so supersede, cancel
 * and arrival all resolve exactly as they would have live rather than being
 * re-derived here and drifting.
 *
 * Bounded to recent files: the countdown is about a quarter of an hour, and
 * anything already past is dropped on the way out.
 */
export async function backfillCarrierJumps(
  ctx: BackfillContext,
  directory: string,
  maxFiles = 10,
): Promise<void> {
  try {
    const files = (await listJournalFiles(directory, tauriFs)).filter((f) => f.sizeBytes > 0);

    for (const file of files.slice(-maxFiles)) {
      const result = await replayFile(file.fullPath, tauriFs);
      for (const event of result.events) {
        const d = event.data as { carrierId?: unknown; starSystem?: unknown };
        switch (event.kind) {
          case 'carrier-jump-request':
            recordCarrierJump(ctx.state, event.data, event.source.provenance.timestamp);
            break;
          case 'carrier-jump-cancelled':
            if (typeof d.carrierId === 'number') cancelCarrierJump(ctx.state, d.carrierId);
            break;
          case 'carrier-location':
            if (typeof d.carrierId === 'number' && typeof d.starSystem === 'string') {
              confirmCarrierAt(ctx.state, d.carrierId, d.starSystem);
            }
            break;
          default:
            break;
        }
      }
    }

    // Anything whose departure has already passed is history, not a countdown.
    const now = Date.now();
    for (const [id, jump] of Object.entries(ctx.state.carrierJumps)) {
      if (Date.parse(jump.departureTime) < now) delete ctx.state.carrierJumps[Number(id)];
    }

    const pending = Object.keys(ctx.state.carrierJumps).length;
    if (pending > 0) {
      logger.info('journal', 'Recovered a scheduled carrier jump from history', { pending });
      ctx.changed();
    }
  } catch (err) {
    logger.warn('journal', 'Carrier jump backfill failed', { error: String(err) });
  }
}

/**
 * Recover the confirmed-unsold exobiology count from recent journals.
 *
 * Without this the count starts at zero on every launch, so a commander who
 * scanned yesterday would be told nothing at Vista Genomics today — the same
 * unhelpfulness as the ungated rule, in the other direction.
 *
 * Cheaply bounded: the count only depends on events *since* the most recent sale
 * or death, so this walks backwards and stops at the first one it finds. If no
 * reset appears within `maxFiles`, the result is an undercount, which is the
 * correct direction for a figure documented as a lower bound.
 *
 * Runs after live ingest has started, so it takes the larger of the two rather
 * than clobbering what live events have already established.
 */
export async function backfillExobiologyHoldings(
  ctx: BackfillContext,
  directory: string,
  maxFiles = 25,
): Promise<void> {
  try {
    const files = (await listJournalFiles(directory, tauriFs)).filter((f) => f.sizeBytes > 0);
    const recent = files.slice(-maxFiles);

    let analysed = 0;
    // Newest file first, and within a file walk events in reverse, so the first
    // reset encountered is genuinely the most recent one.
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const result = await replayFile(recent[i]!.fullPath, tauriFs);
      let hitReset = false;

      for (let j = result.events.length - 1; j >= 0; j -= 1) {
        const event = result.events[j]!;
        if (event.kind === 'organic-sold' || event.kind === 'died') {
          hitReset = true;
          break;
        }
        if (event.kind !== 'organic-scan') continue;
        const d = event.data as { scanType: unknown };
        if (d.scanType === 'Analyse') analysed += 1;
      }

      if (hitReset) break;
    }

    if (analysed > ctx.state.exobiologyToSell) {
      ctx.state.exobiologyToSell = analysed;
      logger.info('journal', 'Recovered unsold exobiology count from history', {
        confirmedUnsold: analysed,
      });
      ctx.changed();
    }
  } catch (err) {
    logger.warn('journal', 'Exobiology holdings backfill failed', { error: String(err) });
  }
}
