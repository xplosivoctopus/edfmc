/**
 * Screenshot cataloguing: names, categories and what may be prefilled.
 *
 * ## The principle this file enforces
 *
 * **The hotkey establishes intent to catalogue. The commander confirms what the
 * screenshot actually shows.** The app can see where they are and what they were
 * doing; it cannot see what is on screen. A Stratum sample being taken is good
 * evidence the screenshot is of a Stratum — and no evidence at all if they
 * turned the camera to photograph the sunset.
 *
 * So everything here that fills a field also records *why*, and nothing is
 * treated as decided. `prefill` returns suggestions, not answers.
 *
 * Pure functions with no Tauri, database or window dependency, so the rules can
 * be tested directly.
 */

/**
 * Categories, as data rather than a union type.
 *
 * Deliberately not a TypeScript enum baked into the schema: the column is free
 * text, so a later release or an add-on can extend this list without a
 * migration. A closed enum would make "add a category" a database change.
 */
export interface ScreenshotCategory {
  readonly id: string;
  readonly label: string;
  /** Shown in the picker, so the choice is not a guess at what a word means. */
  readonly hint: string;
}

export const SCREENSHOT_CATEGORIES: readonly ScreenshotCategory[] = [
  { id: 'exobiology', label: 'Exobiology', hint: 'Organisms, samples, biological signals' },
  { id: 'exploration', label: 'Exploration', hint: 'Bodies, systems, landings, vistas with a place' },
  { id: 'mining', label: 'Mining', hint: 'Hotspots, rings, prospecting' },
  { id: 'colonisation', label: 'Colonisation', hint: 'Construction sites and deliveries' },
  { id: 'ship', label: 'Ship', hint: 'Your ships, liveries, loadouts' },
  { id: 'station', label: 'Station', hint: 'Stations, carriers, docks' },
  { id: 'settlement', label: 'Settlement', hint: 'Surface settlements and ports' },
  { id: 'combat', label: 'Combat', hint: 'Fights, conflict zones, interdictions' },
  { id: 'scenery', label: 'Scenery', hint: 'Anything worth looking at' },
  { id: 'other', label: 'Other', hint: 'Menus, UI, anything else' },
];

export const DEFAULT_CATEGORY = 'other';

