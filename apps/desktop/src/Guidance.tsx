/**
 * Guidance mode: how much explanation to show.
 *
 * Two components share one idea and are kept together because the wording must
 * not drift apart — the first-run card and the Settings control say the same
 * thing in the same words.
 *
 * The mode changes **only** how much is explained. It never hides a feature,
 * never changes a value, and never alters which facts are shown. A setting that
 * quietly disabled things would make "am I seeing everything?" unanswerable.
 */

import { DEFAULT_GUIDANCE_MODE, type GuidanceMode } from '@edfm/context';

import { companion } from './lib/companion.js';

const OPTIONS: ReadonlyArray<{
  mode: GuidanceMode;
  label: string;
  description: string;
}> = [
  {
    mode: 'standard',
    label: 'Standard',
    description:
      'Relevant information and EDFM guidance, without explaining mechanics you already know.',
  },
  {
    mode: 'new-cmdr',
    label: 'New CMDR Mode',
    description: 'Adds a short explanation of what a thing is, as it comes up while you play.',
  },
];

/**
 * Shown once, before the commander has ever chosen.
 *
 * Not shown to an existing installation: an upgrade takes the Standard default
 * silently rather than being stopped by a question about a setting that did not
 * exist when they installed. See `hasAnySetting` in companion.ts.
 */
export function FirstRunGuidance() {
  return (
    <section className="card">
      <h2>Welcome to EDFM Companion</h2>
      <p className="muted">
        How much guidance would you like? This only changes how much is explained — every
        feature is available either way, and you can change it any time in Settings.
      </p>
      <GuidanceChoice autoFocus />
    </section>
  );
}

/** The control itself, used by both the first-run card and Settings. */
export function GuidanceChoice({ autoFocus = false }: { autoFocus?: boolean }) {
  const mode = companion.snapshot().guidance ?? DEFAULT_GUIDANCE_MODE;

  return (
    <div className="guidance-choice" role="radiogroup" aria-label="Guidance level">
      {OPTIONS.map((option, index) => (
        <label
          key={option.mode}
          className={option.mode === mode ? 'guidance-option guidance-on' : 'guidance-option'}
        >
          <input
            type="radio"
            name="guidance"
            value={option.mode}
            checked={option.mode === mode}
            autoFocus={autoFocus && index === 0}
            onChange={() => void companion.setGuidanceMode(option.mode)}
          />
          <span>
            {/* Never colour alone: the selected option is also the checked radio. */}
            <strong>{option.label}</strong>
            <span className="muted-inline"> — {option.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
