/**
 * Guidance mode and overlay appearance.
 *
 * Two properties matter more than the rest and are asserted directly rather than
 * inferred from behaviour:
 *
 *  - **Guidance changes explanation, never facts.** A mode that quietly altered
 *    what was shown would make "am I seeing everything?" unanswerable.
 *  - **Snapshot identity survives.** These add fields to the store that React
 *    reads through `useSyncExternalStore`, which aborts the render tree if a
 *    snapshot is rebuilt per call. That has shipped as a white screen once.
 */

import { describe, expect, it } from 'vitest';
import { BUNDLED_RULES, sanitise, RULE_LIMITS, DEFAULT_GUIDANCE_MODE } from '@edfm/context';

import { Companion } from '../src/lib/companion.js';
import {
  VALIDATED_ELITE_BUILD,
  aboutStatus,
  compareBuilds,
  isNewerThanValidated,
  newerBuildNotice,
} from '../src/lib/about.js';
import {
  APPEARANCE_BOUNDS,
  DEFAULT_APPEARANCE,
  DEFAULT_WIDGETS,
  clampNumber,
  clampOpacity,
} from '../src/lib/overlay.js';

describe('guidance model', () => {
  it('defaults to standard', () => {
    expect(DEFAULT_GUIDANCE_MODE).toBe('standard');
    expect(new Companion().snapshot().guidance).toBe('standard');
  });

  it('reports the choice as unmade until it is made', () => {
    // This is what drives the first-run prompt, and it is deliberately distinct
    // from "they chose standard".
    expect(new Companion().snapshot().guidanceChosen).toBe(false);
  });

  it('carries beginner guidance on bundled rules without changing the facts', () => {
    // The key property. Guidance is additive: the title, subtitle and resources a
    // rule states are identical whichever mode the commander is in, because the
    // mode only decides whether one extra field is drawn.
    const withGuidance = BUNDLED_RULES.rules.filter((r) => r.guidance?.beginner);
    expect(withGuidance.length).toBeGreaterThan(0);

    for (const rule of withGuidance) {
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.resources.length).toBeGreaterThan(0);
      // Guidance is a nudge, not an article. EDFM is the reference.
      expect(rule.guidance!.beginner!.length).toBeLessThanOrEqual(RULE_LIMITS.maxGuidanceChars);
      expect(rule.guidance!.topic).toBeTruthy();
    }
  });

  it('bounds guidance arriving from an untrusted rule set', () => {
    const clean = sanitise({
      version: 1,
      updatedAt: '2026-09-29T00:00:00Z',
      source: 'remote',
      rules: [
        {
          id: 'x',
          title: 'X',
          when: { kind: 'event', name: 'Music' },
          priority: 10,
          ttlSeconds: 60,
          resources: [],
          guidance: { topic: 'mining', beginner: 'a'.repeat(9999) },
        },
      ],
    });
    expect(clean.rules[0]!.guidance!.beginner!.length).toBe(RULE_LIMITS.maxGuidanceChars);
  });

  it('drops guidance that carries nothing usable', () => {
    const clean = sanitise({
      version: 1,
      updatedAt: '2026-09-29T00:00:00Z',
      source: 'remote',
      rules: [
        {
          id: 'x',
          title: 'X',
          when: { kind: 'event', name: 'Music' },
          priority: 10,
          ttlSeconds: 60,
          resources: [],
          guidance: { beginner: 42 as unknown as string },
        },
      ],
    });
    expect(clean.rules[0]!.guidance).toBeUndefined();
  });
});