export function categoryLabel(id: string): string {
  return SCREENSHOT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** What the catalog stores. The image itself lives in the commander's folder. */
export interface ScreenshotRecord {
  readonly id: string;
  readonly commanderFid: string;
  readonly filePath: string;
  readonly capturedAt: string;
  readonly category: string;
  readonly subject: string | null;
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly stationName: string | null;
  readonly settlement: string | null;
  readonly tags: readonly string[];
  readonly note: string | null;
  /** Optional, and never set when the context is ambiguous. */
  readonly activityEntryId: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * A suggested value and where it came from.
 *
 * The source is carried so the dialog can say "because you are sampling this"
 * rather than presenting a guess as fact — and so a commander correcting it
 * knows what they are overriding.
 */
export interface Suggestion<T> {
  readonly value: T;
  readonly because: string;
}

export interface CaptureContext {
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly stationName: string | null;
  readonly settlement: string | null;
  readonly shipName: string | null;
  /** The specimen being sampled right now, if any. */
  readonly sampling: {
    readonly species: string | null;
    readonly genus: string | null;
    readonly colour: string | null;
    readonly samplesTaken: number | null;
    readonly samplesRequired: number;
    readonly completed: boolean;
  } | null;
  /** The newest Activity Journal entry, for optional linking. */
  readonly latestEntry: {
    readonly id: string;
    readonly title: string;
    readonly occurredAt: string;
    readonly category: string;
  } | null;
}

export interface Prefill {
  readonly category: Suggestion<string>;
  readonly subject: Suggestion<string> | null;
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly stationName: string | null;
  readonly settlement: string | null;
  readonly tags: readonly string[];
  /**
   * The entry this *could* link to, with the link left off by default.
   *
   * Offered rather than applied: §15 requires no automatic link when the
   * context is ambiguous, and from here it is always ambiguous — the app cannot
   * see the screen.
   */
  readonly suggestedLink: { readonly id: string; readonly title: string } | null;
}

/**
 * Build suggestions from live state.
 *
 * Only ever fills what the app actually knows. The rule it follows throughout:
 * **a thing that happened recently is not evidence of what a picture shows.**
 * Active sampling is good evidence of subject; a sample finished an hour ago is
 * not, so it suggests a category at most.
 */
export function prefill(ctx: CaptureContext): Prefill {
  const tags: string[] = [];

  // Active sampling is the one case where the subject is worth proposing: the
  // commander is standing in front of the organism with the scanner out.
  if (ctx.sampling && ctx.sampling.species) {
    const subject = ctx.sampling.colour
      ? `${ctx.sampling.species} — ${ctx.sampling.colour}`
      : ctx.sampling.species;

    tags.push('Exobiology');
    if (ctx.sampling.genus) tags.push(ctx.sampling.genus);
    if (ctx.sampling.colour) tags.push(ctx.sampling.colour);

    return {
      category: { value: 'exobiology', because: 'You are sampling biology here' },
      subject: { value: subject, because: 'The specimen you are sampling' },
      systemName: ctx.systemName,
      bodyName: ctx.bodyName,
      stationName: null,
      settlement: null,
      tags,
      suggestedLink: linkFor(ctx),
    };
  }

  // Docked somewhere: the place is known, what the picture shows is not.
  if (ctx.stationName) {
    return {
      category: { value: 'station', because: 'You are docked here' },
      subject: { value: ctx.stationName, because: 'The station you are docked at' },
      systemName: ctx.systemName,
      bodyName: ctx.bodyName,
      stationName: ctx.stationName,
      settlement: ctx.settlement,
      tags: ['Station'],
      suggestedLink: linkFor(ctx),
    };
  }

  if (ctx.settlement) {
    return {
      category: { value: 'settlement', because: 'You are at this settlement' },
      subject: { value: ctx.settlement, because: 'The settlement you are at' },
      systemName: ctx.systemName,
      bodyName: ctx.bodyName,
      stationName: null,
      settlement: ctx.settlement,
      tags: ['Settlement'],
      suggestedLink: linkFor(ctx),
    };
  }

  /*
   * On or near a body with nothing more specific happening. Exploration is a
   * reasonable category for a place; the subject is NOT filled, because "you
   * are at this body" says nothing about what is in frame.
   */
  if (ctx.bodyName) {
    return {
      category: { value: 'exploration', because: 'You are at a body' },
      subject: null,
      systemName: ctx.systemName,
      bodyName: ctx.bodyName,
      stationName: null,
      settlement: null,
      tags: [],
      suggestedLink: linkFor(ctx),
    };
  }

  // Nothing is known beyond possibly the system. No category is implied at all.
  return {
    category: { value: DEFAULT_CATEGORY, because: 'Nothing here says what this is' },
    subject: null,
    systemName: ctx.systemName,
    bodyName: null,
    stationName: null,
    settlement: null,
    tags: [],
    suggestedLink: linkFor(ctx),
  };
}

/**
 * The entry a screenshot might belong to.
 *
 * Offered only when something was recorded close to the capture. An entry from
 * two hours ago is not what this screenshot is of, and proposing it would train
 * commanders to click past the link rather than read it.
 */
const LINK_WINDOW_MS = 10 * 60 * 1000;

function linkFor(ctx: CaptureContext): { id: string; title: string } | null {
  const entry = ctx.latestEntry;
  if (!entry) return null;
  const at = Date.parse(entry.occurredAt);
  if (!Number.isFinite(at)) return null;
  if (Date.now() - at > LINK_WINDOW_MS) return null;
  return { id: entry.id, title: entry.title };
}

/* ------------------------------------------------------------- filenames */

/**
 * Characters Windows refuses in a filename, plus the ones that merely cause
 * trouble.
 *
 * `< > : " / \ | ? *` are reserved outright. Control characters are rejected by
 * the filesystem. A trailing dot or space is accepted by some APIs and then
 * becomes impossible to delete through Explorer, which is worse than refusing
 * it here.
 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Device names Windows still reserves, case-insensitively, with or without an
 * extension. A file called `CON.png` cannot be created.
 */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Make one path segment safe for Windows.
 *
 * Replaces rather than strips, so `Wregoe XX-X d1-42 3/A` becomes
 * `Wregoe XX-X d1-42 3-A` instead of running two words together.
 */
export function sanitiseSegment(input: string): string {
  let out = input.replace(ILLEGAL, '-');
  // The em dash this app uses for variants is legal and readable; collapse only
  // whitespace runs.
  out = out.replace(/\s+/g, ' ').trim();
  // Trailing dots and spaces are the ones that create undeletable files.
  out = out.replace(/[. ]+$/, '');
  if (out.length === 0) return '';
  const stem = out.split('.')[0]!.toUpperCase();
  if (RESERVED.has(stem)) out = `_${out}`;
  return out;
}

/**
 * How long a generated stem may be.
 *
 * Windows' classic limit is 260 characters for a whole path. The folder is the
 * commander's choice and can be deep, so the *name* is kept well short of the
 * limit rather than measured against it: a conservative cap that always works
 * beats an exact calculation that fails on one machine in twenty.
 */
export const MAX_STEM = 120;

/**
 * System and body as one place, without saying the system twice.
 *
 * Elite names bodies **fully qualified**: the body in `Wregoe UC-L c24-1` is
 * called `Wregoe UC-L c24-1 A`, system name included. Joining the two produced
 * `Wregoe UC-L c24-1 Wregoe UC-L c24-1 A`.
 *
 * Measured across 8,831 distinct system/body pairs in the corpus:
 *
 * | | Pairs |
 * |---|---|
 * | Body prefixed with `"<system> "` | 7,651 |
 * | Body exactly equals the system | 1,171 |
 * | Body has a name of its own | **9** |
 *
 * So the body alone is the whole answer 99.9% of the time. The nine exceptions
 * are bodies with proper names — `Sirius` / `Lucifer`, `Cai` / `Trango` — and
 * those are exactly the cases where the system genuinely adds something, so
 * they keep both.
 */
export function placeName(systemName: string | null, bodyName: string | null): string | null {
  const sys = systemName?.trim() || null;
  const body = bodyName?.trim() || null;

  if (!sys) return body;
  if (!body) return sys;
  // Already carries the system; saying it again is the bug this exists to fix.
  if (body === sys || body.startsWith(`${sys} `)) return body;
  return `${sys} ${body}`;
}

export interface FilenameParts {
  readonly subject: string | null;
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly capturedAt: string;
  /** Lower case, with the dot, e.g. `.png`. */
  readonly extension: string;
}

/** `2026-09-30 14-22-18`. Colons are illegal in filenames, so time uses dashes. */
export function timestampPart(iso: string): string {
  const t = Date.parse(iso);
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

/**
 * Propose a filename.
 *
 * Subject, then place, then when — most specific first, so a folder sorted by
 * name groups the same subject together. Empty parts are dropped rather than
 * leaving ` -  - ` gaps.
 *
 * The timestamp is always included: it makes the name unique in practice, and a
 * screenshot without one is hard to place later.
 */
export function proposeFilename(parts: FilenameParts): string {
  const place = sanitiseSegment(placeName(parts.systemName, parts.bodyName) ?? '');

  const pieces = [
    parts.subject ? sanitiseSegment(parts.subject) : '',
    place,
    timestampPart(parts.capturedAt),
  ].filter((p) => p.length > 0);

  let stem = pieces.join(' - ');
  if (stem.length > MAX_STEM) {
    // Truncate the stem, never the timestamp: the tail is what keeps names
    // distinct, so cutting it would manufacture collisions.
    const tail = ` - ${timestampPart(parts.capturedAt)}`;
    const head = stem.slice(0, Math.max(1, MAX_STEM - tail.length)).replace(/[-\s]+$/, '');
    stem = `${head}${tail}`;
  }

  const ext = parts.extension.startsWith('.') ? parts.extension : `.${parts.extension}`;
  return `${stem}${ext.toLowerCase()}`;
}

/**
 * Resolve a collision by appending `(2)`, `(3)` and so on.
 *
 * Deterministic, and it never overwrites: §11 is explicit that silently
 * replacing an existing screenshot is not acceptable. The suffix goes before
 * the extension so the file still opens as an image.
 *
 * `exists` is injected so this is testable without a filesystem.
 */
export function resolveCollision(
  filename: string,
  exists: (name: string) => boolean,
  limit = 999,
): string {
  if (!exists(filename)) return filename;

  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';

  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }

  // Beyond the limit, fall back to something that cannot realistically clash
  // rather than giving up and risking an overwrite.
  return `${stem} (${Date.now()})${ext}`;
}

/** Tags kept short and few; this is labelling, not a taxonomy. */
export const TAG_LIMITS = { maxTags: 12, maxTagChars: 32 } as const;

export function normaliseTags(input: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, TAG_LIMITS.maxTagChars);
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAG_LIMITS.maxTags) break;
  }
  return out;
}

