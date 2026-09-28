import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN } from '@edfm/elite-journal';
import { buildSubmission, createSubmitter } from '../src/submit.js';
import type { StationObservation } from '../src/types.js';

const observation = (over: Partial<StationObservation> = {}): StationObservation =>
  ({
    marketId: 128667761,
    stationName: 'Jaques Station',
    stationType: 'Orbis',
    starSystem: 'Colonia',
    systemAddress: 3238296097059,
    services: [
      { id: 'dock', raw: 'Dock' },
      { id: 'techbroker', raw: 'techBroker' },
    ],
    economies: [],
    stationFaction: 'Jaques',
    stationGovernment: 'Cooperative',
    allegiance: UNKNOWN,
    distFromStarLs: UNKNOWN,
    landingPads: UNKNOWN,
    channel: 'docked',
    observedAt: '2026-09-03T12:00:00Z',
    commander: 'Sythan',
    commanderFid: 'F1234567',
    gameVersion: '4.4.0.3',
    gameBuild: 'r330683/r0 ',
    sourceEventId: 'Journal.2026-09-03.log:4096',
    sourceEvent: 'Docked',
    ...over,
  }) as StationObservation;

function harness(
  responder: () => Response | Promise<Response>,
  opts: { enabled?: boolean; mode?: 'anonymous' | 'commander' } = {},
) {
  let enabled = opts.enabled ?? true;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return responder();
  });
  const submitter = createSubmitter({
    baseUrl: 'https://api.edfieldmanual.com/',
    isEnabled: () => enabled,
    identityMode: () => opts.mode ?? 'anonymous',
    clientVersion: '0.1.0',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { submitter, calls, fetchImpl, setEnabled: (v: boolean) => { enabled = v; } };
}

const ok = (body: unknown = { accepted: true, submissionId: '7', findings: 2 }) =>
  new Response(JSON.stringify(body), { status: 202, headers: { 'content-type': 'application/json' } });

describe('buildSubmission', () => {
  it('sends the observation, never a finding', () => {
    const body = buildSubmission(observation(), 'anonymous', '0.1.0');
    // A finding is a claim about what the reference says, which the client
    // cannot make: it does not hold the reference.
    expect(body).not.toHaveProperty('findings');
    expect(body).not.toHaveProperty('expected');
    expect(body.observation).toMatchObject({ marketId: '128667761', stationName: 'Jaques Station' });
  });

  it("preserves Frontier's own casing as evidence", () => {
    const body = buildSubmission(observation(), 'anonymous', '0.1.0');
    const obs = body.observation as Record<string, unknown>;
    // §9: comparison folds case, but any report must quote the raw token.
    expect(obs.servicesRaw).toEqual(['Dock', 'techBroker']);
  });

  it('turns "the game did not say" into null, never into a value', () => {
    const body = buildSubmission(observation(), 'anonymous', '0.1.0');
    const obs = body.observation as Record<string, unknown>;
    // allegiance is UNKNOWN here; a Known<T> sentinel must never be serialised.
    expect(JSON.stringify(body)).not.toContain('Symbol');
    expect(obs.stationType).toBe('Orbis');
  });

  it('withholds the commander name unless attribution was chosen', () => {
    const anon = buildSubmission(observation(), 'anonymous', '0.1.0');
    expect((anon.identity as Record<string, unknown>).commanderName).toBeNull();
    expect(JSON.stringify(anon)).not.toContain('Sythan');

    const named = buildSubmission(observation(), 'commander', '0.1.0');
    expect((named.identity as Record<string, unknown>).commanderName).toBe('Sythan');
  });

  it('sends the FID as a VALUE in both modes, because independence needs a distinguisher', () => {
    // Stated plainly because the documentation once claimed the opposite: the raw
    // FID goes over the wire, and the server hashes it on arrival and keeps only
    // the hash. Attribution is therefore a decision about credit rather than about
    // what is retained -- but the server does see the value. See docs/PRIVACY.md.
    for (const mode of ['anonymous', 'commander'] as const) {
      const body = buildSubmission(observation(), mode, '0.1.0');
      expect((body.identity as Record<string, unknown>).fid).toBe('F1234567');
    }
  });
});

describe('submit', () => {
  it('posts to the discrepancies endpoint and reports what the server derived', async () => {
    const { submitter, calls } = harness(() => ok());
    const outcome = await submitter.submit(observation());
    expect(calls[0]!.url).toBe('https://api.edfieldmanual.com/v1/discrepancies');
    expect(outcome).toEqual({ kind: 'accepted', submissionId: '7', findings: 2 });
  });

  it('makes no request at all while contribution is off', async () => {
    const { submitter, fetchImpl } = harness(() => ok(), { enabled: false });
    expect(await submitter.submit(observation())).toMatchObject({ kind: 'skipped' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops immediately when consent is revoked mid-session', async () => {
    const { submitter, fetchImpl, setEnabled } = harness(() => ok());
    await submitter.submit(observation());
    setEnabled(false);
    await submitter.submit(observation());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an observation with no stable identity', async () => {
    const { submitter, fetchImpl } = harness(() => ok());
    const outcome = await submitter.submit(observation({ marketId: Number.NaN }));
    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats being offline as retryable, not as a failure', async () => {
    const { submitter } = harness(() => {
      throw new TypeError('fetch failed');
    });
    expect(await submitter.submit(observation())).toMatchObject({ kind: 'unavailable' });
  });

  it('treats 429 and 5xx as retryable', async () => {
    for (const status of [429, 500, 503]) {
      const { submitter } = harness(() => new Response('{}', { status }));
      expect(await submitter.submit(observation())).toMatchObject({ kind: 'unavailable' });
    }
  });

  it('treats a 4xx as our mistake and does not ask to retry', async () => {
    const { submitter } = harness(
      () => new Response(JSON.stringify({ error: 'invalid request' }), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const outcome = await submitter.submit(observation());
    expect(outcome.kind).toBe('rejected');
  });

  it('does not resend a submission the server accepted but answered oddly', async () => {
    // It landed. Treating an unparseable success as a failure would duplicate
    // it on the next flush.
    const { submitter } = harness(() => new Response('not json', { status: 202 }));
    expect(await submitter.submit(observation())).toMatchObject({ kind: 'accepted' });
  });
});
