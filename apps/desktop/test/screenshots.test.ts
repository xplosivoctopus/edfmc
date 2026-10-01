/**
 * Screenshot cataloguing rules.
 *
 * The properties worth protecting here are mostly refusals: no invented
 * subject, no silent overwrite, no automatic link, no filename Windows will
 * reject. Each of those is cheap to get wrong and expensive to discover later.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CATEGORY,
  MAX_STEM,
  SCREENSHOT_CATEGORIES,
  TAG_LIMITS,
  bindingFromEvent,
  categoryLabel,
  describeHotkey,
  normaliseTags,
  placeName,
  prefill,
  proposeFilename,
  resolveCollision,
  sanitiseSegment,
  timestampPart,
  validateHotkey,
  type CaptureContext,
} from '../src/lib/screenshots.js';

const emptyContext: CaptureContext = {
  systemName: null,
  bodyName: null,
  stationName: null,
  settlement: null,
  shipName: null,
  sampling: null,
  latestEntry: null,
};

describe('categories', () => {
  it('offers a usable list with stable ids', () => {
    const ids = SCREENSHOT_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['exobiology', 'exploration', 'mining', 'colonisation', 'other']) {
      expect(ids).toContain(id);
    }
  });

  it('gives every category a hint, so the choice is not a guess at a word', () => {
    for (const c of SCREENSHOT_CATEGORIES) {
      expect(c.hint.length, c.id).toBeGreaterThan(0);
      expect(c.label.length, c.id).toBeGreaterThan(0);
    }
  });

  it('falls back to the id rather than showing nothing for an unknown category', () => {
    // Categories are data, so a row written by a later version must still render.
    expect(categoryLabel('warp-core')).toBe('warp-core');
  });
});

describe('prefill: what it will and will not claim', () => {
  it('proposes the specimen only while it is actually being sampled', () => {
    const p = prefill({
      ...emptyContext,
      systemName: 'Wregoe XX-X d1-42',
      bodyName: '3 A',
      sampling: {
        species: 'Bacterium Vesicula',
        genus: 'Bacterium',
        colour: 'Gold',
        samplesTaken: 2,
        samplesRequired: 3,
        completed: false,
      },
    });
    expect(p.category.value).toBe('exobiology');
    expect(p.subject?.value).toBe('Bacterium Vesicula — Gold');
    expect(p.systemName).toBe('Wregoe XX-X d1-42');
    expect(p.bodyName).toBe('3 A');
    expect(p.tags).toContain('Bacterium');
    expect(p.tags).toContain('Gold');
  });

  it('says why it filled each field', () => {
    // A suggestion presented without a reason reads as a fact.
    const p = prefill({ ...emptyContext, stationName: 'Jameson Memorial' });
    expect(p.category.because.length).toBeGreaterThan(0);
    expect(p.subject?.because.length).toBeGreaterThan(0);
  });

  it('never invents a subject from a body alone', () => {
    /*
     * The central refusal. Standing on a body says where the commander is and
     * nothing about what is in frame -- they may be photographing their ship,
     * the rings, or a menu.
     */
    const p = prefill({ ...emptyContext, systemName: 'Nervi', bodyName: 'Nervi 4 a' });
    expect(p.subject).toBeNull();
    expect(p.category.value).toBe('exploration');
    expect(p.bodyName).toBe('Nervi 4 a');
  });

  it('claims nothing at all when nothing is known', () => {
    const p = prefill(emptyContext);
    expect(p.category.value).toBe(DEFAULT_CATEGORY);
    expect(p.subject).toBeNull();
    expect(p.tags).toEqual([]);
    expect(p.suggestedLink).toBeNull();
  });

  it('prefers the station when docked', () => {
    const p = prefill({
      ...emptyContext,
      systemName: 'Shinrarta Dezhra',
      stationName: 'Jameson Memorial',
    });
    expect(p.category.value).toBe('station');
    expect(p.subject?.value).toBe('Jameson Memorial');
  });

  it('handles a specimen with no variant colour', () => {
    const p = prefill({
      ...emptyContext,
      sampling: {
        species: 'Roseum Brain Tree',
        genus: 'Brain Trees',
        colour: null,
        samplesTaken: 1,
        samplesRequired: 3,
        completed: false,
      },
    });
    expect(p.subject?.value).toBe('Roseum Brain Tree');
  });
});

