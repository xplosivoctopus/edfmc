/**
 * Plugin validation.
 *
 * Every rule here fails **closed and per plugin**: a broken plugin is refused
 * with a reason the commander can read, and the others still load. A plugin
 * folder is user-supplied input from an author who may be a stranger, so this
 * treats it exactly like the untrusted rule feed the context schema was
 * designed for.
 */

import { sanitise, type ContextRule, type ContextRuleSet } from '@edfm/context';
import type { ResearchProject } from '@edfm/research';
import {
  COMPANION_VERSION_FOR_PLUGINS,
  FORBIDDEN_OBSERVATION_EVENTS,
  MINIMUM_MANIFEST_VERSION,
  PLUGIN_LIMITS,
  SUPPORTED_MANIFEST_VERSION,
  type LoadedPlugin,
  type PluginKind,
  type PluginLoadResult,
  type PluginManifest,
  type PluginProblem,
  type PluginRequirements,
  type RejectedPlugin,
} from './types.js';
import { checkCompatibility } from './compat.js';

/** Raw file as read from disk. Parsing happens here, not in the reader. */
export interface RawPlugin {
  /** Folder name, used for reporting and never trusted as an identifier. */
  readonly directory: string;
  readonly json: string;
  /** Contents of README.md beside the manifest, when the author wrote one. */
  readonly readme?: string | null;
}

/** Reverse-DNS-ish. Restrictive on purpose: this becomes an id prefix. */
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION = /^\d+(?:\.\d+){0,3}(?:-[a-z0-9.]+)?$/i;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
}

function eventsOf(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Namespace an id so a plugin cannot shadow a built-in rule or another plugin.
 *
 * `sanitise` drops duplicate rule ids because ambiguous ids make expiry
 * ambiguous. Without prefixing, a plugin declaring `engineer-workshop` would
 * either collide with the bundled rule of that name or silently replace it
 * depending on merge order — and a plugin quietly disabling a built-in context
 * is not something a commander would ever be shown.
 */
export function namespaced(pluginId: string, id: string): string {
  return `${pluginId}/${id}`;
}

function validateManifest(raw: unknown): { manifest: PluginManifest } | { problems: PluginProblem[] } {
  const problems: PluginProblem[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: [{ severity: 'error', message: 'Manifest is not a JSON object.' }] };
  }
  const m = raw as Record<string, unknown>;

  // A range rather than one value, because v1 manifests keep loading
  // indefinitely: an author should upgrade to *declare* things, not to keep
  // working. Out-of-range versions are reported by checkCompatibility, which can
  // say whether the fix is updating the app or the plugin.
  const declaredVersion = m.manifestVersion;
  if (
    typeof declaredVersion !== 'number' ||
    !Number.isInteger(declaredVersion) ||
    declaredVersion < MINIMUM_MANIFEST_VERSION
  ) {
    problems.push({
      severity: 'error',
      message:
        `Manifest version ${String(declaredVersion)} is not a supported manifest ` +
        `version (this build understands ${MINIMUM_MANIFEST_VERSION} to ` +
        `${SUPPORTED_MANIFEST_VERSION}).`,
    });
  }

  const id = text(m.id, 128);
  if (id === null || !ID.test(id)) {
    problems.push({
      severity: 'error',
      message:
        'Plugin id must be lowercase letters, digits, dots and hyphens, ' +
        'e.g. "com.example.my-plugin".',
    });
  }

  const name = text(m.name, 80);
  if (name === null) problems.push({ severity: 'error', message: 'Plugin needs a name.' });

  const version = text(m.version, 32);
  if (version === null || !VERSION.test(version)) {
    problems.push({ severity: 'error', message: 'Plugin needs a version like "1.0.0".' });
  }

  if (m.contributes === null || typeof m.contributes !== 'object' || Array.isArray(m.contributes)) {
    problems.push({ severity: 'error', message: 'Plugin has no "contributes" section.' });
  }

  // Declared tier. Absent means community-pack, which is every v1 manifest.
  let kind: PluginKind | undefined;
  if (m.kind !== undefined) {
    if (typeof m.kind !== 'string') {
      problems.push({ severity: 'error', message: '"kind" must be a string.' });
    } else {
      kind = m.kind as PluginKind;
    }
  }

  // Requirements are validated for *shape* here; whether they are satisfied is
  // checkCompatibility's job, so a plugin that simply needs a newer build is not
  // confused with one whose manifest is malformed.
  let requires: PluginRequirements | undefined;
  if (m.requires !== undefined) {
    if (m.requires === null || typeof m.requires !== 'object' || Array.isArray(m.requires)) {
      problems.push({ severity: 'error', message: '"requires" must be an object.' });
    } else {
      const r = m.requires as Record<string, unknown>;
      const out: { edfmCompanion?: string; pluginApi?: string } = {};
      for (const key of ['edfmCompanion', 'pluginApi'] as const) {
        const value = r[key];
        if (value === undefined) continue;
        const range = text(value, PLUGIN_LIMITS.maxRequirementChars);
        if (range === null) {
          problems.push({ severity: 'error', message: `"requires.${key}" must be a version range.` });
        } else {
          out[key] = range;
        }
      }
      requires = out;
    }
  }

  if (problems.length > 0) return { problems };

  return {
    manifest: {
      manifestVersion: declaredVersion as number,
      ...(kind === undefined ? {} : { kind }),
      ...(requires === undefined ? {} : { requires }),
      id: id!,
      name: name!,
      version: version!,
      ...(text(m.author, 80) === null ? {} : { author: text(m.author, 80)! }),
      ...(text(m.description, 400) === null ? {} : { description: text(m.description, 400)! }),
      ...(text(m.homepage, 300) === null ? {} : { homepage: text(m.homepage, 300)! }),
      ...(text(m.instructions, PLUGIN_LIMITS.maxInstructionsChars) === null
        ? {}
        : { instructions: text(m.instructions, PLUGIN_LIMITS.maxInstructionsChars)! }),
      contributes: m.contributes as PluginManifest['contributes'],
    },
  };
}

