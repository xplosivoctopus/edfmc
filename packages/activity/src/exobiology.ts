/**
 * Turning exobiology events into activity.
 *
 * Everything here was checked against the real corpus before it was written; the
 * measurements are recorded where they changed a decision, because several of
 * them contradict what the event names suggest.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import type { ActivityContext, ActivityEntry } from './types.js';

/**
 * `ScanOrganic.Variant_Localised` is `"Species - Colour"`, e.g.
 * `"Stratum Excutitus - Lime"`. Measured: present on 100% of 275 scans, and
 * differing from the species on 39 of 45 sold entries, so the colour is real
 * information rather than a repeat.
 *
 * Split rather than parsed with a pattern: the separator is a plain `" - "`, and
 * a species whose own name contained one would break a greedy match.
 */
export function splitVariant(
  variantLocalised: string | null,
  speciesLocalised: string | null,
): { species: string | null; colour: string | null } {
  if (!variantLocalised) return { species: speciesLocalised, colour: null };
  if (speciesLocalised && variantLocalised.startsWith(`${speciesLocalised} - `)) {
    return { species: speciesLocalised, colour: variantLocalised.slice(speciesLocalised.length + 3) };
  }
  // No recognisable prefix: the variant IS the species name, which is how brain
  // trees and similar report. Colour stays null rather than being invented.
  return { species: speciesLocalised ?? variantLocalised, colour: null };
}