describe('journal linking is offered, never applied', () => {
  const entry = (minutesAgo: number) => ({
    id: 'Journal.log:42',
    title: 'Bacterium Vesicula — Gold',
    occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    category: 'exobiology',
  });

  it('suggests a recent entry', () => {
    const p = prefill({ ...emptyContext, latestEntry: entry(2) });
    expect(p.suggestedLink?.id).toBe('Journal.log:42');
  });

  it('does not suggest a stale entry', () => {
    /*
     * An entry from two hours ago is not what this screenshot is of, and
     * offering it would train commanders to click past the link rather than
     * read it.
     */
    const p = prefill({ ...emptyContext, latestEntry: entry(120) });
    expect(p.suggestedLink).toBeNull();
  });

  it('ignores an entry with an unreadable timestamp', () => {
    const p = prefill({
      ...emptyContext,
      latestEntry: { ...entry(1), occurredAt: 'not a date' },
    });
    expect(p.suggestedLink).toBeNull();
  });
});

describe('filename sanitisation', () => {
  it('replaces every character Windows reserves', () => {
    const out = sanitiseSegment('a<b>c:d"e/f\\g|h?i*j');
    for (const bad of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(out, bad).not.toContain(bad);
    }
  });

  it('replaces rather than strips, so words do not run together', () => {
    // "3/A" becoming "3A" would quietly change a body's name.
    expect(sanitiseSegment('3/A')).toBe('3-A');
  });

  it('removes trailing dots and spaces', () => {
    /*
     * Windows accepts these through some APIs and then cannot delete the file
     * through Explorer, which is worse than refusing them here.
     */
    expect(sanitiseSegment('Screenshot.')).toBe('Screenshot');
    expect(sanitiseSegment('Screenshot ')).toBe('Screenshot');
  });

  it('escapes reserved device names', () => {
    // `CON.png` cannot be created on Windows at all.
    expect(sanitiseSegment('CON')).toBe('_CON');
    expect(sanitiseSegment('con')).toBe('_con');
    expect(sanitiseSegment('LPT1')).toBe('_LPT1');
    // A name that merely starts with one is fine.
    expect(sanitiseSegment('Concha')).toBe('Concha');
  });

  it('keeps the em dash this app uses for variants', () => {
    expect(sanitiseSegment('Bacterium Vesicula — Gold')).toBe('Bacterium Vesicula — Gold');
  });

  it('strips control characters', () => {
    expect(sanitiseSegment('a\u0000b\u001fc')).toBe('a-b-c');
  });

  it('collapses whitespace runs', () => {
    expect(sanitiseSegment('a    b')).toBe('a b');
  });
});

describe('filename generation', () => {
  const at = '2026-09-30T14:22:18';

  it('builds subject, place and time', () => {
    expect(
      proposeFilename({
        subject: 'Bacterium Vesicula — Gold',
        systemName: 'Wregoe XX-X d1-42',
        bodyName: '3 A',
        capturedAt: at,
        extension: '.png',
      }),
    ).toBe('Bacterium Vesicula — Gold - Wregoe XX-X d1-42 3 A - 2026-09-30 14-22-18.png');
  });

  it('drops empty parts instead of leaving gaps', () => {
    const name = proposeFilename({
      subject: null,
      systemName: null,
      bodyName: null,
      capturedAt: at,
      extension: '.png',
    });
    expect(name).toBe('2026-09-30 14-22-18.png');
    expect(name).not.toContain(' -  - ');
  });

  it('uses dashes in the time, because colons are illegal', () => {
    expect(timestampPart(at)).toBe('2026-09-30 14-22-18');
    expect(timestampPart(at)).not.toContain(':');
  });

  it('preserves and lower-cases the extension', () => {
    const name = proposeFilename({
      subject: 'Ship',
      systemName: null,
      bodyName: null,
      capturedAt: at,
      extension: '.PNG',
    });
    expect(name.endsWith('.png')).toBe(true);
  });

  it('bounds the length but never truncates the timestamp', () => {
    /*
     * The tail is what keeps names distinct, so cutting it would manufacture
     * the collisions the suffix logic exists to avoid.
     */
    const name = proposeFilename({
      subject: 'x'.repeat(400),
      systemName: 'y'.repeat(200),
      bodyName: null,
      capturedAt: at,
      extension: '.png',
    });
    expect(name.length).toBeLessThanOrEqual(MAX_STEM + 4);
    expect(name).toContain('2026-09-30 14-22-18');
  });

  it('produces a name with no reserved characters even from hostile input', () => {
    const name = proposeFilename({
      subject: 'a/b\\c:d*e?f"g<h>i|j',
      systemName: 'sys:tem',
      bodyName: null,
      capturedAt: at,
      extension: '.png',
    });
    const stem = name.slice(0, name.lastIndexOf('.'));
    for (const bad of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(stem, bad).not.toContain(bad);
    }
  });
});