function validateContextRules(
  manifest: PluginManifest,
  warnings: string[],
): readonly ContextRule[] {
  const supplied = manifest.contributes.contextRules;
  if (supplied === undefined) return [];
  if (!Array.isArray(supplied)) {
    warnings.push('contributes.contextRules is not a list; ignored.');
    return [];
  }

  if (supplied.length > PLUGIN_LIMITS.maxContextRulesPerPlugin) {
    warnings.push(
      `Only the first ${PLUGIN_LIMITS.maxContextRulesPerPlugin} of ` +
        `${supplied.length} context rules were loaded.`,
    );
  }

  const prefixed = supplied.slice(0, PLUGIN_LIMITS.maxContextRulesPerPlugin).map((rule) => ({
    ...rule,
    id: typeof rule?.id === 'string' ? namespaced(manifest.id, rule.id) : rule?.id,
  })) as ContextRule[];

  // Reuse the resolver's own hardening rather than reimplementing it: rule
  // count caps, TTL clamping, resource caps, duplicate-id rejection.
  const set: ContextRuleSet = {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    source: 'bundled',
    rules: prefixed,
  };
  const clean = sanitise(set).rules;

  const dropped = prefixed.length - clean.length;
  if (dropped > 0) {
    warnings.push(`${dropped} context rule${dropped === 1 ? '' : 's'} were malformed and dropped.`);
  }
  return clean;
}

function validateResearchProjects(
  manifest: PluginManifest,
  warnings: string[],
  problems: PluginProblem[],
): readonly ResearchProject[] {
  const supplied = manifest.contributes.researchProjects;
  if (supplied === undefined) return [];
  if (!Array.isArray(supplied)) {
    warnings.push('contributes.researchProjects is not a list; ignored.');
    return [];
  }

  const out: ResearchProject[] = [];
  for (const project of supplied.slice(0, PLUGIN_LIMITS.maxResearchProjectsPerPlugin)) {
    if (project === null || typeof project !== 'object') continue;
    const id = text((project as { id?: unknown }).id, 128);
    if (id === null) {
      warnings.push('A research project had no id and was dropped.');
      continue;
    }

    const observe = Array.isArray(project.observe) ? project.observe : [];
    const context = Array.isArray(project.context) ? project.context : [];

    // §21 is not advisory. A plugin that could observe ReceiveText would write
    // chat into the local database, which the application itself is forbidden
    // from doing. Refusing the whole plugin rather than quietly stripping the
    // rule: an author who asked for chat should be told, not silently altered.
    const requested = [...observe, ...context].flatMap((r) => eventsOf((r as { on?: unknown }).on));
    const forbidden = requested.filter((e) => FORBIDDEN_OBSERVATION_EVENTS.includes(e));
    if (forbidden.length > 0) {
      problems.push({
        severity: 'error',
        message:
          `Research project "${id}" observes ${[...new Set(forbidden)].join(', ')}, ` +
          'which carries chat, friends or commander identity. Plugins may not collect these.',
      });
      continue;
    }

    if (!Array.isArray(project.end) || project.end.length === 0) {
      warnings.push(`Research project "${id}" has no end events and was dropped.`);
      continue;
    }

    out.push({
      ...(project as ResearchProject),
      id: namespaced(manifest.id, id),
      version: Number.isFinite(project.version) ? (project.version as number) : 1,
    });
  }
  return out;
}

