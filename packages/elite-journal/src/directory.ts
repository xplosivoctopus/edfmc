/**
 * Journal directory resolution and file ordering.
 *
 * §3 forbids hardcoded `C:\Users\...` logic. The correct source on Windows is the
 * Saved Games known folder (FOLDERID_SavedGames), which the Rust layer resolves via
 * the shell API and injects here. Everything in this module is therefore
 * platform-agnostic and testable without touching a real machine.
 */

import { getDefaultFs, type JournalFs } from './fs.js';

/** Two filename shapes have shipped over the game's life; both are supported. */
const MODERN = /^Journal\.(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d+)\.log$/;
const LEGACY = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)\.log$/;

export interface JournalFile {
  readonly fileName: string;
  readonly fullPath: string;
  /** Sortable key derived from the filename, not from mtime. */
  readonly sortKey: number;
  /** The `.NN.` component. Always 1 across the validation corpus, never assumed. */
  readonly part: number;
  readonly sizeBytes: number;
}

/** Parse a journal filename into a sort key. Returns null for non-journal files. */
export function parseJournalFileName(
  fileName: string,
): { sortKey: number; part: number } | null {
  const modern = MODERN.exec(fileName);
  if (modern) {
    const [, y, mo, d, h, mi, s, part] = modern;
    return {
      sortKey: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!),
      part: Number(part),
    };
  }
  const legacy = LEGACY.exec(fileName);
  if (legacy) {
    const [, y, mo, d, h, mi, s, part] = legacy;
    // Two-digit years in this format are 20xx; the game did not exist before 2014.
    return {
      sortKey: Date.UTC(2000 + +y!, +mo! - 1, +d!, +h!, +mi!, +s!),
      part: Number(part),
    };
  }
  return null;
}

/**
 * List journal files in chronological order.
 *
 * Ordering is by (filename timestamp, part) rather than mtime, because mtime is
 * rewritten by file copies, backups and cloud sync, and would reorder history.
 */
export async function listJournalFiles(
  directory: string,
  io?: JournalFs,
): Promise<JournalFile[]> {
  const fs = io ?? getDefaultFs();
  const entries = await fs.readDir(directory);

  const files: JournalFile[] = [];
  for (const fileName of entries) {
    const parsed = parseJournalFileName(fileName);
    if (!parsed) continue;
    const fullPath = fs.join(directory, fileName);
    const sizeBytes = await fs.size(fullPath);
    if (sizeBytes === null) continue; // vanished between listing and stat
    files.push({ fileName, fullPath, sortKey: parsed.sortKey, part: parsed.part, sizeBytes });
  }

  files.sort((a, b) => a.sortKey - b.sortKey || a.part - b.part || a.fileName.localeCompare(b.fileName));
  return files;
}

/**
 * Choose the journal to tail.
 *
 * Skips zero-byte files. This is not defensive theatre: the validation corpus
 * contains two genuinely empty journals, and selecting "the newest file" naively
 * lands on one and stalls forever waiting for content that never arrives.
 *
 * Empty files are still returned in `listJournalFiles`, so rotation detection can
 * see them appear.
 */
export function selectActiveJournal(files: readonly JournalFile[]): JournalFile | null {
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const f = files[i]!;
    if (f.sizeBytes > 0) return f;
  }
  return null;
}

export type ResolutionStrategy =
  | 'manual-override'
  | 'known-folder'
  | 'env-fallback'
  /**
   * A probe threw rather than answering.
   *
   * Distinct from `none` on the same principle the rest of this project runs on:
   * "we looked and it is not there" and "we could not look" are different facts,
   * and only the first one means *set a path in Settings*. Collapsing them would
   * send a commander to fix a path that was never the problem.
   */
  | 'probe-failed'
  | 'none';

export interface DirectoryResolution {
  readonly directory: string | null;
  readonly strategy: ResolutionStrategy;
  /** Human-readable explanation surfaced in Settings and diagnostics. */
  readonly detail: string;
}

export interface ResolveOptions {
  /** User-supplied path from Settings. Always wins when set. */
  readonly manualOverride?: string | undefined;
  /**
   * Supplied by the Rust layer via SHGetKnownFolderPath(FOLDERID_SavedGames).
   * Injected rather than computed so this module stays testable and portable.
   */
  readonly savedGamesPath?: string | undefined;
  /** Existence probe, injected for testability. */
  readonly exists?: (path: string) => Promise<boolean>;
  readonly fs?: JournalFs;
}