describe('collision handling', () => {
  it('returns the name unchanged when nothing is in the way', () => {
    expect(resolveCollision('a.png', () => false)).toBe('a.png');
  });

  it('counts up deterministically', () => {
    const taken = new Set(['a.png', 'a (2).png', 'a (3).png']);
    expect(resolveCollision('a.png', (n) => taken.has(n))).toBe('a (4).png');
  });

  it('puts the suffix before the extension, so the file still opens', () => {
    const name = resolveCollision('shot.png', (n) => n === 'shot.png');
    expect(name).toBe('shot (2).png');
    expect(name.endsWith('.png')).toBe(true);
  });

  it('never returns a name that already exists', () => {
    /*
     * The property that matters: §11 forbids silently overwriting a
     * screenshot, which is not recoverable.
     */
    const taken = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const name = resolveCollision('a.png', (n) => taken.has(n));
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('still avoids a clash past the counting limit', () => {
    const name = resolveCollision('a.png', () => true, 3);
    expect(name).not.toBe('a.png');
    expect(name.endsWith('.png')).toBe(true);
  });

  it('handles a name with no extension', () => {
    expect(resolveCollision('noext', (n) => n === 'noext')).toBe('noext (2)');
  });
});

describe('tags', () => {
  it('drops blanks and duplicates, case-insensitively', () => {
    expect(normaliseTags(['Gold', ' gold ', '', '  ', 'Bacterium'])).toEqual([
      'Gold',
      'Bacterium',
    ]);
  });

  it('bounds the count and the length', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(normaliseTags(many).length).toBe(TAG_LIMITS.maxTags);
    expect(normaliseTags(['x'.repeat(100)])[0]!.length).toBe(TAG_LIMITS.maxTagChars);
  });
});

describe('hotkey validation', () => {
  it('accepts a modifier plus a key', () => {
    expect(validateHotkey('Control+Shift+F12').ok).toBe(true);
    expect(validateHotkey('Alt+S').ok).toBe(true);
  });

  it('refuses a bare key, and says why', () => {
    /*
     * A key with no modifier would fire while typing a system name into search.
     */
    const check = validateHotkey('F12');
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/Ctrl|modifier|type/i);
  });

  it('refuses modifiers alone', () => {
    expect(validateHotkey('Control+Shift').ok).toBe(false);
  });

  it('refuses two real keys', () => {
    expect(validateHotkey('Control+A+B').ok).toBe(false);
  });

  it('refuses an empty binding', () => {
    expect(validateHotkey('').ok).toBe(false);
  });
});