/**
 * Validate one plugin.
 *
 * Returns either a loaded plugin or a rejection. Never throws: a plugin that
 * crashes the loader would be a plugin that crashes the application.
 */
export interface LoadOptions {
  /** Defaults to this build's version; injected so tests can pin it. */
  readonly companionVersion?: string;
}

export function validatePlugin(
  raw: RawPlugin,
  options: LoadOptions = {},
): LoadedPlugin | RejectedPlugin {
  if (raw.json.length > PLUGIN_LIMITS.maxManifestBytes) {
    return {
      directory: raw.directory,
      id: null,
      problems: [{ severity: 'error', message: 'Manifest is too large.' }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.json);
  } catch (error) {
    return {
      directory: raw.directory,
      id: null,
      problems: [{ severity: 'error', message: `Manifest is not valid JSON: ${(error as Error).message}` }],
    };
  }

  const checked = validateManifest(parsed);
  if (!('problems' in checked)) {
    // Decided before anything is activated. A pack that needs a newer build must
    // say so rather than loading and behaving oddly -- which is the failure the
    // commander would otherwise blame on the app.
    const compat = checkCompatibility(checked.manifest, {
      companionVersion: options.companionVersion ?? COMPANION_VERSION_FOR_PLUGINS,
    });
    if (!compat.ok) {
      return {
        directory: raw.directory,
        id: checked.manifest.id,
        problems: [{ severity: 'error', message: compat.reason }],
      };
    }
  }
  if ('problems' in checked) {
    const id = typeof (parsed as { id?: unknown })?.id === 'string' ? (parsed as { id: string }).id : null;
    return { directory: raw.directory, id, problems: checked.problems };
  }

  const { manifest } = checked;
  const warnings: string[] = [];
  const problems: PluginProblem[] = [];

  const contextRules = validateContextRules(manifest, warnings);
  const researchProjects = validateResearchProjects(manifest, warnings, problems);

  if (problems.length > 0) {
    return { directory: raw.directory, id: manifest.id, problems };
  }

  if (contextRules.length === 0 && researchProjects.length === 0) {
    return {
      directory: raw.directory,
      id: manifest.id,
      problems: [{ severity: 'error', message: 'Plugin contributes nothing this build understands.' }],
    };
  }

  const readme =
    typeof raw.readme === 'string' && raw.readme.trim() !== ''
      ? raw.readme.slice(0, PLUGIN_LIMITS.maxReadmeChars)
      : null;
  if (raw.readme != null && raw.readme.length > PLUGIN_LIMITS.maxReadmeChars) {
    warnings.push('README.md was truncated for display.');
  }

  return {
    manifest,
    directory: raw.directory,
    contextRules,
    researchProjects,
    warnings,
    readme,
  };
}

/** Validate every plugin found on disk, keeping the good ones. */
export function loadPlugins(
  raws: readonly RawPlugin[],
  options: LoadOptions = {},
): PluginLoadResult {
  const loaded: LoadedPlugin[] = [];
  const rejected: RejectedPlugin[] = [];
  const seen = new Set<string>();

  for (const raw of raws.slice(0, PLUGIN_LIMITS.maxPlugins)) {
    const result = validatePlugin(raw, options);

    if ('problems' in result) {
      rejected.push(result);
      continue;
    }
    // Two folders claiming the same id would make "which plugin contributed
    // this rule" unanswerable, so the second is refused rather than merged.
    if (seen.has(result.manifest.id)) {
      rejected.push({
        directory: result.directory,
        id: result.manifest.id,
        problems: [{
          severity: 'error',
          message: `Another installed plugin already uses the id "${result.manifest.id}".`,
        }],
      });
      continue;
    }
    seen.add(result.manifest.id);
    loaded.push(result);
  }

  if (raws.length > PLUGIN_LIMITS.maxPlugins) {
    rejected.push({
      directory: '(too many)',
      id: null,
      problems: [{
        severity: 'error',
        message: `Only the first ${PLUGIN_LIMITS.maxPlugins} plugins were considered.`,
      }],
    });
  }

  return { loaded, rejected };
}

/**
 * Merge plugin context rules into the application's own set.
 *
 * Built-ins go first and plugins after, so that if a namespacing bug ever let
 * an id collide, `sanitise` keeps the built-in. A plugin silently replacing a
 * shipped context would be invisible to the commander.
 */
export function mergeContextRules(
  base: ContextRuleSet,
  plugins: readonly LoadedPlugin[],
): ContextRuleSet {
  const extra = plugins.flatMap((p) => p.contextRules);
  if (extra.length === 0) return base;
  return sanitise({ ...base, rules: [...base.rules, ...extra] });
}
