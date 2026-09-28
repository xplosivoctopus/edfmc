/**
 * Manifest compatibility.
 *
 * Two things are being protected here. That a pack which needs something this
 * build cannot provide is refused *with a reason*, before activation — loading it
 * and behaving oddly is how a plugin system loses the commander's trust. And that
 * v1 manifests keep working, because the migration promise in docs/EXTENSIONS.md
 * is only worth anything if a test holds it.
 */

import { describe, expect, it } from 'vitest';

import {
  EXTENSION_API,
  MINIMUM_MANIFEST_VERSION,
  SUPPORTED_MANIFEST_VERSION,
  checkCompatibility,
  loadPlugins,
  parseRange,
  satisfies,
  validatePlugin,
  type PluginManifest,
} from '../src/index.js';

const HERE = '0.1.0';

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    id: 'com.example.pack',
    name: 'Example',
    version: '1.0.0',
    contributes: {},
    ...over,
  } as PluginManifest;
}

/** A minimal valid contribution: the validator refuses a plugin that offers nothing. */
const RULE = {
  id: 'r',
  title: 'R',
  when: { kind: 'event', name: 'Music' },
  priority: 10,
  ttlSeconds: 60,
  resources: [],
};

function raw(m: Record<string, unknown>, directory = 'example') {
  const filled = { contributes: { contextRules: [RULE] }, ...m };
  return { directory, json: JSON.stringify(filled), readme: null };
}