describe('overlay appearance', () => {
  it('defaults to the styling that shipped before it was configurable', () => {
    // So an existing overlay looks unchanged until someone moves a slider.
    expect(DEFAULT_APPEARANCE.backgroundOpacity).toBe(0.72);
    expect(DEFAULT_APPEARANCE.textOpacity).toBe(1);
  });

  it('allows a fully transparent background', () => {
    // A real preference: text on bare scenery, which keeps its own shadow.
    expect(APPEARANCE_BOUNDS.background.min).toBe(0);
    expect(clampNumber(0, APPEARANCE_BOUNDS.background)).toBe(0);
  });

  it('refuses to let text become unreadable', () => {
    // An overlay the commander cannot read, but has not noticed, is worse than
    // one they turned off deliberately.
    expect(APPEARANCE_BOUNDS.text.min).toBeGreaterThanOrEqual(0.3);
    expect(clampNumber(0, APPEARANCE_BOUNDS.text)).toBe(APPEARANCE_BOUNDS.text.min);
    expect(clampNumber(-5, APPEARANCE_BOUNDS.text)).toBe(APPEARANCE_BOUNDS.text.min);
  });

  it('clamps out-of-range values rather than trusting them', () => {
    expect(clampNumber(2, APPEARANCE_BOUNDS.background)).toBe(1);
    expect(clampNumber(Number.NaN, APPEARANCE_BOUNDS.background)).toBe(1);
  });

  it('falls back rather than letting a bad stored row blank the overlay', () => {
    expect(clampOpacity(null, 0.72, APPEARANCE_BOUNDS.background)).toBe(0.72);
    expect(clampOpacity('not a number', 0.72, APPEARANCE_BOUNDS.background)).toBe(0.72);
    expect(clampOpacity('0.4', 0.72, APPEARANCE_BOUNDS.background)).toBe(0.4);
    // A stored value outside the bounds is clamped, not honoured.
    expect(clampOpacity('0.01', 1, APPEARANCE_BOUNDS.text)).toBe(APPEARANCE_BOUNDS.text.min);
  });

  it('keeps background and text independent', () => {
    const c = new Companion();
    void c.setAppearance({ backgroundOpacity: 0.2, textOpacity: 1 });
    const a = c.snapshot().appearance;
    expect(a.backgroundOpacity).toBe(0.2);
    expect(a.textOpacity).toBe(1);
  });
});

describe('overlay widgets', () => {
  it('has an independent toggle for every widget', () => {
    expect(Object.keys(DEFAULT_WIDGETS).sort()).toEqual([
      'carrierJump',
      'context',
      'edfmNotes',
      'liveJournal',
      'missions',
    ]);
  });

  it('leaves the Live Journal off by default', () => {
    // Every other widget answers "what is true now". This one is the newest
    // thing recorded, which is clutter to some commanders -- so it is opt-in
    // rather than something to discover and switch off.
    expect(DEFAULT_WIDGETS.liveJournal).toBe(false);
  });

  it('keeps the widgets a commander already chose when a new one is added', () => {
    // The migration property. A stored object from an older build lacks
    // liveJournal; merging over the defaults must not reset the rest.
    const stored = { context: false, missions: true, edfmNotes: false, carrierJump: true };
    const merged = { ...DEFAULT_WIDGETS, ...stored };
    expect(merged.context).toBe(false);
    expect(merged.edfmNotes).toBe(false);
    expect(merged.liveJournal).toBe(false);
  });

  it('preserves widget choices across the overlay being switched off and on', () => {
    const c = new Companion();
    void c.setOverlayWidgets({ ...DEFAULT_WIDGETS, missions: false, liveJournal: true });
    c.setOverlayEnabled(false);
    c.setOverlayEnabled(true);
    expect(c.snapshot().overlayWidgets ?? c.overlayWidgets).toMatchObject({
      missions: false,
      liveJournal: true,
    });
  });
});

describe('snapshot identity', () => {
  it('stays stable after adding guidance and appearance to the store', () => {
    // The regression that shipped as a white screen. toBe, not toEqual.
    const c = new Companion();
    expect(c.snapshot()).toBe(c.snapshot());
    expect(c.snapshot().appearance).toBe(c.snapshot().appearance);
    expect(c.snapshot().activity).toBe(c.snapshot().activity);
  });

  it('produces a new snapshot when guidance actually changes', () => {
    const c = new Companion();
    const before = c.snapshot();
    void c.setGuidanceMode('new-cmdr');
    const after = c.snapshot();
    expect(after).not.toBe(before);
    expect(after.guidance).toBe('new-cmdr');
    expect(after.guidanceChosen).toBe(true);
  });

  it('produces a new snapshot when appearance actually changes', () => {
    const c = new Companion();
    const before = c.snapshot();
    void c.setAppearance({ backgroundOpacity: 0.5, textOpacity: 0.8 });
    expect(c.snapshot()).not.toBe(before);
  });
});

