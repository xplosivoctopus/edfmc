/**
 * Version and status facts, in one place.
 *
 * Every number here is read from wherever it is actually defined rather than
 * restated. A duplicated constant is a constant that goes stale, and the one
 * place it matters most is a support conversation: a status screen that reports
 * a version the build does not have is worse than no status screen.
 *
 * `VALIDATED_ELITE_BUILD` is the single exception — it has no other home,
 * because it describes a measurement rather than a component. It lives here and
 * only here.
 */

import { BUNDLED_RULES } from '@edfm/context';
import { EXTENSION_API } from '@edfm/plugins';
import { EXOBIOLOGY_SCHEMA_VERSION } from '@edfm/activity';

/**
 * The newest Elite build whose journal behaviour has been measured.
 *
 * Raise this only after re-profiling against a corpus from that build. It is a
 * claim about work done, not a compatibility ceiling: a newer build is expected
 * to work, and unknown events and fields are preserved either way.
 *
 * See docs/JOURNAL.md for what "validated" covers.
 */
export const VALIDATED_ELITE_BUILD = '4.4.0.3';

export interface AboutStatus {
  readonly appVersion: string;
  /** Bundled rules today; a downloaded content package later. */
  readonly contentSource: 'bundled' | 'cached' | 'remote';
  readonly contentVersion: string;
  readonly contextRules: number;
  readonly exobiologySchema: number;
  readonly pluginApi: number;
  readonly validatedBuild: string;
  /** What the game is actually reporting, or null before a header is seen. */
  readonly connectedBuild: string | null;
  /** True when the game is newer than anything measured. Informational only. */
  readonly buildIsNewer: boolean;
}

/**
 * Compare two Elite build strings.
 *
 * Dotted numerics, compared part by part. Deliberately not `localeCompare` or a
 * string comparison: `4.10.0.0` is newer than `4.9.0.0` and sorts the other way
 * as text, which is exactly the case that would eventually appear and quietly
 * suppress the notice.
 */
export function compareBuilds(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .split('.')
      .map((part) => {
        const n = Number(part);
        return Number.isFinite(n) ? n : 0;
      });

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Whether the running game is newer than anything measured. */
export function isNewerThanValidated(connected: string | null): boolean {
  if (!connected) return false;
  // Unparseable is not "newer". A garbled build string should not produce a
  // notice about something nobody can act on.
  if (!/^\d+(\.\d+)*$/.test(connected.trim())) return false;
  return compareBuilds(connected, VALIDATED_ELITE_BUILD) > 0;
}

export function aboutStatus(input: {
  readonly appVersion: string;
  readonly connectedBuild: string | null;
}): AboutStatus {
  return {
    appVersion: input.appVersion,
    contentSource: BUNDLED_RULES.source,
    contentVersion: String(BUNDLED_RULES.version),
    contextRules: BUNDLED_RULES.rules.length,
    exobiologySchema: EXOBIOLOGY_SCHEMA_VERSION,
    pluginApi: EXTENSION_API.manifest,
    validatedBuild: VALIDATED_ELITE_BUILD,
    connectedBuild: input.connectedBuild,
    buildIsNewer: isNewerThanValidated(input.connectedBuild),
  };
}

/**
 * The notice shown when the game is newer than the measured corpus.
 *
 * Informational, and worded to say so. This project has measured its way to
 * several findings that contradicted the obvious reading of an event name, so a
 * new build genuinely might behave differently — but "we have not checked yet"
 * is not "this is broken", and implying otherwise would teach commanders to
 * ignore the notice.
 */
export function newerBuildNotice(status: AboutStatus): string | null {
  if (!status.buildIsNewer || !status.connectedBuild) return null;
  return (
    `Elite build ${status.connectedBuild} detected. ` +
    `Journal validation currently covers through ${status.validatedBuild}. ` +
    `Unknown events and fields continue to be preserved.`
  );
}
