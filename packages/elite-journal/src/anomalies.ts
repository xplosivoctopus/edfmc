/**
 * Structural anomalies in the journal: a field whose type changed.
 *
 * ## What this is for
 *
 * When Frontier changes a field's shape, this project's normalizers do the safe
 * thing and return `UNKNOWN` — the observation is preserved in `source.raw`, and
 * nothing crashes. That safety has a cost: the change is **silent**. A field that
 * used to be a number and is now a string simply reads as "the game did not say"
 * forever, and the first sign of trouble is a feature that has quietly stopped
 * working.
 *
 * This records those transitions so they can be seen.
 *
 * ## The baseline is learned, not declared
 *
 * There is no table of expected types here, on purpose. A hand-written schema
 * would be a set of assumptions about 300+ event types, and this project has
 * repeatedly measured its way to findings that contradicted the obvious reading
 * of an event name. So the *first* type observed for a field becomes the
 * baseline, and only a later disagreement is reported. That cannot encode a
 * wrong assumption, because it never asserts anything the journal did not show.
 *
 * The trade-off, stated rather than hidden: a field that is legitimately
 * polymorphic will be reported once and is not a defect. The report says "this
 * changed", which is true, and leaves the judgement to a person. No such field
 * appears in the local corpus -- see the note on limits below -- so this is a
 * possibility being acknowledged, not an observed problem.
 *
 * ## Types only, never values
 *
 * Nothing here stores a field's contents — only the name of its JSON type. A
 * diagnostics panel is the kind of thing that ends up in a screenshot attached
 * to a bug report, and journal fields contain system names, station names,
 * credit balances and commander names. `"number"` is all that is needed to
 * describe the problem, so `"number"` is all that is kept. A test asserts this.
 */

/** The JSON shapes a journal field can take. */
export type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  // `undefined`, functions and symbols cannot appear in parsed JSON. Anything
  // else that reaches here is an object.
  return 'object';
}

/** One field that has been seen with more than one type. */
export interface FieldAnomaly {
  readonly event: string;
  readonly field: string;
  /** The first type observed for this field; the learned baseline. */
  readonly expected: JsonType;
  /** The differing type most recently observed. */
  readonly observed: JsonType;
  /** How many times a value disagreed with the baseline. */
  readonly count: number;
  /** Game version in force when the baseline was set, when one was known. */
  readonly baselineBuild: string | null;
  /** Game version in force at the most recent disagreement. */
  readonly observedBuild: string | null;
  /** Journal timestamps, verbatim. */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * Bounds.
 *
 * A journal is untrusted input in the sense that matters here: its shape is not
 * under this project's control, and a malformed or hostile file must not be able
 * to grow this ledger without limit. Every map is capped.
 *
 * The caps are set from measurement, not taste. Across the local corpus -- 303
 * files, 289,725 events -- the ledger tracked **212 distinct event names and
 * 1,194 distinct fields**, and hit no cap.
 *
 * That same run found **zero anomalies**, which is the more useful finding: the
 * journal is type-stable across this corpus, so an empty panel is the expected
 * state and a populated one is worth reading. A detector that fired constantly
 * would be ignored within a week.
 */
export const ANOMALY_LIMITS = {
  /** Distinct event names tracked. */
  maxEvents: 512,
  /** Fields remembered per event. */
  maxFieldsPerEvent: 96,
  /** Distinct anomalies retained. */
  maxAnomalies: 256,
} as const;

export interface AnomalyProvenance {
  readonly gameVersion: string | null;
  /** Journal timestamp, verbatim. */
  readonly timestamp: string;
}

/**
 * Accumulates baselines and disagreements.
 *
 * Top-level fields only. Recursing would multiply the key space by the depth of
 * every nested array of factions and materials for a diagnostic that is meant to
 * point at a problem, not enumerate it — and the events this project reads
 * carry the fields that matter at the top level.
 */
export class AnomalyLedger {
  /** event -> field -> baseline type and the build that set it. */
  private readonly baseline = new Map<
    string,
    Map<string, { readonly type: JsonType; readonly build: string | null }>
  >();

  /** `event\u0000field` -> anomaly. */
  private readonly found = new Map<string, FieldAnomaly>();

  /** Fields dropped because a cap was reached, so the panel can say so. */
  private truncated = 0;

  observe(
    eventName: string,
    raw: Readonly<Record<string, unknown>>,
    provenance: AnomalyProvenance,
  ): void {
    let fields = this.baseline.get(eventName);
    if (!fields) {
      if (this.baseline.size >= ANOMALY_LIMITS.maxEvents) {
        this.truncated += 1;
        return;
      }
      fields = new Map();
      this.baseline.set(eventName, fields);
    }

    for (const [field, value] of Object.entries(raw)) {
      // `event` and `timestamp` are the envelope, not data, and are already
      // validated upstream.
      if (field === 'event' || field === 'timestamp') continue;

      const type = jsonTypeOf(value);
      const known = fields.get(field);

      if (!known) {
        if (fields.size >= ANOMALY_LIMITS.maxFieldsPerEvent) {
          this.truncated += 1;
          continue;
        }
        fields.set(field, { type, build: provenance.gameVersion });
        continue;
      }

      if (known.type === type) continue;

      /*
       * A field going absent is reported as `null` by nothing here: an absent
       * field simply does not appear in `Object.entries`, and treating its
       * absence as a type change would flood the ledger with every optional
       * field in the journal. Only a field that is *present with a different
       * type* is an anomaly.
       */
      const key = `${eventName}\u0000${field}`;
      const prior = this.found.get(key);
      if (prior) {
        this.found.set(key, {
          ...prior,
          observed: type,
          count: prior.count + 1,
          observedBuild: provenance.gameVersion,
          lastSeenAt: provenance.timestamp,
        });
        continue;
      }

      if (this.found.size >= ANOMALY_LIMITS.maxAnomalies) {
        this.truncated += 1;
        continue;
      }

      this.found.set(key, {
        event: eventName,
        field,
        expected: known.type,
        observed: type,
        count: 1,
        baselineBuild: known.build,
        observedBuild: provenance.gameVersion,
        firstSeenAt: provenance.timestamp,
        lastSeenAt: provenance.timestamp,
      });
    }
  }

  /** Most frequent first, so the panel leads with what matters. */
  anomalies(): readonly FieldAnomaly[] {
    return [...this.found.values()].sort(
      (a, b) => b.count - a.count || a.event.localeCompare(b.event) || a.field.localeCompare(b.field),
    );
  }

  /** How many distinct fields have been seen, for context in the panel. */
  get fieldsTracked(): number {
    let n = 0;
    for (const fields of this.baseline.values()) n += fields.size;
    return n;
  }

  get eventsTracked(): number {
    return this.baseline.size;
  }

  /** Non-zero when a cap was hit, so the panel does not imply completeness. */
  get truncatedCount(): number {
    return this.truncated;
  }

  reset(): void {
    this.baseline.clear();
    this.found.clear();
    this.truncated = 0;
  }
}

/** One line a person can read, and paste into a report. */
export function describeAnomaly(a: FieldAnomaly): string {
  const build = a.observedBuild ? ` on build ${a.observedBuild}` : '';
  const from = a.baselineBuild && a.baselineBuild !== a.observedBuild ? ` (first seen as ${a.expected} on ${a.baselineBuild})` : '';
  return `${a.event}.${a.field}: expected ${a.expected}, saw ${a.observed}${build}, ${a.count} ${a.count === 1 ? 'time' : 'times'}${from}`;
}