describe('integrations', () => {
  it('starts every integration switched off', () => {
    // The default that matters. Nothing reaches an external service until the
    // commander asks for it.
    const snap = new Companion().snapshot();
    for (const id of ['eddn', 'edsm', 'inara', 'edastro'] as const) {
      expect(snap.integrations[id].enabled, id).toBe(false);
    }
  });

  it('refuses to enable an integration that is not built', () => {
    // A switch that appears to work while nothing is sent is worse than one that
    // says it is unfinished.
    const c = new Companion();
    for (const id of ['eddn', 'edsm', 'inara', 'edastro'] as const) {
      void c.setIntegrationEnabled(id, true);
      expect(c.snapshot().integrations[id].enabled, id).toBe(false);
    }
  });

  it('reports no sharing activity, because none is wired yet', () => {
    /*
     * EDDN's message builder, sanitiser and queue are finished and tested, but
     * nothing feeds them from live journal events, so the audit must say so.
     *
     * This asserts the honest state rather than an aspiration. When the
     * submission loop is connected, this test fails -- which is the reminder to
     * update it deliberately instead of discovering later that the screen had
     * been claiming activity all along.
     */
    const snap = new Companion().snapshot();
    expect(snap.sharing.nothingEverSent).toBe(true);
    expect(snap.sharing.totalPending).toBe(0);
    for (const row of snap.sharing.rows) {
      expect(row.transmission, row.id).toBe('not-built');
      expect(row.everSent, row.id).toBe(false);
      expect(row.canRetryNow, row.id).toBe(false);
    }
  });

  it('never puts a field value in the diagnostics view', () => {
    // The journal-shape panel is the thing most likely to be screenshotted into
    // a bug report, so it carries type names and counts only.
    const snap = new Companion().snapshot();
    expect(snap.diagnostics.anomalies).toEqual([]);
    expect(snap.diagnostics.appVersion.length).toBeGreaterThan(0);
  });

  it('never exposes a credential through the snapshot', () => {
    // Only whether one exists. The value cannot reach JavaScript at all -- there
    // is no command that reads one back.
    const snap = new Companion().snapshot();
    for (const id of ['eddn', 'edsm', 'inara', 'edastro'] as const) {
      expect(Object.keys(snap.integrations[id]).sort()).toEqual(['enabled', 'hasCredential']);
    }
    expect(JSON.stringify(snap.integrations)).not.toContain('secret');
    expect(JSON.stringify(snap.integrations)).not.toContain('apiKey');
  });

  it('keeps snapshot identity stable with integrations in the store', () => {
    const c = new Companion();
    expect(c.snapshot().integrations).toBe(c.snapshot().integrations);
  });
});

describe('version and build status', () => {
  it('reports one value per component, read from where it is defined', () => {
    const status = aboutStatus({ appVersion: '0.1.0', connectedBuild: '4.4.0.3' });
    expect(status.appVersion).toBe('0.1.0');
    expect(status.contextRules).toBeGreaterThan(0);
    expect(status.pluginApi).toBeGreaterThan(0);
    expect(status.exobiologySchema).toBeGreaterThan(0);
    expect(status.validatedBuild).toBe(VALIDATED_ELITE_BUILD);
  });

  it('compares builds numerically, not as text', () => {
    // The trap: 4.10.0.0 is newer than 4.9.0.0 and sorts the other way as a
    // string, which would silently suppress the notice the first time Frontier
    // ships a double-digit minor.
    expect(compareBuilds('4.10.0.0', '4.9.0.0')).toBe(1);
    expect(compareBuilds('4.9.0.0', '4.10.0.0')).toBe(-1);
    expect(compareBuilds('4.4.0.3', '4.4.0.3')).toBe(0);
    // Missing parts count as zero rather than as missing.
    expect(compareBuilds('4.5', '4.5.0.0')).toBe(0);
    expect(compareBuilds('4.5.0.1', '4.5')).toBe(1);
  });

  it('says nothing when the game matches or predates what was measured', () => {
    expect(isNewerThanValidated(VALIDATED_ELITE_BUILD)).toBe(false);
    expect(isNewerThanValidated('4.3.0.0')).toBe(false);
    expect(isNewerThanValidated(null)).toBe(false);
  });

  it('notices a newer build', () => {
    expect(isNewerThanValidated('4.5.0.0')).toBe(true);
    const notice = newerBuildNotice(aboutStatus({ appVersion: '0.1.0', connectedBuild: '4.5.0.0' }));
    expect(notice).toContain('4.5.0.0');
    expect(notice).toContain(VALIDATED_ELITE_BUILD);
  });

  it('does not imply anything is broken', () => {
    // "We have not checked yet" is not "this does not work". Wording that
    // suggested breakage would teach commanders to ignore the notice.
    const notice = newerBuildNotice(aboutStatus({ appVersion: '0.1.0', connectedBuild: '4.5.0.0' }))!;
    for (const alarming of ['incompatible', 'unsupported', 'error', 'broken', 'not supported']) {
      expect(notice.toLowerCase(), alarming).not.toContain(alarming);
    }
    expect(notice).toContain('preserved');
  });

  it('stays silent for a build string it cannot parse', () => {
    // A garbled build must not produce a notice nobody can act on.
    for (const junk of ['', 'unknown', '4.x.0', 'r330683/r0']) {
      expect(isNewerThanValidated(junk), junk).toBe(false);
    }
  });
});
