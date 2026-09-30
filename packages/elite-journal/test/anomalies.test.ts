/**
 * Tests for the structural anomaly ledger.
 *
 * Two properties matter more than the rest: it must not record field *values*,
 * and it must not report an absent field as a type change — the second would
 * bury the first real finding under every optional field in the journal.
 */

import { describe, expect, it } from 'vitest';

import {
  ANOMALY_LIMITS,
  AnomalyLedger,
  describeAnomaly,
  jsonTypeOf,
  type FieldAnomaly,
} from '../src/anomalies.js';

const at = (timestamp: string, gameVersion: string | null = '4.4.0.3') => ({
  timestamp,
  gameVersion,
});

/**
 * The first anomaly, or a failure.
 *
 * `noUncheckedIndexedAccess` is on, and an assertion here is better than a
 * non-null assertion: if the ledger reports nothing, the test should say "no
 * anomaly was recorded" rather than fail on a property of undefined.
 */
function only(list: readonly FieldAnomaly[]): FieldAnomaly {
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  if (!first) throw new Error('no anomaly recorded');
  return first;
}

describe('jsonTypeOf', () => {
  it('names every JSON shape, keeping null and array distinct from object', () => {
    expect(jsonTypeOf('x')).toBe('string');
    expect(jsonTypeOf(1)).toBe('number');
    expect(jsonTypeOf(false)).toBe('boolean');
    // Both are `typeof 'object'`, and conflating them would make an array/object
    // change invisible -- which is exactly the change worth reporting.
    expect(jsonTypeOf(null)).toBe('null');
    expect(jsonTypeOf([])).toBe('array');
    expect(jsonTypeOf({})).toBe('object');
  });
});

describe('learning a baseline', () => {
  it('reports nothing from a consistent journal', () => {
    const led = new AnomalyLedger();
    for (let i = 0; i < 20; i += 1) {
      led.observe('Scan', { BodyName: 'Nervi 2', BodyID: 3 }, at('2026-09-01T00:00:00Z'));
    }
    expect(led.anomalies()).toEqual([]);
    expect(led.eventsTracked).toBe(1);
    expect(led.fieldsTracked).toBe(2);
  });

  it('reports a field whose type changed, with both types and the build', () => {
    const led = new AnomalyLedger();
    led.observe('Scan', { BodyID: 3 }, at('2026-09-01T00:00:00Z', '4.4.0.3'));
    led.observe('Scan', { BodyID: '3' }, at('2026-09-02T00:00:00Z', '4.5.0.0'));

    const a = only(led.anomalies());
    expect(a.event).toBe('Scan');
    expect(a.field).toBe('BodyID');
    expect(a.expected).toBe('number');
    expect(a.observed).toBe('string');
    expect(a.count).toBe(1);
    expect(a.baselineBuild).toBe('4.4.0.3');
    expect(a.observedBuild).toBe('4.5.0.0');
    expect(a.firstSeenAt).toBe('2026-09-02T00:00:00Z');
  });

  it('counts repeats rather than listing them', () => {
    const led = new AnomalyLedger();
    led.observe('Scan', { BodyID: 3 }, at('2026-09-01T00:00:00Z'));
    for (let i = 0; i < 5; i += 1) {
      led.observe('Scan', { BodyID: '3' }, at(`2026-09-0${i + 2}T00:00:00Z`));
    }
    const a = only(led.anomalies());
    expect(a.count).toBe(5);
    expect(a.lastSeenAt).toBe('2026-09-06T00:00:00Z');
    expect(led.anomalies()).toHaveLength(1);
  });

  it('does not treat an absent field as a change', () => {
    /*
     * The important negative. Most journal fields are optional, so counting
     * absence as a type change would produce thousands of findings and bury the
     * one that mattered.
     */
    const led = new AnomalyLedger();
    led.observe('Docked', { StationName: 'Jameson', Taxi: false }, at('2026-09-01T00:00:00Z'));
    led.observe('Docked', { StationName: 'Jameson' }, at('2026-09-02T00:00:00Z'));
    expect(led.anomalies()).toEqual([]);
  });

  it('distinguishes null from absent', () => {
    // A field explicitly set to null IS a change: the game said something, and
    // what it said differs from before.
    const led = new AnomalyLedger();
    led.observe('Docked', { StationName: 'Jameson' }, at('2026-09-01T00:00:00Z'));
    led.observe('Docked', { StationName: null }, at('2026-09-02T00:00:00Z'));
    const a = only(led.anomalies());
    expect(a.expected).toBe('string');
    expect(a.observed).toBe('null');
  });

  it('ignores the envelope fields', () => {
    const led = new AnomalyLedger();
    led.observe('Scan', { event: 'Scan', timestamp: '2026-09-01T00:00:00Z' }, at('x'));
    expect(led.fieldsTracked).toBe(0);
  });

  it('keeps events separate', () => {
    // `Name` means different things in different events; a baseline shared
    // across event types would invent anomalies.
    const led = new AnomalyLedger();
    led.observe('Alpha', { Name: 'x' }, at('2026-09-01T00:00:00Z'));
    led.observe('Beta', { Name: 7 }, at('2026-09-01T00:00:00Z'));
    expect(led.anomalies()).toEqual([]);
  });

  it('sorts the most frequent first', () => {
    const led = new AnomalyLedger();
    led.observe('E', { a: 1, b: 1 }, at('2026-09-01T00:00:00Z'));
    led.observe('E', { a: 'x' }, at('2026-09-02T00:00:00Z'));
    for (let i = 0; i < 3; i += 1) led.observe('E', { b: 'x' }, at('2026-09-03T00:00:00Z'));
    expect(led.anomalies().map((a) => a.field)).toEqual(['b', 'a']);
  });
});

