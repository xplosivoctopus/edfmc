/**
 * Snapshot-identity guards for the value fed to `useSyncExternalStore`.
 *
 * React compares store snapshots by *reference*. Anything rebuilt on every call is
 * read as a state change on every render, and React aborts the whole tree with
 * "Maximum update depth exceeded" (#185).
 *
 * Not hypothetical: a `carrierJumps` getter that rebuilt its array shipped, and the
 * app failed to start — on an EMPTY list, because even `[]` was a fresh reference.
 * The fix was to route it through the already-cached `snapshot()` rather than add a
 * second cache, so identity is correct by construction.
 */

import { describe, expect, it } from 'vitest';
import type { CommanderState, PendingCarrierJump } from '@edfm/elite-journal';

import { Companion } from '../src/lib/companion.js';

/** The state is private; a test guarding an internal invariant may reach it. */
function stateOf(c: Companion): CommanderState {
  return (c as unknown as { state: CommanderState }).state;
}

/** notify() is what invalidates the cache in normal operation. */
function notify(c: Companion): void {
  (c as unknown as { notify(): void }).notify();
}

function jump(carrierId: number, system: string, msFromNow: number): PendingCarrierJump {
  return {
    carrierId,
    system,
    body: 'A' as PendingCarrierJump['body'],
    systemAddress: 1 as PendingCarrierJump['systemAddress'],
    departureTime: new Date(Date.now() + msFromNow).toISOString(),
    requestedAt: '2026-08-14T00:16:25Z',
  };
}

describe('snapshot identity', () => {
  it('is stable across repeated reads with nothing pending', () => {
    // The state the app starts in, and the one that actually broke it.
    const c = new Companion();
    expect(c.snapshot().carrierJumps).toHaveLength(0);
    // toBe, not toEqual: identity is the entire point.
    expect(c.snapshot()).toBe(c.snapshot());
    expect(c.snapshot().carrierJumps).toBe(c.snapshot().carrierJumps);
  });

  it('is stable across repeated reads with a jump pending', () => {
    const c = new Companion();
    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Wregoe JL-Q b46-0', 600_000);
    notify(c);

    const first = c.snapshot().carrierJumps;
    expect(first).toHaveLength(1);
    expect(c.snapshot().carrierJumps).toBe(first);
    expect(c.snapshot().carrierJumps).toBe(first);
  });

  it('refreshes once notified of a change', () => {
    // Stability must not become staleness.
    const c = new Companion();
    const before = c.snapshot();
    expect(before.carrierJumps).toHaveLength(0);

    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Leesti', 600_000);
    notify(c);

    const after = c.snapshot();
    expect(after).not.toBe(before);
    expect(after.carrierJumps).toHaveLength(1);
    expect(after.carrierJumps[0]!.system).toBe('Leesti');
  });
});

describe('carrier jump projection', () => {
  it('falls back to the id when the carrier has no remembered name', () => {
    const c = new Companion();
    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Leesti', 600_000);
    notify(c);
    expect(c.snapshot().carrierJumps[0]!.name).toBe('Carrier 3703420416');
  });

  it('uses the remembered name, which is itself the ownership proof', () => {
    // knownCarriers comes only from CarrierStats / CarrierNameChange / CarrierBuy,
    // which the game writes solely for carriers the commander commands.
    const c = new Companion();
    stateOf(c).knownCarriers[3703420416] = 'PFC Atlas Unbound';
    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Leesti', 600_000);
    notify(c);
    expect(c.snapshot().carrierJumps[0]!.name).toBe('PFC Atlas Unbound');
  });

  it('orders several carriers by whichever leaves first', () => {
    // This commander commands three.
    const c = new Companion();
    stateOf(c).carrierJumps[1] = jump(1, 'Later', 900_000);
    stateOf(c).carrierJumps[2] = jump(2, 'Sooner', 60_000);
    notify(c);
    expect(c.snapshot().carrierJumps.map((j) => j.system)).toEqual(['Sooner', 'Later']);
  });

  it('drops a departure long past rather than counting down forever', () => {
    // A commander offline through the jump may never see the CarrierLocation that
    // would have closed it out.
    const c = new Companion();
    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Leesti', -2 * 60 * 60 * 1000);
    notify(c);
    expect(c.snapshot().carrierJumps).toHaveLength(0);
  });

  it('keeps one that has only just passed, so it can read "departing"', () => {
    const c = new Companion();
    stateOf(c).carrierJumps[3703420416] = jump(3703420416, 'Leesti', -30_000);
    notify(c);
    expect(c.snapshot().carrierJumps).toHaveLength(1);
  });
});
