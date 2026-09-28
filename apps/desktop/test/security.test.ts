/**
 * Guards on the desktop app's trust boundaries.
 *
 * These are configuration, which is exactly the sort of thing that rots without
 * anyone noticing: the packaged app shipped for weeks with a CSP that blocked
 * every request to the EDFM API, and nothing failed loudly because verification
 * is opt-in and off by default.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TAURI = join(__dirname, '..', 'src-tauri');

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const API_ORIGIN = 'https://api.edfieldmanual.com';

describe('WebView content security policy', () => {
  const conf = json(join(TAURI, 'tauri.conf.json'));
  const csp = String(
    ((conf['app'] as Record<string, unknown>)['security'] as Record<string, unknown>)['csp'],
  );

  it('declares connect-src explicitly', () => {
    // Tauri only ever appends script-src and style-src hashes of its own, so an
    // absent connect-src silently falls back to default-src 'self'. That is what
    // blocked the API in packaged builds.
    expect(csp).toContain('connect-src');
  });

  it('keeps the IPC origins reachable', () => {
    // Narrowing connect-src without these would break `invoke`, taking the
    // journal, the database and the overlay with it.
    expect(csp).toContain('ipc:');
    expect(csp).toContain('http://ipc.localhost');
  });

  it('does NOT name the EDFM API', () => {
    // Deliberate. API traffic goes through the HTTP plugin, so the web layer has
    // no business reaching the network directly. If this ever starts passing by
    // accident, the allowlist has silently moved from a native capability into a
    // CSP string, which is the weaker place for it.
    expect(csp).not.toContain(API_ORIGIN);
  });

  it('has no wildcard source anywhere', () => {
    expect(csp).not.toContain('*');
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

describe('capabilities', () => {
  const dir = join(TAURI, 'capabilities');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('grants HTTP only to the EDFM API, and only to the main window', () => {
    const main = json(join(dir, 'default.json'));
    expect(main['windows']).toEqual(['main']);

    const http = (main['permissions'] as unknown[]).find(
      (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['identifier'] === 'http:default',
    ) as Record<string, unknown> | undefined;

    expect(http, 'the main window needs scoped http:default').toBeDefined();
    const allow = http!['allow'] as Array<{ url: string }>;
    expect(allow).toEqual([{ url: `${API_ORIGIN}/*` }]);
  });

  it('never grants a bare http permission without a scope', () => {
    // `"http:default"` as a plain string would permit any URL.
    for (const f of files) {
      const perms = json(join(dir, f))['permissions'] as unknown[];
      for (const p of perms) {
        expect(
          typeof p === 'string' && p.startsWith('http:'),
          `${f} grants unscoped ${String(p)}`,
        ).toBe(false);
      }
    }
  });

  it('gives the overlay no network, filesystem, database or shell access', () => {
    // The overlay renders state pushed to it and must stay incapable of anything
    // else, so a future widget cannot quietly acquire reach.
    const overlay = json(join(dir, 'overlay.json'));
    expect(overlay['windows']).toEqual(['overlay']);
    const perms = (overlay['permissions'] as unknown[]).map((p) =>
      typeof p === 'string' ? p : String((p as Record<string, unknown>)['identifier']),
    );
    for (const p of perms) {
      expect(p.startsWith('core:'), `overlay should not hold ${p}`).toBe(true);
    }
    for (const forbidden of ['http:', 'sql:', 'fs:', 'shell:', 'opener:']) {
      expect(perms.some((p) => p.startsWith(forbidden))).toBe(false);
    }
  });
});
