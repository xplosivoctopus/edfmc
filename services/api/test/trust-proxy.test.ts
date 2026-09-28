/**
 * Proxy trust, which decides whose word `req.ip` takes.
 *
 * This is not a theoretical concern here. `req.ip` is the rate limiter's key and
 * the input to the stored `sourceHash`, so both of the controls that exist to
 * notice one source flooding the endpoint are keyed on it. The service ran with
 * `trustProxy: true`, which believes `X-Forwarded-For` from whoever sends it —
 * meaning a remote client could pick its own identity for both.
 *
 * Needs no database: a stub answers the one query `/v1/health` makes.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const CONFIG: Config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://unused',
  identitySalt: 'x'.repeat(64),
  discordWebhook: undefined,
  discordEnabled: false,
  discordSpoilerPolicy: 'suppress',
  discordPostResolutions: false,
  discordIncludeCommander: false,
  discordTagsRaw: undefined,
  adminToken: undefined,
  rateLimitPerMinute: 100000,
  trustProxy: 'loopback',
  env: 'test',
} as unknown as Config;

/** Enough of a pg client for `/v1/health`. */
const DB = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as never;

/**
 * Build the app and capture the IP it resolves for each request.
 *
 * A hook rather than a route, so this observes exactly what the real handlers
 * would see rather than a parallel implementation of the same logic.
 */
async function harness(trustProxy: string | boolean): Promise<{
  app: FastifyInstance;
  ipFor: (headers: Record<string, string>, remoteAddress: string) => Promise<string>;
}> {
  const app = await buildApp({
    config: { ...CONFIG, trustProxy },
    db: DB,
    notifier: undefined as never,
  } as never);

  let seen = '';
  app.addHook('onRequest', async (req) => {
    seen = req.ip;
  });

  return {
    app,
    async ipFor(headers, remoteAddress) {
      await app.inject({ method: 'GET', url: '/v1/health', headers, remoteAddress });
      return seen;
    },
  };
}

describe('trustProxy', () => {
  it('uses the socket address when no proxy header is present', async () => {
    const { app, ipFor } = await harness('loopback');
    expect(await ipFor({}, '203.0.113.7')).toBe('203.0.113.7');
    await app.close();
  });

  it('ignores X-Forwarded-For from a peer that is not the trusted proxy', async () => {
    // The attack. A remote client claims to be someone else; with `trustProxy:
    // true` this returned the claimed address, handing the attacker control of
    // the rate-limit key and the stored source hash.
    const { app, ipFor } = await harness('loopback');
    const ip = await ipFor({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.7');
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe('1.2.3.4');
    await app.close();
  });

  it('believes X-Forwarded-For when the peer IS the loopback proxy', async () => {
    // The documented topology: nginx terminates TLS on the box and proxies to
    // 127.0.0.1, so its header is the only account of the real client.
    const { app, ipFor } = await harness('loopback');
    expect(await ipFor({ 'x-forwarded-for': '198.51.100.22' }, '127.0.0.1')).toBe('198.51.100.22');
    await app.close();
  });

  it('takes the client-facing hop when a chain arrives from the proxy', async () => {
    // nginx's $proxy_add_x_forwarded_for appends the peer to whatever the client
    // sent, so a chain can contain attacker-chosen entries. The rightmost
    // untrusted entry is the one nginx itself observed.
    const { app, ipFor } = await harness('loopback');
    const ip = await ipFor({ 'x-forwarded-for': '9.9.9.9, 198.51.100.22' }, '127.0.0.1');
    expect(ip).toBe('198.51.100.22');
    await app.close();
  });

  it('demonstrates the vulnerability the old setting had', async () => {
    // Not a guard on shipped behaviour but a record of what was wrong, and a
    // canary: if Fastify's semantics ever change so that `true` stops being
    // spoofable, the reasoning behind the narrow default deserves rechecking.
    const { app, ipFor } = await harness(true);
    expect(await ipFor({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.7')).toBe('1.2.3.4');
    await app.close();
  });

  it('never ships with proxy trust wide open', async () => {
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({
      EDFM_DATABASE_URL: 'postgresql://x',
      EDFM_IDENTITY_SALT: 'x'.repeat(64),
    } as NodeJS.ProcessEnv);
    expect(config.trustProxy).toBe('loopback');
    expect(config.trustProxy).not.toBe(true);
  });
});