/**
 * Outcome of a single existence probe.
 *
 * Three-valued on purpose. `false` means the probe answered and the path is not
 * there; `'failed'` means it never answered at all. The injected probe is backed
 * by an IPC call to the native layer on the desktop, and IPC can fail for
 * reasons that have nothing to do with the path being asked about.
 */
type ProbeResult = true | false | 'failed';

async function probe(
  exists: (path: string) => Promise<boolean>,
  path: string,
): Promise<{ readonly result: ProbeResult; readonly error: string | null }> {
  try {
    return { result: await exists(path), error: null };
  } catch (err) {
    return { result: 'failed', error: String(err) };
  }
}

/**
 * Resolve the journal directory, reporting which strategy succeeded so the UI can
 * tell the user *why* it is looking where it is looking.
 *
 * Never rejects. A probe that throws is reported as `probe-failed`, because this
 * runs during startup and a rejection here left the app wedged on "Starting"
 * with no visible cause — the exact silent-hang failure the app's own smoke
 * tests exist to catch.
 */
export async function resolveJournalDirectory(
  options: ResolveOptions = {},
): Promise<DirectoryResolution> {
  const fs = options.fs ?? getDefaultFs();
  const exists = options.exists ?? ((p: string) => fs.isDirectory(p));
  const GAME_SUBPATH = fs.join('Frontier Developments', 'Elite Dangerous');

  // Remembered so that a run which found nothing can say whether it actually
  // looked. Only the first failure is kept: they will share a cause, and one
  // message a person can act on beats a concatenated list of the same error.
  let probeError: string | null = null;
  const note = (error: string | null): void => {
    if (error !== null && probeError === null) probeError = error;
  };

  if (options.manualOverride) {
    const { result, error } = await probe(exists, options.manualOverride);
    if (result === 'failed') {
      return {
        directory: null,
        strategy: 'probe-failed',
        // Explicitly not "does not exist": the path may well be fine.
        detail:
          `Could not check the path configured in Settings (${options.manualOverride}). ` +
          `The check itself failed: ${error}`,
      };
    }
    return {
      directory: result ? options.manualOverride : null,
      strategy: 'manual-override',
      detail: result
        ? 'Using the path configured in Settings.'
        : `Configured path does not exist: ${options.manualOverride}`,
    };
  }

  if (options.savedGamesPath) {
    const candidate = fs.join(options.savedGamesPath, GAME_SUBPATH);
    const { result, error } = await probe(exists, candidate);
    note(error);
    if (result === true) {
      return {
        directory: candidate,
        strategy: 'known-folder',
        detail: 'Resolved from the Windows Saved Games known folder.',
      };
    }
  }

  // Last resort only. Documented as a fallback because USERPROFILE can be
  // relocated or absent, and Saved Games can be redirected away from it.
  //
  // Still attempted after a failed known-folder probe: the two paths are
  // different, and one failing does not establish that the other will.
  //
  // `process` is guarded because this also runs in a webview, where it does not
  // exist. Reading it unguarded threw a ReferenceError exactly here -- in the
  // branch that only runs when the known-folder probe has already failed -- so
  // the fallback destroyed the startup it was written to rescue.
  const env = typeof process === 'undefined' ? undefined : process.env;
  const home = env?.['USERPROFILE'] ?? env?.['HOME'];
  if (home) {
    const candidate = fs.join(home, 'Saved Games', GAME_SUBPATH);
    const { result, error } = await probe(exists, candidate);
    note(error);
    if (result === true) {
      return {
        directory: candidate,
        strategy: 'env-fallback',
        detail:
          'Known-folder lookup unavailable; located via the user profile directory. ' +
          'Set an explicit path in Settings if this is wrong.',
      };
    }
  }

  if (probeError !== null) {
    return {
      directory: null,
      strategy: 'probe-failed',
      detail:
        'Could not check whether the journal directory exists; the check itself failed: ' +
        `${probeError}. Setting an explicit path in Settings may not help until this is resolved.`,
    };
  }

  return {
    directory: null,
    strategy: 'none',
    detail: 'Could not locate the Elite Dangerous journal directory. Set it in Settings.',
  };
}
