/**
 * Context resolution.
 *
 * Feeds every normalized journal event through the rule set and maintains the
 * currently-relevant contexts, ranked. §6 requires a priority system precisely so
 * the commander is not handed ten links at once.
 */

import type { CommanderState, NormalizedEvent } from '@edfm/elite-journal';

import { evaluate, usesEvent } from './evaluate.js';
import { renderTemplate } from './template.js';
import { RULE_LIMITS, type ActiveContext, type ContextRule, type ContextRuleSet } from './types.js';

export interface ResolverOptions {
  /** How many contexts the UI will show. Ranking happens over all matches. */
  readonly maxActive?: number;
  /** Injected for deterministic tests. */
  readonly now?: () => number;
}

export class ContextResolver {
  private ruleSet: ContextRuleSet;
  private readonly active = new Map<string, ActiveContext>();
  /** Rule ids whose conditions never reference the triggering event. */
  private stateScoped = new Set<string>();
  private readonly maxActive: number;
  private readonly now: () => number;

  constructor(ruleSet: ContextRuleSet, options: ResolverOptions = {}) {
    this.ruleSet = sanitise(ruleSet);
    this.stateScoped = scopedIds(this.ruleSet);
    this.maxActive = options.maxActive ?? 3;
    this.now = options.now ?? (() => Date.now());
  }

  get version(): number {
    return this.ruleSet.version;
  }

  get source(): ContextRuleSet['source'] {
    return this.ruleSet.source;
  }

  /**
   * Swap in a new rule set.
   *
   * Active contexts are dropped: they were derived from rules that may no longer
   * exist, and carrying them forward would show the commander guidance the current
   * rule set does not actually endorse.
   */
  setRuleSet(ruleSet: ContextRuleSet): void {
    this.ruleSet = sanitise(ruleSet);
    this.stateScoped = scopedIds(this.ruleSet);
    this.active.clear();
  }