describe('capturing a binding from a key press', () => {
  const press = (over: Partial<Parameters<typeof bindingFromEvent>[0]>) =>
    bindingFromEvent({
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      key: 'a',
      code: 'KeyA',
      ...over,
    });

  it('builds a binding in a stable order', () => {
    expect(press({ ctrlKey: true, shiftKey: true, key: 'F12', code: 'F12' })).toBe(
      'Control+Shift+F12',
    );
  });

  it('returns null while only modifiers are held', () => {
    // Lets a "press a combination" field show progress without committing.
    expect(press({ ctrlKey: true, key: 'Control', code: 'ControlLeft' })).toBeNull();
  });

  it('reads letters and digits from the physical key, not the character', () => {
    /*
     * `key` changes with Shift and with layout -- Shift+5 is "%" on one keyboard
     * and something else on another. `code` is stable.
     */
    expect(press({ altKey: true, shiftKey: true, key: '%', code: 'Digit5' })).toBe(
      'Alt+Shift+5',
    );
    expect(press({ ctrlKey: true, key: 'A', code: 'KeyA' })).toBe('Control+A');
  });
});

describe('how a binding reads', () => {
  it('says so plainly when nothing is bound', () => {
    // Nothing is bound by default; the UI must not imply otherwise.
    expect(describeHotkey(null)).toBe('Not set');
  });

  it('uses the names on the keyboard', () => {
    expect(describeHotkey('Control+Shift+F12')).toBe('Ctrl + Shift + F12');
    expect(describeHotkey('Super+P')).toBe('Win + P');
  });
});

/* ------------------------------------------------------------- privacy */

/* Resolved from this file, not the working directory: the suite runs from
   the repo root as well as from the workspace. */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('screenshots never leave the machine', () => {
  /*
   * §20 and §21 are the constraints this feature could most easily violate by
   * accident, and the damage would not be recoverable: a screenshot can show a
   * commander's real name on a second monitor, their location, their finances,
   * or anything else that happened to be on screen.
   *
   * These are source guards rather than behavioural tests because the property
   * is an absence. There is no call to assert the absence of; what can be
   * asserted is that nothing in this feature reaches for the network.
   */
  it('has no network call anywhere in the screenshot code', () => {
    for (const file of ['lib/screenshots.ts', 'Screenshots.tsx']) {
      const src = read(file);
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'tauri-plugin-http', 'navigator.send']) {
        expect(src, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never sends a screenshot to an integration', () => {
    // EDDN, EDSM, Inara and EDAstro must not learn that a capture happened.
    const src = read('lib/screenshots.ts') + read('Screenshots.tsx');
    for (const service of ['eddn', 'edsm', 'inara', 'edastro']) {
      expect(src.toLowerCase(), service).not.toContain(service);
    }
  });

  it('keeps image paths out of the catalog code paths that log', () => {
    /*
     * A screenshot path names a folder under the commander's account and
     * usually their Windows username. Diagnostics say what failed, never where.
     */
    const companion = readFileSync(join(SRC, 'lib', 'companion.ts'), 'utf8');
    const screenshotLogs = companion
      .split('\n')
      .filter((line) => line.includes("logger.") && line.includes("'screenshot'"));

    expect(screenshotLogs.length).toBeGreaterThan(0);
    for (const line of screenshotLogs) {
      expect(line, line).not.toMatch(/filePath|stagingPath|\bpath\b *[,:}]/);
    }
  });

  it('sanitises anything path-shaped before it reaches a log', async () => {
    const { sanitisePath } = await import('../src/lib/companion.js');
    const windows = sanitisePath('failed to write C:\\Users\\Sythan\\Pictures\\shot.png');
    expect(windows).not.toContain('Sythan');
    expect(windows).toContain('<path>');

    const unc = sanitisePath('failed on \\\\NAS\\share\\shot.png');
    expect(unc).not.toContain('NAS');
  });

  it('bounds a sanitised message, so a huge error cannot flood a log', async () => {
    const { sanitisePath } = await import('../src/lib/companion.js');
    expect(sanitisePath('x'.repeat(5000)).length).toBeLessThanOrEqual(300);
  });
});

