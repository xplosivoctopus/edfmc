/**
 * The Activity Journal model.
 *
 * Elite already writes a machine journal. This is the other thing: a record of
 * what the commander *did*, in language they would use themselves. `ScanOrganic`
 * three times is not an activity; "Stratum Tectonicas — Lime, sample completed"
 * is.
 *
 * ## Why this is a package and not part of Companion
 *
 * Processors are pure functions from journal events to entries. Keeping them
 * here means they can be tested against the real corpus without a database, a
 * window, or a running app — and it keeps them out of a class that is already
 * doing too much.
 *
 * ## Identity, and why it is not a counter
 *
 * An entry's id is derived from the journal event that produced it. The engine
 * already guarantees `eventId` is `sourceFile:byteOffset`, stable across
 * restarts and across replay, chosen for exactly this reason: timestamps repeat
 * within a second, and content hashing would make two identical scans collide.
 *
 * So re-reading a journal file produces the same ids, and persistence can use an
 * ignore-on-conflict insert rather than trying to work out what it has already
 * seen. Deduplication is a property of the identifier, not a procedure that can
 * be got wrong.
 */

/**
 * Broad activity families. Deliberately few; more is a schema change, not a guess.
 *
 * **`missions` is local-only for now.** EDFM's journal extension allowlists four
 * categories, and this is the fifth, so mission entries are kept and shown here
 * but are refused by the server with `unsupported_category` until the wiki
 * accepts them. The client declines to send them rather than discovering that
 * per entry; see `SYNCABLE_SUBTYPES` and `docs/JOURNAL-SYNC.md`.
 */
export type ActivityCategory =
  | 'exobiology'
  | 'exploration'
  | 'mining'
  | 'colonisation'
  | 'missions';

/**
 * One thing the commander did.
 *
 * `title` and `detail` are what a person reads. `data` is the structured form,
 * kept so a later UI, export or search can use fields without re-parsing prose.
 */
export interface ActivityEntry {
  /** Deterministic; see the note above on identity. */
  readonly id: string;
  /**
   * Which commander this belongs to.
   *
   * Two people sharing a machine must not inherit each other's history, and the
   * FID is the only stable account identifier the journal provides. Stored
   * locally and never transmitted -- see docs/PRIVACY.md.
   */
  readonly commanderFid: string;
  /** ISO 8601, verbatim from the journal. Never reformatted on the way in. */
  readonly occurredAt: string;
  readonly category: ActivityCategory;
  /** Narrower kind within the category, e.g. `sample-completed`. */
  readonly subtype: string;

  readonly systemName: string | null;
  readonly systemAddress: number | null;
  /**
   * Body name when it is known.
   *
   * Often null at the moment an event arrives: `ScanOrganic.Body` is a BodyID
   * integer, not a name, so the name has to be resolved from something else that
   * mentioned the same body. Null is the honest answer when nothing has.
   */
  readonly bodyName: string | null;
  readonly bodyId: number | null;
  /** Station or settlement, where the activity happened at one. */
  readonly locationName: string | null;

  readonly title: string;
  readonly detail: string | null;
  readonly data: Readonly<Record<string, unknown>>;

  /**
   * The journal events this was derived from.
   *
   * Provenance is not decoration: an entry that cannot be traced back is one
   * nobody can check. Usually one id; more when several events make one activity.
   */
  readonly sources: readonly string[];
}

/**
 * An optional grouping of entries, e.g. an evening's exobiology run.
 *
 * Schema defined now and deliberately not populated yet. Automatic session
 * boundaries are a guess about intent, and a guess presented as a fact is the
 * thing this project avoids -- so sessions wait until there is a rule worth
 * defending. Defining the shape now means adding them later is not a migration.
 */
export interface ActivitySession {
  readonly id: string;
  readonly commanderFid: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Commander-supplied. Absent means the UI names it from its contents. */
  readonly name: string | null;
  readonly category: ActivityCategory | null;
}

/** A commander's own note. Local only, never transmitted. */
export interface ActivityNote {
  readonly id: string;
  readonly commanderFid: string;
  /** Exactly one of these is set. */
  readonly entryId: string | null;
  readonly sessionId: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A link shown on an entry. Resolved at render time, never stored. */
export interface ActivityLink {
  readonly label: string;
  readonly url: string;
  /** `edfm` for wiki pages, `external` for third-party galaxy databases. */
  readonly kind: 'edfm' | 'external';
}

/**
 * What a processor is allowed to know beyond the event itself.
 *
 * Narrow on purpose. A processor that could reach the whole application would be
 * as hard to test as the application.
 */
export interface ActivityContext {
  readonly commanderFid: string;
  /** BodyID -> name, accumulated from events that carry both. */
  readonly bodyNames: ReadonlyMap<number, string>;
  readonly systemName: string | null;
  readonly systemAddress: number | null;
}

/**
 * Which interpretation produced an entry.
 *
 * Carried so a future migration, sync or rebuild can tell entries written by one
 * version of a processor from another. The meaning of "biological sample
 * completed" is not guaranteed to be identical forever, and silently rewriting
 * history when it changes would be the opposite of a journal.
 *
 * Not shown in normal UI. Raised when a processor's output changes meaning, not
 * when its code changes.
 */
export const ACTIVITY_SCHEMA_VERSION = 1;
export const EXOBIOLOGY_SCHEMA_VERSION = 1;

export const ACTIVITY_LIMITS = {
  /** Titles are read at a glance, not scrolled. */
  maxTitleChars: 120,
  maxDetailChars: 400,
  /** A note is a paragraph, not a document. */
  maxNoteChars: 4000,
  /** Structured data is a summary of the activity, not a copy of the event. */
  maxDataBytes: 4096,
} as const;
