/** HTTP surface. */

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import type { Db } from './lib/db.js';
import { hashIdentity } from './lib/identity.js';
import { getStation, getStations } from './lib/reference.js';
import { deriveStationFindings } from './lib/derive.js';
import { recordSubmission } from './lib/store.js';
import type { Notifier } from './lib/discord/notifier.js';
import type { DiscordReporter } from './lib/discord/reporter.js';
import { secretEquals } from './lib/identity.js';
import { lookupSchema, marketSearchSchema, submissionSchema } from './schema.js';
import { searchMarkets } from './lib/market.js';

export interface AppOptions {
  readonly config: Config;
  readonly db: Db;
  readonly notifier: Notifier;
  /** Optional: administrative Discord actions are unavailable without it. */
  readonly reporter?: DiscordReporter;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, db, notifier, reporter } = options;

  const app = Fastify({
    logger: config.env !== 'test',
    // A station observation is a few hundred bytes. Anything approaching this
    // is not a submission.
    bodyLimit: 64 * 1024,
    // Never `true`. See config.trustProxy: believing X-Forwarded-For from any
    // peer lets a remote client choose the identity that rate limiting and
    // flood detection are keyed on.
    trustProxy: config.trustProxy,
  });

  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
  });

  app.get('/v1/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, version: '0.1.0' };
  });

  /* ------------------------------------------------------------ reference */

  app.get<{ Params: { marketId: string } }>('/v1/reference/stations/:marketId', async (req, reply) => {
    if (!/^\d{1,20}$/.test(req.params.marketId)) {
      return reply.code(400).send({ error: 'marketId must be a positive integer id' });
    }
    const station = await getStation(db, req.params.marketId);
    // 404 means "no observation of this station", not "no such station".
    // The client must not turn an absence into a finding.
    if (!station) return reply.code(404).send({ error: 'not observed' });
    return station;
  });

  app.post('/v1/reference/stations/lookup', async (req, reply) => {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', detail: parsed.error.issues });
    }
    const stations = await getStations(db, parsed.data.marketIds);
    return { stations, requested: parsed.data.marketIds.length, returned: stations.length };
  });

  /* ------------------------------------------------------------ market */

  /**
   * Candidate markets for a sourcing plan (§16).
   *
   * The server filters and ranks; the client plans. Keeping the planning in the
   * client means the reasoning stays where the commander can inspect it, and
   * changing how plans are built does not require a deployment.
   */
  app.post('/v1/market/search', async (req, reply) => {
    const parsed = marketSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', detail: parsed.error.issues });
    }
    const candidates = await searchMarkets(db, parsed.data);
    return {
      candidates,
      stations: candidates.length,
      offers: candidates.reduce((n, c) => n + c.offers.length, 0),
    };
  });

  /* -------------------------------------------------------- submission */

  app.post('/v1/discrepancies', async (req, reply) => {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', detail: parsed.error.issues });
    }
    const { observation, identity, clientVersion, claimed } = parsed.data;

    const reference = await getStation(db, observation.marketId);
    const derived = deriveStationFindings(
      {
        ...observation,
        companionVersion: clientVersion ?? 'unknown',
        // The comparison never sees the identifiers; only the hashes are
        // stored, and provenance on a server-derived observation is the
        // submission row, not the commander.
        commander: null,
        commanderFid: null,
      },
      reference,
    );

    const result = await recordSubmission(
      db,
      {
        identity: hashIdentity(config.identitySalt, {
          mode: identity.mode,
          fid: identity.fid ?? undefined,
          commanderName: identity.commanderName ?? undefined,
          journalFile: identity.journalFile ?? undefined,
        }),
        entityType: 'station',
        entityId: observation.marketId,
        clientVersion,
        gameVersion: observation.gameVersion,
        gameBuild: observation.gameBuild,
        observation,
        claimed,
        sourceHash: hashSource(req.ip, config.identitySalt),
      },
      derived.findings,
    );

    // Delivery is deliberately outside the transaction and not awaited by the
    // response: the submission is already durable, and a slow webhook must not
    // become the commander's latency.
    for (const pending of result.notifications) {
      void notifier.send(pending).catch(() => {});
    }

    return reply.code(202).send({
      accepted: true,
      submissionId: result.submissionId,
      // Says what the server derived, so a client whose local comparison
      // disagrees can be debugged instead of quietly diverging.
      findings: result.discrepancies.length,
      skipped: derived.skipped,
    });
  });

  /* -------------------------------------------------------------- admin */

  /**
   * Administrative actions.
   *
   * Registered only when a token is configured, so an unconfigured deployment
   * has no such route rather than an unprotected one. These can post to a live
   * Discord channel, which is why they are not reachable from the desktop
   * client: the client is untrusted and must never hold a credential that can
   * write to the channel (§19).
   */
  if (config.adminToken !== undefined && reporter !== undefined) {
    const token = config.adminToken;

    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/v1/admin/')) return;
      const header = req.headers['x-edfm-admin-token'];
      // Constant-time: a length-or-prefix comparison here is a guessing oracle.
      if (typeof header !== 'string' || !secretEquals(header, token)) {
        return reply.code(404).send({ error: 'not found' });
      }
    });

    app.post('/v1/admin/discord/test', async () => {
      const outcome = await reporter.test();
      // The outcome kind only; a detail string could carry a URL.
      return { outcome: outcome.kind };
    });

    app.post('/v1/admin/discord/flush', async () => reporter.processQueue(25));
  }

  /* -------------------------------------------------------------- stats */

  app.get('/v1/stats', async () => {
    const { rows } = await db.query<Record<string, string>>(`
      SELECT (SELECT count(*) FROM stations)::text          AS stations,
             (SELECT count(*) FROM market_latest)::text     AS market_rows,
             (SELECT count(*) FROM submissions)::text       AS submissions,
             (SELECT count(*) FROM discrepancies)::text     AS discrepancies,
             (SELECT count(*) FROM discrepancies
               WHERE independent_count >= 2)::text          AS confirmed`);
    // Aggregates only. A per-discrepancy list here would need spoiler gating;
    // a total cannot identify a location.
    return rows[0];
  });

  return app;
}

/**
 * Coarse client fingerprint for abuse tracing.
 *
 * Keyed and truncated: enough to notice one source flooding the endpoint,
 * not enough to be a stored IP address.
 */
function hashSource(ip: string | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}:ip:${ip}`).digest('hex').slice(0, 16);
}