  /**
   * Evaluate one event. Returns true when the active set changed, so the caller can
   * avoid re-rendering on the thousands of events that match nothing (§30).
   */
  observe(event: NormalizedEvent, state: CommanderState): boolean {
    const now = this.now();
    let changed = this.expire(now);

    // End contexts the commander has demonstrably moved on from, before anything
    // is matched. A finished activity is not competing for attention with where
    // they are now: they already know what they did, and the TTL is only a
    // fallback for when nothing says the activity ended.
    //
    // Deleting the current entry while iterating a Map is well defined.
    const eventName = event.source.event;
    for (const [id, ctx] of this.active) {
      if (ctx.rule.endsOn?.includes(eventName) && this.active.delete(id)) changed = true;
    }

    for (const rule of this.ruleSet.rules) {
      const matches = evaluate(rule.when, { event, state });

      if (!matches) {
        // A state-scoped rule is true exactly while its situation holds. Letting
        // it ride out a TTL kept "Fleet Carrier services" on screen for half an
        // hour after the commander had docked somewhere else entirely.
        if (this.stateScoped.has(rule.id) && this.active.delete(rule.id)) changed = true;
        continue;
      }

      const previous = this.active.get(rule.id);

      // Rendered against the event that matched, because that event carries the
      // values and will not be available later. A rule with no placeholders costs
      // one indexOf.
      const input = { event, state };
      const title = renderTemplate(rule.title, input) ?? stripPlaceholders(rule.title);
      const subtitle =
        rule.subtitle === undefined ? null : renderTemplate(rule.subtitle, input);

      this.active.set(rule.id, {
        rule,
        title,
        subtitle,
        matchedAt: now,
        // State-scoped rules are held open by their condition, not by a clock.
        expiresAt: this.stateScoped.has(rule.id)
          ? Number.POSITIVE_INFINITY
          : now + rule.ttlSeconds * 1000,
        triggerEvent: event.source.event,
        triggerEventId: event.source.provenance.eventId,
      });
      // Re-matching an already-active rule normally only refreshes its expiry, which
      // is not a visible change. Rendered text is the exception: a count that has
      // moved is exactly the sort of thing the commander is watching for.
      if (!previous || previous.title !== title || previous.subtitle !== subtitle) {
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Currently relevant contexts, most relevant first.
   *
   * Ranked by *decayed* priority, then by recency. Recency still breaks ties,
   * because two equally relevant rules are best ordered by what happened last.
   */
  current(): readonly ActiveContext[] {
    const now = this.now();
    this.expire(now);
    return [...this.active.values()]
      .sort((a, b) => this.relevance(b, now) - this.relevance(a, now) || b.matchedAt - a.matchedAt)
      .slice(0, this.maxActive);
  }

  /**
   * How relevant an active context is *right now*.
   *
   * The two kinds of rule make different claims and cannot share one static number:
   *
   *  - **Event-scoped** rules describe something that *happened*. "Recent
   *    engineering activity" is by definition in the past, and gets less worth
   *    saying every minute. Their priority decays linearly across their own TTL, so
   *    a rule states how long its subject stays interesting by choosing that TTL.
   *  - **State-scoped** rules describe where the commander *is*. They are held open
   *    by their condition rather than a clock and are re-matched on every event, so
   *    they do not decay -- being docked at a Material Trader is exactly as true
   *    after twenty minutes as it was on arrival.
   *
   * Without this, static priority let a past activity hide a present fact:
   * `engineering-activity` (75, 15-minute TTL) outranked a Material Trader (58) for
   * a full quarter of an hour after the commander had flown to another system and
   * docked -- and since the overlay shows only the top context, the trader was
   * invisible the whole time.
   *
   * Actively doing the thing keeps it on top regardless: each new EngineerCraft
   * refreshes `matchedAt`, restoring full priority.
   */
  private relevance(ctx: ActiveContext, now: number): number {
    if (this.stateScoped.has(ctx.rule.id)) return ctx.rule.priority;

    const ttlMs = ctx.rule.ttlSeconds * 1000;
    if (ttlMs <= 0) return 0;
    const elapsed = Math.max(0, now - ctx.matchedAt);
    // Reaches zero exactly at expiry, which is when the context disappears anyway.
    return ctx.rule.priority * Math.max(0, 1 - elapsed / ttlMs);
  }

  /** Everything active, unranked and untruncated — for diagnostics, not the UI. */
  all(): readonly ActiveContext[] {
    this.expire(this.now());
    return [...this.active.values()];
  }

  clear(): void {
    this.active.clear();
  }

  private expire(now: number): boolean {
    let changed = false;
    for (const [id, ctx] of this.active) {
      if (ctx.expiresAt <= now) {
        this.active.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}

/**
 * Clamp an incoming rule set to sane bounds.
 *
 * Rule sets arrive over the network. This does not attempt to validate semantics —
 * a nonsensical rule simply never matches — but it does stop an oversized or
 * malformed payload from degrading the client.
 */
/**
 * Fallback when a placeholder cannot be resolved.
 *
 * A title must render as something, so the literal parts are kept and the
 * unresolvable placeholder is dropped rather than printed raw. A subtitle is
 * optional and is simply omitted instead — see `renderTemplate`.
 */
function stripPlaceholders(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    const close = text.indexOf('}', open + 1);
    if (close === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    i = close + 1;
  }
  const collapsed = out.split(' ').filter((w) => w.length > 0).join(' ').trim();
  // If a title was nothing but placeholders there is no honest shorter form, so
  // the raw template is better than an empty heading.
  return collapsed.length > 0 ? collapsed : text;
}

export function sanitise(ruleSet: ContextRuleSet): ContextRuleSet {
  const rules: ContextRule[] = [];
  const seen = new Set<string>();

  for (const rule of ruleSet.rules ?? []) {
    if (rules.length >= RULE_LIMITS.maxRules) break;
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0) continue;
    if (seen.has(rule.id)) continue; // duplicate ids would make expiry ambiguous
    if (typeof rule.title !== 'string' || !rule.when) continue;

    seen.add(rule.id);
    const {
      actions: rawActions,
      note: rawNote,
      endsOn: rawEndsOn,
      guidance: rawGuidance,
      ...restRule
    } = rule;

    // Present only when there is something to show — exactOptionalPropertyTypes
    // forbids `actions: undefined`, and an absent field is the correct signal
    // to the UI anyway (nothing to render), not an empty list.
    const actions = Array.isArray(rawActions)
      ? rawActions
          .filter((a): a is string => typeof a === 'string' && a.length > 0)
          .slice(0, RULE_LIMITS.maxActions)
          .map((a) => a.slice(0, RULE_LIMITS.maxStringLength))
      : undefined;
    const note = typeof rawNote === 'string' ? rawNote.slice(0, RULE_LIMITS.maxStringLength) : undefined;

    // Guidance is untrusted text drawn over a game. Bounded like everything else
    // a rule set supplies, and dropped entirely if it carries nothing usable.
    let guidance: { topic?: string; beginner?: string } | undefined;
    if (rawGuidance !== null && typeof rawGuidance === 'object' && !Array.isArray(rawGuidance)) {
      const g = rawGuidance as Record<string, unknown>;
      const beginner =
        typeof g['beginner'] === 'string'
          ? g['beginner'].slice(0, RULE_LIMITS.maxGuidanceChars)
          : undefined;
      const topic =
        typeof g['topic'] === 'string' ? g['topic'].slice(0, RULE_LIMITS.maxStringLength) : undefined;
      if (beginner || topic) {
        guidance = { ...(topic ? { topic } : {}), ...(beginner ? { beginner } : {}) };
      }
    }

    const endsOn = Array.isArray(rawEndsOn)
      ? rawEndsOn
          .filter((e): e is string => typeof e === 'string' && e.length > 0)
          .slice(0, RULE_LIMITS.maxEndsOn)
          .map((e) => e.slice(0, RULE_LIMITS.maxStringLength))
      : undefined;

    rules.push({
      ...restRule,
      priority: Number.isFinite(rule.priority) ? rule.priority : 0,
      // A missing or absurd TTL must not pin a context on screen forever.
      ttlSeconds:
        Number.isFinite(rule.ttlSeconds) && rule.ttlSeconds > 0
          ? Math.min(rule.ttlSeconds, 24 * 60 * 60)
          : 300,
      resources: (rule.resources ?? []).slice(0, RULE_LIMITS.maxResourcesPerRule),
      ...(actions && actions.length > 0 ? { actions } : {}),
      ...(note ? { note } : {}),
      ...(endsOn && endsOn.length > 0 ? { endsOn } : {}),
      ...(guidance ? { guidance } : {}),
    });
  }

  return { ...ruleSet, rules };
}

/** Ids of rules whose conditions never reference the triggering event. */
function scopedIds(ruleSet: ContextRuleSet): Set<string> {
  const out = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (!usesEvent(rule.when)) out.add(rule.id);
  }
  return out;
}
