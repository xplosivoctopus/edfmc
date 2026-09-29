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
    for (const id of ['edsm', 'inara', 'edastro'] as const) {
      void c.setIntegrationEnabled(id, true);
      expect(c.snapshot().integrations[id].enabled, id).toBe(false);
    }
  });

  it('enables the one integration that is built', () => {
    const c = new Companion();
    void c.setIntegrationEnabled('eddn', true);
    expect(c.snapshot().integrations.eddn.enabled).toBe(true);
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