describe('version ranges', () => {
  it('accepts the five forms it documents', () => {
    expect(satisfies('1.2.3', '*')).toBe(true);
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '^1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '~1.2.3')).toBe(true);
    expect(satisfies('0.5.0', '>=0.3.0 <1.0.0')).toBe(true);
  });

  it('treats the minor as breaking below 1.0.0, as npm does', () => {
    // The project is pre-1.0, so this is the case that actually matters: a pack
    // written against 0.3 must not silently load against 0.4.
    expect(satisfies('0.3.9', '^0.3.1')).toBe(true);
    expect(satisfies('0.4.0', '^0.3.1')).toBe(false);
    // And above 1.0.0 the major is breaking.
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
  });

  it('bounds ~ to the same minor', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('requires every comparator in a conjunction', () => {
    expect(satisfies('1.0.0', '>=0.3.0 <1.0.0')).toBe(false);
    expect(satisfies('0.2.9', '>=0.3.0 <1.0.0')).toBe(false);
  });

  it('rejects a range it does not understand rather than matching everything', () => {
    // The important failure mode. An unparseable range that defaulted to "yes"
    // would make every compatibility declaration meaningless.
    for (const bad of ['1.x', '>=1.0.0 || <2.0.0', 'latest', '1.2.3-beta.1+build', '', '  ']) {
      expect(parseRange(bad), bad).toBeNull();
      expect(satisfies('1.2.3', bad), bad).toBe(false);
    }
  });

  it('rejects an absurdly long range without evaluating it', () => {
    expect(parseRange('>=1.0.0 '.repeat(50))).toBeNull();
  });
});

describe('compatibility', () => {
  it('accepts a manifest that asks for nothing', () => {
    expect(checkCompatibility(manifest(), { companionVersion: HERE })).toEqual({ ok: true });
  });

  it('refuses a manifest version from the future, and says to update the app', () => {
    const result = checkCompatibility(
      manifest({ manifestVersion: SUPPORTED_MANIFEST_VERSION + 1 }),
      { companionVersion: HERE },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('Update EDFM Companion');
  });

  it('still accepts the oldest supported manifest version', () => {
    const result = checkCompatibility(manifest({ manifestVersion: MINIMUM_MANIFEST_VERSION }), {
      companionVersion: HERE,
    });
    expect(result).toEqual({ ok: true });
  });

  it('refuses a tier this build cannot run, rather than loading it as inert data', () => {
    // A capability plugin loaded as data would leave its author certain their
    // code was running. Failing closed with an explanation is the whole point.
    for (const kind of ['capability', 'advanced'] as const) {
      const result = checkCompatibility(manifest({ kind }), { companionVersion: HERE });
      expect(result.ok, kind).toBe(false);
      expect(result.ok === false && result.reason).toContain('Community Packs');
    }
  });

  it('names what was wanted and what is available when the app is too old', () => {
    const result = checkCompatibility(
      manifest({ requires: { edfmCompanion: '>=9.0.0' } }),
      { companionVersion: HERE },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('>=9.0.0');
    expect(result.ok === false && result.reason).toContain(HERE);
  });

  it('checks the plugin API independently of the app version', () => {
    const tooNew = checkCompatibility(manifest({ requires: { pluginApi: `^${EXTENSION_API.manifest + 1}.0` } }), {
      companionVersion: HERE,
    });
    expect(tooNew.ok).toBe(false);

    const fine = checkCompatibility(manifest({ requires: { pluginApi: `^${EXTENSION_API.manifest}.0` } }), {
      companionVersion: HERE,
    });
    expect(fine).toEqual({ ok: true });
  });

  it('treats an unparseable requirement as a manifest error, not as "anything"', () => {
    const result = checkCompatibility(manifest({ requires: { edfmCompanion: 'newest' } }), {
      companionVersion: HERE,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a version range');
  });
});

describe('loading, end to end', () => {
  it('loads a v1 manifest exactly as before', () => {
    // The migration promise. v1 packs keep working indefinitely; an author
    // upgrades to declare things, not to keep functioning.
    const result = validatePlugin(
      raw({
        manifestVersion: 1,
        id: 'com.example.legacy',
        name: 'Legacy',
        version: '1.0.0',
        contributes: {
          contextRules: [
            {
              id: 'r',
              title: 'R',
              when: { kind: 'event', name: 'Music' },
              priority: 10,
              ttlSeconds: 60,
              resources: [],
            },
          ],
        },
      }),
    );
    expect('problems' in result).toBe(false);
    if (!('problems' in result)) {
      expect(result.manifest.manifestVersion).toBe(1);
      expect(result.contextRules).toHaveLength(1);
    }
  });

  it('loads a v2 manifest with satisfiable requirements', () => {
    const result = validatePlugin(
      raw({
        manifestVersion: 2,
        id: 'com.example.modern',
        name: 'Modern',
        version: '1.0.0',
        kind: 'community-pack',
        requires: { edfmCompanion: '>=0.1.0 <1.0.0', pluginApi: '^2.0' },
      }),
      { companionVersion: HERE },
    );
    expect('problems' in result).toBe(false);
    if (!('problems' in result)) {
      expect(result.manifest.requires?.pluginApi).toBe('^2.0');
    }
  });

  it('rejects an incompatible plugin by id, so the UI can name it', () => {
    const result = validatePlugin(
      raw({
        manifestVersion: 2,
        id: 'com.example.future',
        name: 'Future',
        version: '1.0.0',
        requires: { edfmCompanion: '>=9.0.0' },
      }),
      { companionVersion: HERE },
    );
    expect('problems' in result).toBe(true);
    if ('problems' in result) {
      // Named rather than anonymous: "a plugin was rejected" is not actionable.
      expect(result.id).toBe('com.example.future');
      expect(result.problems[0]!.message).toContain('9.0.0');
    }
  });

  it('keeps the compatible ones when one is incompatible', () => {
    const result = loadPlugins(
      [
        raw({ manifestVersion: 2, id: 'com.example.ok', name: 'OK', version: '1.0.0' }, 'ok'),
        raw(
          {
            manifestVersion: 2,
            id: 'com.example.no',
            name: 'No',
            version: '1.0.0',
            requires: { pluginApi: '^99.0' },
              },
          'no',
        ),
      ],
      { companionVersion: HERE },
    );
    expect(result.loaded.map((p) => p.manifest.id)).toEqual(['com.example.ok']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.directory).toBe('no');
  });

  it('refuses a malformed requires block as a manifest error', () => {
    const result = validatePlugin(
      raw({
        manifestVersion: 2,
        id: 'com.example.bad',
        name: 'Bad',
        version: '1.0.0',
        requires: 'please work',
      }),
    );
    expect('problems' in result).toBe(true);
    if ('problems' in result) {
      expect(result.problems[0]!.message).toContain('"requires" must be an object');
    }
  });
});
