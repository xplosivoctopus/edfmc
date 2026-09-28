/**
 * Deterministic condition evaluation.
 *
 * Same inputs always produce the same answer, and evaluation never throws: a
 * malformed rule yields `false`, never an exception that would take down ingest.
 */

import { isKnown, type CommanderState, type NormalizedEvent } from '@edfm/elite-journal';

import { RULE_LIMITS, type ComparisonOp, type Condition, type JsonPrimitive } from './types.js';

export interface EvaluationInput {
  readonly event: NormalizedEvent;
  readonly state: CommanderState;
}

/**
 * Whether a condition depends on the triggering event at all.
 *
 * Rules split into two kinds, and they must expire differently:
 *
 *  - **Event-triggered** ("you prospected an asteroid") describe a moment. They
 *    stay relevant for a while afterwards, so a TTL is the right model.
 *  - **State-scoped** ("this station has a Material Trader") describe a situation.
 *    They are true exactly while the situation holds, and a TTL is the *wrong*
 *    model: the Fleet Carrier context survived for its full 30 minutes after the
 *    commander had undocked and flown to an orbital station, cheerfully offering
 *    carrier links from a Coriolis.
 *
 * A rule with no `event` node anywhere in its condition is state-scoped.
 */
export function usesEvent(condition: Condition, depth = 0): boolean {
  if (depth > RULE_LIMITS.maxConditionDepth) return false;
  if (condition === null || typeof condition !== 'object') return false;

  switch (condition.kind) {
    case 'event':
      return true;
    case 'all':
    case 'any':
      return Array.isArray(condition.of) && condition.of.some((c) => usesEvent(c, depth + 1));
    case 'not':
      return usesEvent(condition.of, depth + 1);
    default:
      return false;
  }
}

/**
 * Read a dotted path out of an arbitrary object.
 *
 * Prototype keys are refused: rules are untrusted input, and `__proto__` or
 * `constructor` in a path must never reach into the prototype chain.
 */
/**
 * Several values gathered by a `*` segment. Any one of them matching satisfies the
 * comparison, which is what "this array contains something like X" means.
 */
class Gathered {
  constructor(readonly values: readonly unknown[]) {}
}

/**
 * Bounds on `*` traversal.
 *
 * Rule sets arrive from a server and from plugins, so a path must not be able to
 * buy unbounded work. Two stars at most, and at most this many values collected,
 * which caps the total regardless of how large the arrays are.
 */
const MAX_GATHERED = 64;
const MAX_STARS = 2;

function readPath(root: unknown, path: string): unknown {
  if (path.length === 0 || path.length > RULE_LIMITS.maxStringLength) return undefined;

  const segments = path.split('.');
  let stars = 0;
  for (const segment of segments) if (segment === '*') stars += 1;
  if (stars > MAX_STARS) return undefined;

  return walkPath(root, segments, 0);
}

function walkPath(root: unknown, segments: readonly string[], from: number): unknown {
  let current: unknown = root;

  for (let i = from; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    if (current === null || current === undefined) return undefined;

    // `*` means "any element". Needed because the useful thing about an array is
    // usually that it contains something, not what sits at a fixed index: a
    // planet's PlanetaryMiningLocation signal was observed at index 0, 1 and 2,
    // so `Signals.0.Type` would have found it only 18% of the time.
    if (segment === '*') {
      if (!Array.isArray(current)) return undefined;

      const gathered: unknown[] = [];
      for (const item of current) {
        const value =
          i + 1 === segments.length ? item : walkPath(item, segments, i + 1);

        if (value instanceof Gathered) gathered.push(...value.values);
        else if (value !== undefined) gathered.push(value);

        if (gathered.length >= MAX_GATHERED) break;
      }
      return new Gathered(gathered.slice(0, MAX_GATHERED));
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/** Unwrap the UNKNOWN sentinel so state comparisons see a plain value. */
function plain(value: unknown): unknown {
  if (typeof value === 'symbol') return undefined; // the UNKNOWN sentinel
  return value;
}

function compare(actual: unknown, op: ComparisonOp, expected: JsonPrimitive | undefined): boolean {
  // A `*` path yields several candidates; the condition holds if any one does.
  // An empty gather is false for every operator, `exists` included, which is the
  // honest reading of "the array had nothing to offer".
  if (actual instanceof Gathered) {
    return actual.values.some((v) => compareOne(v, op, expected));
  }
  return compareOne(actual, op, expected);
}

function compareOne(actual: unknown, op: ComparisonOp, expected: JsonPrimitive | undefined): boolean {
  const value = plain(actual);

  if (op === 'exists') return value !== undefined && value !== null;
  if (value === undefined || value === null) return false;

  switch (op) {
    case 'eq':
      return value === expected;
    case 'neq':
      return value !== expected;

    case 'contains':
      // Arrays contain elements; strings contain substrings. Both are useful and
      // unambiguous, so both are supported rather than inventing two operators.
      if (Array.isArray(value)) return value.includes(expected);
      return typeof value === 'string' && typeof expected === 'string' && value.includes(expected);

    case 'startsWith':
      return typeof value === 'string' && typeof expected === 'string' && value.startsWith(expected);
    case 'endsWith':
      return typeof value === 'string' && typeof expected === 'string' && value.endsWith(expected);

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof value !== 'number' || typeof expected !== 'number') return false;
      if (op === 'gt') return value > expected;
      if (op === 'gte') return value >= expected;
      if (op === 'lt') return value < expected;
      return value <= expected;
    }

    default:
      return false;
  }
}

/**
 * Evaluate a condition.
 *
 * `depth` bounds recursion so a deeply nested or self-referential rule set cannot
 * blow the stack.
 */
export function evaluate(condition: Condition, input: EvaluationInput, depth = 0): boolean {
  if (depth > RULE_LIMITS.maxConditionDepth) return false;
  if (condition === null || typeof condition !== 'object') return false;

  switch (condition.kind) {
    case 'event': {
      const name = input.event.source.event;
      return Array.isArray(condition.name)
        ? condition.name.includes(name)
        : condition.name === name;
    }

    case 'field':
      return compare(readPath(input.event.source.raw, condition.path), condition.op, condition.value);

    case 'state':
      return compare(readPath(input.state, condition.path), condition.op, condition.value);

    case 'service': {
      const services = input.state.stationServices;
      if (!isKnown(services)) return false;
      // Case-folded comparison: the raw array genuinely mixes cases.
      const wanted = condition.id.toLowerCase();
      return services.some((s) => s.id === wanted);
    }

    case 'all':
      return (
        Array.isArray(condition.of) &&
        condition.of.length > 0 &&
        condition.of.every((c) => evaluate(c, input, depth + 1))
      );

    case 'any':
      return Array.isArray(condition.of) && condition.of.some((c) => evaluate(c, input, depth + 1));

    case 'not':
      return !evaluate(condition.of, input, depth + 1);

    default:
      // An unrecognised condition kind is a rule set from a newer server than this
      // client. It must not match, and must not throw.
      return false;
  }
}