describe('nothing is bound or captured without being asked', () => {
  it('ships with no default hotkey', () => {
    /*
     * §1. Elite players run dense keyboard and HOTAS setups; silently claiming
     * a combination could break something they rely on mid-flight.
     */
    const src = read('lib/screenshots.ts');
    expect(src).toContain('Nothing is bound by default');
    // No literal binding sitting in a default.
    expect(src).not.toMatch(/DEFAULT_HOTKEY\s*=\s*['"`][^'"`]+['"`]/);
  });

  it('describes an unset hotkey as unset', () => {
    expect(describeHotkey(null)).toBe('Not set');
  });
});

describe('the form opens over the game, not inside the overlay', () => {
  it('is a window of its own, declared in the Tauri config', () => {
    /*
     * §23. The overlay must stay click-through: making it interactive for a
     * form and restoring it afterwards is exactly the state that gets left
     * switched on when an error path is taken. A second window cannot leave the
     * first in a bad state.
     */
    const conf = JSON.parse(
      readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
    ) as { app: { windows: Array<Record<string, unknown>> } };

    const capture = conf.app.windows.find((w) => w['label'] === 'capture');
    expect(capture, 'no capture window is declared').toBeTruthy();
    // Over the game, out of the taskbar, and focusable because it is typed into.
    expect(capture!['alwaysOnTop']).toBe(true);
    expect(capture!['skipTaskbar']).toBe(true);
    expect(capture!['focus']).toBe(true);
    // Hidden until a capture actually happens.
    expect(capture!['visible']).toBe(false);

    const overlay = conf.app.windows.find((w) => w['label'] === 'overlay');
    // The overlay is untouched and still never takes focus.
    expect(overlay!['focus']).toBe(false);
  });

  it('gives the capture window no database, filesystem or network access', () => {
    // It receives a draft by event and sends the answer back the same way.
    const caps = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../src-tauri/capabilities/capture.json', import.meta.url)),
        'utf8',
      ),
    ) as { windows: string[]; permissions: string[] };

    expect(caps.windows).toEqual(['capture']);
    for (const permission of caps.permissions) {
      expect(permission, permission).toMatch(/^core:(event|window|webview|app):/);
    }
    for (const forbidden of ['sql', 'http', 'fs', 'shell', 'global-shortcut']) {
      expect(caps.permissions.join(' '), forbidden).not.toContain(forbidden);
    }
  });

  it('never makes the overlay interactive', () => {
    /*
     * The guard that matters. `set_ignore_cursor_events` is how the overlay's
     * click-through is controlled, and nothing in the screenshot path may touch
     * it.
     */
    const companion = readFileSync(
      fileURLToPath(new URL('../src/lib/companion.ts', import.meta.url)),
      'utf8',
    );
    const captureSection = companion.slice(
      companion.indexOf('screenshots */'),
      companion.indexOf('activity journal */'),
    );
    expect(captureSection.length).toBeGreaterThan(0);
    for (const forbidden of ['overlay_set_edit_mode', 'set_ignore_cursor_events', 'setIgnoreCursorEvents']) {
      expect(captureSection, forbidden).not.toContain(forbidden);
    }
  });
});

describe('bugs found in the running app', () => {
  it('lets the capture window hide itself', () => {
    /*
     * It could not, and the symptom was an empty black panel left over the game
     * after saving: the form cleared its content but the `hide()` call was
     * denied, so the window stayed.
     *
     * `core:window:default` is **read-only** -- 28 permissions, all of them
     * getters. Hiding and closing have to be granted explicitly.
     */
    const caps = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../src-tauri/capabilities/capture.json', import.meta.url)),
        'utf8',
      ),
    ) as { permissions: string[] };

    expect(caps.permissions).toContain('core:window:allow-hide');
    expect(caps.permissions).toContain('core:window:allow-close');
  });

  it('opens a screenshot by OS path, never by a file:// URL', () => {
    /*
     * `file://C:\Users\...` is not a URL: the backslashes are not separators
     * and the drive letter parses as a host, so Open silently did nothing. The
     * opener plugin takes an OS path and handles each platform itself.
     */
    const src = readFileSync(
      fileURLToPath(new URL('../src/Screenshots.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('openPath(');
    // The broken construction must not come back anywhere in this file.
    expect(src).not.toMatch(/file:\/\/\$\{/);
    expect(src).not.toContain('openUrl(');
  });

  it('grants the opener the permission that makes that work', () => {
    // `opener:default` covers URLs and revealing an item, but not opening a path.
    const caps = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../src-tauri/capabilities/default.json', import.meta.url)),
        'utf8',
      ),
    ) as { permissions: Array<string | Record<string, unknown>> };

    const names = caps.permissions.filter((p): p is string => typeof p === 'string');
    expect(names).toContain('opener:allow-open-path');
    expect(names).toContain('opener:allow-reveal-item-in-dir');
  });

  it('does not prefill a body that merely repeats the system name', async () => {
    /*
     * In supercruise and witchspace the game reports the main star, whose name
     * is the system's. Prefilling it produced catalog rows reading
     * "Wregoe VQ-V b48-0 · Wregoe VQ-V b48-0".
     */
    const { prefill: build } = await import('../src/lib/screenshots.js');
    const p = build({
      ...emptyContext,
      systemName: 'Wregoe VQ-V b48-0',
      bodyName: null,
    });
    expect(p.bodyName).toBeNull();
    expect(p.systemName).toBe('Wregoe VQ-V b48-0');
  });
});

describe('a place is named once', () => {
  /*
   * Elite names bodies fully qualified -- the body in `Wregoe UC-L c24-1` is
   * called `Wregoe UC-L c24-1 A`. Joining system and body produced
   * `Wregoe UC-L c24-1 Wregoe UC-L c24-1 A`.
   */
  it('uses the body alone when it already carries the system', () => {
    expect(placeName('Wregoe UC-L c24-1', 'Wregoe UC-L c24-1 A')).toBe('Wregoe UC-L c24-1 A');
  });

  it('keeps both when the body has a name of its own', () => {
    // Measured: 9 of 8,831 pairs. These are exactly the cases where the system
    // adds something.
    expect(placeName('Sirius', 'Lucifer')).toBe('Sirius Lucifer');
    expect(placeName('Cai', 'Trango')).toBe('Cai Trango');
  });

  it('does not repeat a body identical to the system', () => {
    expect(placeName('Wregoe VQ-V b48-0', 'Wregoe VQ-V b48-0')).toBe('Wregoe VQ-V b48-0');
  });

  it('copes with either side missing', () => {
    expect(placeName('Nervi', null)).toBe('Nervi');
    expect(placeName(null, 'Nervi 4 a')).toBe('Nervi 4 a');
    expect(placeName(null, null)).toBeNull();
  });

  it('does not treat a merely similar prefix as qualified', () => {
    /*
     * `Wregoe UC-L c24-10` is a different system from `Wregoe UC-L c24-1`, so
     * the space in the prefix check is load-bearing.
     */
    expect(placeName('Wregoe UC-L c24-1', 'Wregoe UC-L c24-10 A')).toBe(
      'Wregoe UC-L c24-1 Wregoe UC-L c24-10 A',
    );
  });

  it('names the file with the place once', () => {
    const name = proposeFilename({
      subject: 'Stratum Tectonicas — Emerald',
      systemName: 'Wregoe UC-L c24-1',
      bodyName: 'Wregoe UC-L c24-1 A',
      capturedAt: '2026-09-30T14:22:18',
      extension: '.png',
    });
    expect(name).toBe(
      'Stratum Tectonicas — Emerald - Wregoe UC-L c24-1 A - 2026-09-30 14-22-18.png',
    );
    // The duplication that prompted this.
    expect(name).not.toContain('Wregoe UC-L c24-1 Wregoe UC-L c24-1');
  });
});

describe('the overlay stays out of the picture', () => {
  it('does not ask for the overlay to be included', () => {
    /*
     * The capture reads the composited screen, so anything drawn over the game
     * lands in the image -- including this app's own overlay. A vista with a
     * sample counter stamped across it is not the screenshot that was wanted,
     * so the Rust side hides it and the frontend never opts back in.
     */
    const companion = readFileSync(
      fileURLToPath(new URL('../src/lib/companion.ts', import.meta.url)),
      'utf8',
    );
    expect(companion).toContain("invoke<{");
    expect(companion).toContain("'capture_screenshot'");
    // Opting in would be `includeOverlay: true`.
    expect(companion).not.toMatch(/includeOverlay:\s*true/);
  });
});
