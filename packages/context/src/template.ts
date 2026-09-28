/**
 * Placeholder substitution in rule text.
 *
 * Rule titles and subtitles were fixed strings, so a rule could say "biological
 * signals detected" but never how many — the number is in the event the rule just
 * matched, and nothing carried it through.
 *
 * The syntax is deliberately tiny, because these strings arrive from the server and
 * from plugins and are rendered over the commander's game:
 *
 *   {event.Genuses.length}                  the resolved value
 *   {event.Genuses.length|signal|signals}   singular when the value is 1
 *
 * There is no expression language, no arithmetic and no function calls. A
 * placeholder names a path and nothing else, resolved by the same `readPath` the
 * conditions use, so prototype-walking segments and `*` bounds are inherited rather
 * than reimplemented. Scanning is a character walk rather than a regular
 * expression, for the same reason the condition schema has no regex operator: a
 * pattern supplied by a stranger must not be able to buy backtracking.
 *
 * Roots must be named explicitly (`event.` or `state.`). Defaulting to one of them
 * would make `{state}` mean different things depending on whether an event happened
 * to carry a field of that name.
 */

import { readPathValue } from './evaluate.js';
import { RULE_LIMITS } from './types.js';
import type { EvaluationInput } from './evaluate.js';

/** More than this in one string is a modelling error, not a use case. */
const MAX_PLACEHOLDERS = 8;

/**
 * Render `text`, substituting placeholders from the event and state.
 *
 * Returns `null` when any placeholder cannot be resolved. That is a real outcome,
 * not an error: "the game did not say how many" and "there are none" are different
 * facts, and a subtitle reading "undefined biological signals" would assert the
 * first as though it were a measurement. Callers decide what to do with nothing —
 * a subtitle is simply omitted.
 *
 * Text containing no placeholders is returned unchanged, so the overwhelming
 * majority of rules pay nothing for this.
 */
export function renderTemplate(text: string, input: EvaluationInput): string | null {
  if (!text.includes('{')) return text;
  if (text.length > RULE_LIMITS.maxStringLength) return null;

  let out = '';
  let i = 0;
  let placeholders = 0;

  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }

    const close = text.indexOf('}', open + 1);
    // An unclosed brace is literal text, not a broken placeholder. Rule authors
    // write prose, and prose contains braces.
    if (close === -1) {
      out += text.slice(i);
      break;
    }

    out += text.slice(i, open);
    placeholders += 1;
    if (placeholders > MAX_PLACEHOLDERS) return null;

    const rendered = renderOne(text.slice(open + 1, close), input);
    if (rendered === null) return null;
    out += rendered;

    i = close + 1;
  }

  return out.length > RULE_LIMITS.maxStringLength ? null : out;
}

/** One placeholder body: `path`, or `path|singular|plural`. */
function renderOne(body: string, input: EvaluationInput): string | null {
  const parts = body.split('|');
  const path = (parts[0] ?? '').trim();
  if (path.length === 0) return null;

  const value = resolve(path, input);
  if (value === null) return null;

  if (parts.length === 1) return value;

  // The plural form. Anything other than exactly two alternatives is malformed,
  // and a malformed placeholder must not silently render as something plausible.
  if (parts.length !== 3) return null;
  const singular = parts[1] ?? '';
  const plural = parts[2] ?? '';
  return Number(value) === 1 ? singular : plural;
}

/**
 * Resolve one dotted path against an explicitly named root.
 *
 * Only primitives render. An object or array has no honest one-line form, and
 * quietly printing `[object Object]` over someone's game is worse than saying
 * nothing.
 */
function resolve(path: string, input: EvaluationInput): string | null {
  const dot = path.indexOf('.');
  if (dot <= 0) return null;

  const root = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  if (rest.length === 0) return null;

  let base: unknown;
  if (root === 'event') base = input.event.source.raw;
  else if (root === 'state') base = input.state;
  else return null;

  const value = readPathValue(base, rest);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}
