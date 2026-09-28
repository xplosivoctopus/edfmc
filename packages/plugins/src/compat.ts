/**
 * Version compatibility for plugin manifests.
 *
 * A plugin declares what it needs; this decides whether this build provides it,
 * *before* the plugin is activated. The alternative — load it and find out — is
 * how a pack written for a newer rule schema ends up half-working and the
 * commander blames the app.
 *
 * ## Why not a semver library
 *
 * Two reasons, and the second is the real one.
 *
 * A range in a manifest is untrusted input, and the grammar full semver accepts is
 * large: unions, pre-release precedence, build metadata, hyphen ranges, x-ranges.
 * Parsing all of it is more surface than this needs.
 *
 * More importantly, a range nobody can predict the behaviour of is worse than a
 * narrow one. An author writing `>=0.3.0 <1.0.0` should be able to say with
 * certainty what it accepts. So this supports exactly five forms and rejects
 * anything else *as a manifest error*, visible to the author, rather than
 * silently treating an unparseable range as "matches everything".
 *
 *   *                any version
 *   1.2.3            exactly that version
 *   ^1.2.3           >=1.2.3 and < next significant release
 *   ~1.2.3           >=1.2.3 <1.3.0
 *   >=0.3.0 <1.0.0   a space-separated conjunction of comparators
 *
 * `^` follows npm's rule that below 1.0.0 the minor is the breaking position:
 * `^0.3.1` allows 0.3.x but not 0.4.0. Getting that wrong would let a pack
 * written against 0.3 load against 0.4, which is exactly the case this exists to
 * catch, since the project is pre-1.0.
 */

import {
  EXTENSION_API,
  MINIMUM_MANIFEST_VERSION,
  PLUGIN_LIMITS,
  SUPPORTED_MANIFEST_VERSION,
  SUPPORTED_PLUGIN_KINDS,
  type PluginManifest,
} from './types.js';

export interface CompatibilityInput {
  /** The Companion build being run, e.g. `0.1.0`. */
  readonly companionVersion: string;
}

export type Compatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface Parsed {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** `1`, `1.2` and `1.2.3` are all accepted; missing parts are zero. */
function parseVersion(value: string): Parsed | null {
  const core = value.trim().split('-')[0] ?? '';
  if (core.length === 0) return null;

  const parts = core.split('.');
  if (parts.length > 3) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  return { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0 };
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** The exclusive upper bound `^` implies. Below 1.0.0 the minor is breaking. */
function caretCeiling(v: Parsed): Parsed {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0 };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: v.patch + 1 };
}

type Check = (v: Parsed) => boolean;

function comparator(token: string): Check | null {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) return null;
  const target = parseVersion(m[2] ?? '');
  if (!target) return null;

  switch (m[1]) {
    case '>=':
      return (v) => compare(v, target) >= 0;
    case '<=':
      return (v) => compare(v, target) <= 0;
    case '>':
      return (v) => compare(v, target) > 0;
    case '<':
      return (v) => compare(v, target) < 0;
    default:
      return (v) => compare(v, target) === 0;
  }
}

/**
 * Build a predicate from a range.
 *
 * Returns null for anything outside the supported grammar, which callers report
 * as a manifest error. Never "assume it matches".
 */
export function parseRange(range: string): Check | null {
  const trimmed = range.trim();
  if (trimmed.length === 0 || trimmed.length > PLUGIN_LIMITS.maxRequirementChars) return null;
  // Pre-release and build metadata are rejected in a RANGE, even though
  // `parseVersion` tolerates them in the version being tested. Accepting
  // `^1.2.3-beta.1` would mean silently comparing against 1.2.3 and ignoring the
  // part the author wrote deliberately -- which is the failure this whole module
  // exists to avoid. A build like `0.1.0-dev` still compares fine.
  if (trimmed.includes('-') || trimmed.includes('+')) return null;
  if (trimmed === '*') return () => true;

  if (trimmed.startsWith('^')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return null;
    const ceiling = caretCeiling(base);
    return (v) => compare(v, base) >= 0 && compare(v, ceiling) < 0;
  }

  if (trimmed.startsWith('~')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return null;
    const ceiling = { major: base.major, minor: base.minor + 1, patch: 0 };
    return (v) => compare(v, base) >= 0 && compare(v, ceiling) < 0;
  }

  const tokens = trimmed.split(/\s+/);
  const checks: Check[] = [];
  for (const token of tokens) {
    const check = comparator(token);
    if (!check) return null;
    checks.push(check);
  }
  return (v) => checks.every((c) => c(v));
}

/** Whether `version` satisfies `range`. False for an unparseable range. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const check = parseRange(range);
  if (!parsed || !check) return false;
  return check(parsed);
}

/**
 * Decide whether this build can run a manifest.
 *
 * Every failure names what was wanted and what is available. "Incompatible" with
 * no detail tells the commander nothing they can act on, and tells the author
 * nothing they can fix.
 */
export function checkCompatibility(
  manifest: PluginManifest,
  input: CompatibilityInput,
): Compatibility {
  const version = manifest.manifestVersion;

  if (version > SUPPORTED_MANIFEST_VERSION) {
    return {
      ok: false,
      reason:
        `Needs manifest version ${version}; this Companion understands up to ` +
        `${SUPPORTED_MANIFEST_VERSION}. Update EDFM Companion.`,
    };
  }
  if (version < MINIMUM_MANIFEST_VERSION) {
    return {
      ok: false,
      reason: `Manifest version ${version} is no longer supported.`,
    };
  }

  // Tiers that do not exist yet must fail closed and say so. Loading a capability
  // plugin as inert data would leave an author certain their code was running.
  const kind = manifest.kind ?? 'community-pack';
  if (!SUPPORTED_PLUGIN_KINDS.includes(kind)) {
    return {
      ok: false,
      reason:
        `Declares kind "${kind}", which this build cannot run. Only data-only ` +
        `Community Packs are supported. See docs/EXTENSIONS.md.`,
    };
  }

  const requires = manifest.requires;
  if (!requires) return { ok: true };

  if (requires.edfmCompanion !== undefined) {
    const range = requires.edfmCompanion;
    if (parseRange(range) === null) {
      return { ok: false, reason: `"requires.edfmCompanion" is not a version range I understand: ${range}` };
    }
    if (!satisfies(input.companionVersion, range)) {
      return {
        ok: false,
        reason: `Needs EDFM Companion ${range}; this is ${input.companionVersion}.`,
      };
    }
  }

  if (requires.pluginApi !== undefined) {
    const range = requires.pluginApi;
    if (parseRange(range) === null) {
      return { ok: false, reason: `"requires.pluginApi" is not a version range I understand: ${range}` };
    }
    // The manifest API is a single integer; compared as `<major>.0.0` so authors
    // can write the ranges they are used to.
    const api = `${EXTENSION_API.manifest}.0.0`;
    if (!satisfies(api, range)) {
      return {
        ok: false,
        reason: `Needs plugin API ${range}; this Companion provides ${EXTENSION_API.manifest}.`,
      };
    }
  }

  return { ok: true };
}