describe('what it refuses to store', () => {
  it('never retains a field value', () => {
    /*
     * The property that keeps this panel safe to screenshot. Journal fields
     * carry system names, station names, credit balances and commander names,
     * and a diagnostics view is exactly the thing that ends up attached to a bug
     * report.
     */
    const secretish = 'Shinrarta Dezhra';
    const led = new AnomalyLedger();
    led.observe('Location', { StarSystem: 1 }, at('2026-09-01T00:00:00Z'));
    led.observe('Location', { StarSystem: secretish }, at('2026-09-02T00:00:00Z'));

    const serialised = JSON.stringify(led.anomalies());
    expect(serialised).not.toContain(secretish);
    expect(serialised).toContain('StarSystem');
    expect(describeAnomaly(only(led.anomalies()))).not.toContain(secretish);
  });
});

describe('bounds', () => {
  it('stops tracking new events at the cap and says it truncated', () => {
    const led = new AnomalyLedger();
    for (let i = 0; i < ANOMALY_LIMITS.maxEvents + 10; i += 1) {
      led.observe(`Event${i}`, { a: 1 }, at('2026-09-01T00:00:00Z'));
    }
    expect(led.eventsTracked).toBe(ANOMALY_LIMITS.maxEvents);
    expect(led.truncatedCount).toBe(10);
  });

  it('caps fields per event', () => {
    const led = new AnomalyLedger();
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < ANOMALY_LIMITS.maxFieldsPerEvent + 5; i += 1) wide[`f${i}`] = 1;
    led.observe('Wide', wide, at('2026-09-01T00:00:00Z'));
    expect(led.fieldsTracked).toBe(ANOMALY_LIMITS.maxFieldsPerEvent);
    expect(led.truncatedCount).toBe(5);
  });

  it('caps the number of distinct anomalies', () => {
    const led = new AnomalyLedger();
    const n = ANOMALY_LIMITS.maxAnomalies + 20;
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    for (let i = 0; i < n; i += 1) {
      first[`f${i}`] = 1;
      second[`f${i}`] = 'x';
    }
    // One event, many fields: needs the per-event cap raised out of the way to
    // exercise the anomaly cap itself.
    for (let i = 0; i < n; i += 1) {
      led.observe(`E${i}`, { f: 1 }, at('2026-09-01T00:00:00Z'));
      led.observe(`E${i}`, { f: 'x' }, at('2026-09-02T00:00:00Z'));
    }
    expect(led.anomalies().length).toBeLessThanOrEqual(ANOMALY_LIMITS.maxAnomalies);
  });
});

describe('describeAnomaly', () => {
  it('reads as a sentence a person could paste into a report', () => {
    const led = new AnomalyLedger();
    led.observe('Scan', { BodyID: 3 }, at('2026-09-01T00:00:00Z', '4.4.0.3'));
    led.observe('Scan', { BodyID: '3' }, at('2026-09-02T00:00:00Z', '4.5.0.0'));
    const line = describeAnomaly(only(led.anomalies()));
    expect(line).toContain('Scan.BodyID');
    expect(line).toContain('expected number');
    expect(line).toContain('saw string');
    expect(line).toContain('4.5.0.0');
    expect(line).toContain('1 time');
  });
});