/* --------------------------------------------------------------- hotkey */

/**
 * A hotkey binding, as Tauri's global-shortcut plugin expects it.
 *
 * **Nothing is bound by default.** §1 is explicit, and the reason is practical:
 * Elite players run dense keyboard and HOTAS bindings, and silently claiming a
 * combination could break something they rely on mid-flight. Null means no
 * hotkey, and that is the shipped state.
 */
export type Hotkey = string | null;

/**
 * Combinations this app refuses to register.
 *
 * A bare key or a lone modifier would fire while typing a system name into
 * search. Requiring a modifier plus a real key is the smallest rule that
 * prevents the obvious footguns without second-guessing the commander.
 */
const MODIFIERS = new Set(['Control', 'Ctrl', 'Shift', 'Alt', 'Super', 'Meta', 'Command', 'CommandOrControl']);

export interface HotkeyCheck {
  readonly ok: boolean;
  readonly reason: string | null;
}

export function validateHotkey(binding: string): HotkeyCheck {
  const parts = binding.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, reason: 'No keys in that combination.' };

  const mods = parts.filter((p) => MODIFIERS.has(p));
  const keys = parts.filter((p) => !MODIFIERS.has(p));

  if (keys.length === 0) {
    return { ok: false, reason: 'Add a key as well as the modifier.' };
  }
  if (keys.length > 1) {
    return { ok: false, reason: 'Use one key plus modifiers.' };
  }
  if (mods.length === 0) {
    return {
      ok: false,
      reason: 'Add Ctrl, Alt or Shift. A key on its own would fire while you type.',
    };
  }
  return { ok: true, reason: null };
}

/**
 * Format a captured key event as a binding string.
 *
 * Returns null while only modifiers are held, which is what lets a "press a
 * combination" field show the keys so far without committing to them.
 */
export function bindingFromEvent(e: {
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly key: string;
  readonly code: string;
}): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');

  const key = normaliseKey(e.key, e.code);
  if (key === null) return null;
  parts.push(key);
  return parts.join('+');
}

function normaliseKey(key: string, code: string): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(key)) return null;

  // Function keys and digits come through `code` reliably regardless of layout
  // or whether Shift is held; `F12` and `Digit5` are stable, `key` is not.
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (code === 'Space') return 'Space';

  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** How a binding reads in the UI. */
export function describeHotkey(binding: Hotkey): string {
  if (!binding) return 'Not set';
  return binding
    .split('+')
    .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
    .join(' + ');
}
