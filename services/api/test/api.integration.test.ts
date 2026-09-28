/**
 * End-to-end against a real PostgreSQL.
 *
 * The claims worth proving here cannot be proved by unit tests: deduplication,
 * independence scoring and notify-once are enforced by primary keys and by SQL
 * running across transactions, not by application logic.
 *
 *   set EDFM_TEST_DSN=postgresql://postgres:<password>@localhost/edfm_test
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, migrate, type Db } from '../src/lib/db.js';
import type { PendingNotification } from '../src/lib/store.js';

const DSN = process.env.EDFM_TEST_DSN;
const run = DSN ? describe : describe.skip;

// Same guard as the worker suite, and for the same reason: these tests
// TRUNCATE. Pointed at the development database while the EDDN worker was
// ingesting into it, they wiped the stations table mid-run. Only a database
// named for testing is accepted -- "dev" is not good enough, because dev is
// where the real ingest lands.
if (DSN && !/(^|[_-])test($|[_-])/.test(new URL(DSN).pathname.slice(1))) {
  throw new Error(
    `EDFM_TEST_DSN names ${new URL(DSN).pathname.slice(1)}, which is not a test database. ` +
      'This suite TRUNCATEs tables; use edfm_test.',
  );
}

const SALT = 'a'.repeat(64);

const config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: DSN ?? '',
  identitySalt: SALT,
  discordWebhook: undefined,
  discordEnabled: false,
  discordSpoilerPolicy: 'suppress',
  discordPostResolutions: true,
  discordIncludeCommander: false,
  discordTagsRaw: undefined,
  adminToken: undefined,
  rateLimitPerMinute: 100000,
  trustProxy: 'loopback',
  env: 'test',
} as const;

let db: Db;
let app: FastifyInstance;
let sent: PendingNotification[] = [];

interface Overrides {
  observation?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  claimed?: unknown;
}

function submission(over: Overrides = {}) {
  return {
    observation: {
      marketId: '900001',
      stationName: 'Elder Hub',
      stationType: 'Orbis',
      systemName: 'Mundii',
      systemAddress: '900099',
      servicesRaw: ['Dock', 'Commodities', 'Refuel'],
      observedAt: '2026-09-02T12:00:00Z',
      sourceEvent: 'Docked',
      sourceEventId: 'Journal.2026-09-02.log:1024',
      gameVersion: '4.1.2',
      gameBuild: 'r300000',
      sessionKey: 'Journal.2026-09-02.log',
      ...over.observation,
    },
    identity: {
      mode: 'anonymous',
      fid: 'F1',
      commanderName: 'Alpha',
      journalFile: 'j1',
      ...over.identity,
    },
    clientVersion: '0.1.0',
    ...(over.claimed === undefined ? {} : { claimed: over.claimed }),
  };
}

const post = (body: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/v1/discrepancies', payload: body });

const notifier = { async send(p: PendingNotification) { sent.push(p); } };

run('API', () => {
  beforeEach(async () => {
    db ??= createPool(DSN!);
    await migrate(db, ['../eddn-worker/migrations', './migrations']);
    // CASCADE reaches further than it looks: it also empties every table with
    // a foreign key to these, which includes discord_reports. That is fine
    // here -- but it is why vitest.config.ts disables file parallelism, since
    // running alongside the reporter suite would wipe its rows mid-test.
    await db.query(
      'TRUNCATE submissions, discrepancies, discrepancy_reports, discrepancy_notifications,' +
        ' stations, systems RESTART IDENTITY CASCADE',
    );
    // A reference station that disagrees with the observation above in both
    // directions: it lacks Refuel, and has a techBroker the game will not report.
    await db.query(
      `INSERT INTO stations (market_id, name, station_type, system_name, is_fleet_carrier,
                             is_planetary, service_ids, services_raw, observed_at)
       VALUES (900001, 'Elder Hub', 'Orbis', 'Mundii', false, false,
               ARRAY['dock','commodities','techbroker'],
               ARRAY['Dock','Commodities','techBroker'],
               '2026-09-01T00:00:00Z')`,
    );

    sent = [];
    app = await buildApp({ config, db, notifier });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('serves reference data the client cannot otherwise obtain', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reference/stations/900001' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      marketId: '900001',
      source: 'eddn-aggregate',
      serviceIds: ['dock', 'commodities', 'techbroker'],
      servicesRaw: ['Dock', 'Commodities', 'techBroker'],
    });
  });

  it('distinguishes an unobserved station from a nonexistent one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reference/stations/424242' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not observed');
  });

  it('derives findings server-side and ignores what the client claims', async () => {
    const res = await post(
      submission({ claimed: [{ field: 'stationType', expected: 'Coriolis', observed: 'Outpost' }] }),
    );
    expect(res.statusCode).toBe(202);
    // Refuel extra + techbroker missing = 2. The client's claim contributed none.
    expect(res.json().findings).toBe(2);

    const { rows } = await db.query('SELECT field, kind FROM discrepancies ORDER BY field');
    expect(rows).toEqual([
      { field: 'service:refuel', kind: 'missing_in_edfm' },
      { field: 'service:techbroker', kind: 'missing_in_game' },
    ]);
  });

  it('stores the claim for diagnosis without acting on it', async () => {
    await post(submission({ claimed: { note: 'client thought something else' } }));
    const { rows } = await db.query<{ claimed: unknown }>('SELECT claimed FROM submissions');
    expect(rows[0]!.claimed).toEqual({ note: 'client thought something else' });
  });

  it('never stores a raw commander identifier', async () => {
    await post(
      submission({
        identity: {
          mode: 'commander',
          fid: 'F7654321',
          commanderName: 'Hadfield',
          journalFile: 'Journal.private.log',
        },
      }),
    );
    const { rows } = await db.query('SELECT * FROM submissions');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('F7654321');
    expect(dump).not.toContain('Hadfield');
    expect(dump).not.toContain('Journal.private.log');
    // The distinguishers must still be there, or independence cannot be scored.
    expect(rows[0]).toMatchObject({ identity_mode: 'commander' });
    expect((rows[0] as Record<string, unknown>).fid_hash).toEqual(expect.any(String));
  });

  it('collapses the same commander reporting twice into one confirmation', async () => {
    await post(submission());
    await post(submission({ observation: { sourceEventId: 'Journal.2026-09-02.log:2048' } }));

    const { rows } = await db.query<{ report_count: number; independent_count: number }>(
      "SELECT report_count, independent_count FROM discrepancies WHERE field = 'service:refuel'",
    );
    expect(rows[0]).toEqual({ report_count: 2, independent_count: 1 });
  });

  it('counts a genuinely different commander as independent and moves to review', async () => {
    await post(submission());
    await post(
      submission({ identity: { fid: 'F2', commanderName: 'Beta', journalFile: 'j2' } }),
    );

    const { rows } = await db.query<{ independent_count: number; status: string }>(
      "SELECT independent_count, status FROM discrepancies WHERE field = 'service:refuel'",
    );
    expect(rows[0]).toEqual({ independent_count: 2, status: 'under_review' });
  });

  it('notifies once on creation and once on first independent confirmation', async () => {
    await post(submission());
    expect(sent.filter((n) => n.reason === 'created')).toHaveLength(2); // two findings

    // The same commander again must not produce a second alert.
    await post(submission());
    expect(sent).toHaveLength(2);

    await post(submission({ identity: { fid: 'F2', commanderName: 'Beta', journalFile: 'j2' } }));
    expect(sent.filter((n) => n.reason === 'confirmed')).toHaveLength(2);

    // A third independent report stays silent: thirty users is still one finding.
    await post(submission({ identity: { fid: 'F3', commanderName: 'Gamma', journalFile: 'j3' } }));
    expect(sent).toHaveLength(4);
  });

  it('survives a restart without re-notifying', async () => {
    await post(submission());
    const before = sent.length;
    await app.close();
    app = await buildApp({ config, db, notifier });
    await post(submission());
    expect(sent).toHaveLength(before);
  });

  it('rejects a submission that is not shaped like an observation', async () => {
    expect((await post({ observation: {}, identity: { mode: 'anonymous' } })).statusCode).toBe(400);
    // mode 'commander' without a name is a contradiction, not a default.
    expect(
      (await post({ ...submission(), identity: { mode: 'commander' } })).statusCode,
    ).toBe(400);
    // An unbounded array is a memory endpoint, not a submission.
    expect(
      (await post(submission({ observation: { servicesRaw: Array(500).fill('dock') } })))
        .statusCode,
    ).toBe(400);
  });

  it('never returns the salt or the webhook from any endpoint', async () => {
    for (const url of ['/v1/health', '/v1/stats', '/v1/reference/stations/900001']) {
      const body = (await app.inject({ method: 'GET', url })).body;
      expect(body).not.toContain(SALT);
      expect(body.toLowerCase()).not.toContain('webhook');
    }
  });
});