/** `"Stratum Excutitus — Lime"`, or just the species when there is no colour. */
export function organismTitle(species: string | null, colour: string | null): string {
  if (species && colour) return `${species} — ${colour}`;
  return species ?? 'Unknown organism';
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Entries for one event, or none.
 *
 * Most journal events produce nothing. The question an entry answers is "what
 * did I meaningfully do here?", not "what fired?", so progress toward a thing is
 * deliberately quieter than the thing itself.
 */
export function exobiologyEntries(
  event: NormalizedEvent,
  ctx: ActivityContext,
): readonly ActivityEntry[] {
  const raw = event.source.raw as Record<string, unknown>;
  const name = event.source.event;
  const id = event.source.provenance.eventId;
  const at = event.source.provenance.timestamp;

  const base = {
    id,
    commanderFid: ctx.commanderFid,
    occurredAt: at,
    systemName: ctx.systemName,
    systemAddress: ctx.systemAddress,
    locationName: null,
    sources: [id],
  } as const;

  if (name === 'ScanOrganic') {
    const scanType = str(raw, 'ScanType');
    // `Body` is a BodyID integer here, not a name -- so the name is resolved from
    // an event that carried both, and stays null when none has. Guessing it from
    // the current location would be wrong the moment a commander scans on one
    // body and the state has moved on.
    const bodyId = num(raw, 'Body');
    const bodyName = bodyId === null ? null : (ctx.bodyNames.get(bodyId) ?? null);

    const { species, colour } = splitVariant(
      str(raw, 'Variant_Localised'),
      str(raw, 'Species_Localised'),
    );
    const genus = str(raw, 'Genus_Localised');

    // Only a completed Analyse is an activity worth a line of its own. Log and
    // Sample are steps toward one specimen -- 183 of 243 measured scans -- and
    // giving each its own entry would bury the completion among its own progress.
    if (scanType !== 'Analyse') return [];

    return [
      {
        ...base,
        bodyName,
        bodyId,
        category: 'exobiology',
        subtype: 'sample-completed',
        title: organismTitle(species, colour),
        detail: 'Biological sample completed',
        data: {
          ...(genus ? { genus } : {}),
          // The raw token too, additively: it is language-independent, and it is
          // what the overlay's genus roster matches a surface scan against.
          ...(str(raw, 'Genus') ? { genusToken: str(raw, 'Genus') } : {}),
          ...(species ? { species } : {}),
          ...(colour ? { colour } : {}),
          scanType,
        },
      },
    ];
  }

  if (name === 'SellOrganicData') {
    const bio = Array.isArray(raw['BioData']) ? (raw['BioData'] as Record<string, unknown>[]) : [];
    if (bio.length === 0) return [];

    const names = bio
      .map((b) => {
        const { species, colour } = splitVariant(
          str(b, 'Variant_Localised'),
          str(b, 'Species_Localised'),
        );
        return organismTitle(species, colour);
      })
      .filter((n) => n !== 'Unknown organism');

    const value = bio.reduce((sum, b) => sum + (num(b, 'Value') ?? 0), 0);
    const bonus = bio.reduce((sum, b) => sum + (num(b, 'Bonus') ?? 0), 0);

    return [
      {
        ...base,
        bodyName: null,
        bodyId: null,
        category: 'exobiology',
        subtype: 'data-sold',
        title: `Sold ${bio.length} exobiology ${bio.length === 1 ? 'sample' : 'samples'}`,
        detail: names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4} more` : ''),
        data: {
          count: bio.length,
          value,
          // Recorded, NOT interpreted as a first-discovery confirmation. Across
          // all 45 sold entries Bonus was exactly 4x Value with no counter-example,
          // so the corpus cannot distinguish "bonus means first discovery" from
          // "bonus is always paid". See docs/ACTIVITY-JOURNAL.md.
          bonus,
          species: names,
        },
      },
    ];
  }

  return [];
}

/**
 * Making footfall on a world nobody had walked on.
 *
 * ## Why this replaced "Landed"
 *
 * This used to record every `Touchdown`, which made the journal a list of
 * parking events -- 463 of them in the corpus. A landing is not a milestone.
 * What a commander actually wants remembered is footfall on an untouched world.
 *
 * ## Two corrections measured out of the corpus
 *
 * **It fires on `Disembark`, not `Touchdown`.** Footfall means standing on the
 * surface; wheels down in a ship is not footfall, and the game's own
 * `Planet_Footfalls` statistic counts the former.
 *
 * **It is gated on the body being unwalked when scanned.** `Scan.WasFootfalled`
 * is the only footfall flag the journal carries per body.
 *
 * ## What this entry does NOT claim
 *
 * It does not claim a first footfall, because the journal cannot support that
 * claim. `WasFootfalled` reports whether *anyone* had walked there **at the
 * moment the body was scanned** -- another commander can footfall it between
 * that scan and this landing.
 *
 * That gap was measured, not assumed. Taking every on-foot disembark onto a
 * body last scanned as unwalked, deduplicated per body and segmented per
 * commander, yields 98 candidates against the game's own `First_Footfalls`
 * counter of 78 over the same span: a 20% over-claim, and every mismatch was
 * the counter staying flat while a candidate fired. So the title says what is
 * true -- the world was unvisited when it was scanned -- and leaves the
 * achievement to the game to award.
 */
export function footfallEntries(
  event: NormalizedEvent,
  ctx: ActivityContext,
  wasFootfalledWhenScanned: boolean | null,
): readonly ActivityEntry[] {
  if (event.source.event !== 'Disembark') return [];
  const raw = event.source.raw as Record<string, unknown>;

  // On a world, not a station pad or a ship interior.
  if (raw['OnPlanet'] !== true) return [];
  if (raw['OnStation'] === true) return [];

  /*
   * `null` means the body was never scanned with a footfall flag, which is not
   * the same as "unwalked" -- a body scanned before Odyssey carries no flag at
   * all. Only an explicit `false` is evidence of anything.
   */
  if (wasFootfalledWhenScanned !== false) return [];

  const id = event.source.provenance.eventId;
  const bodyName = str(raw, 'Body');

  return [
    {
      id,
      commanderFid: ctx.commanderFid,
      occurredAt: event.source.provenance.timestamp,
      systemName: str(raw, 'StarSystem') ?? ctx.systemName,
      systemAddress: num(raw, 'SystemAddress') ?? ctx.systemAddress,
      bodyName,
      bodyId: num(raw, 'BodyID'),
      locationName: null,
      category: 'exploration',
      subtype: 'footfall',
      title: 'Footfall on an unvisited world',
      detail: bodyName,
      data: {
        // The fact the gate rests on, kept so the UI can be precise about it
        // and so a later reader can see this was reported, not deduced.
        noFootfallRecordedWhenScanned: true,
      },
      sources: [id],
    },
  ];
}

/**
 * Biological signals found by a surface scan.
 *
 * Gated on `Genuses` being non-empty rather than on the event name, because
 * `SAASignalsFound` fires for every detailed surface scan -- 198 in the corpus,
 * only 29 of them rings -- and on the measured equivalence that all 103 events
 * carrying a biological signal list genera, and none lists genera without one.
 */
export function biologicalSignalEntries(
  event: NormalizedEvent,
  ctx: ActivityContext,
): readonly ActivityEntry[] {
  if (event.source.event !== 'SAASignalsFound') return [];
  const raw = event.source.raw as Record<string, unknown>;
  const genuses = Array.isArray(raw['Genuses']) ? (raw['Genuses'] as Record<string, unknown>[]) : [];
  if (genuses.length === 0) return [];

  const id = event.source.provenance.eventId;
  const names = genuses.map((g) => str(g, 'Genus_Localised')).filter((n): n is string => n !== null);
  const bodyName = str(raw, 'BodyName');

  return [
    {
      id,
      commanderFid: ctx.commanderFid,
      occurredAt: event.source.provenance.timestamp,
      systemName: ctx.systemName,
      systemAddress: num(raw, 'SystemAddress') ?? ctx.systemAddress,
      bodyName,
      bodyId: num(raw, 'BodyID'),
      locationName: null,
      category: 'exobiology',
      subtype: 'signals-detected',
      title: `${genuses.length} biological ${genuses.length === 1 ? 'signal' : 'signals'} detected`,
      detail: names.join(', ') || null,
      data: { genera: names, count: genuses.length },
      sources: [id],
    },
  ];
}
