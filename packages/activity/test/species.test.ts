/**
 * Species reference data.
 *
 * The table is transcribed from the EDFM wiki, so these tests mostly guard the
 * things transcription gets wrong: a key that does not match what the journal
 * writes, a number that does not match what the game pays, and a value shown
 * where the species is not actually known.
 */

import { describe, expect, it } from 'vitest';

import { SPECIES, formatCredits, speciesInfo } from '../src/species.js';

describe('the table', () => {
  it('covers the whole published index', () => {
    expect(Object.keys(SPECIES).length).toBe(118);
  });

  it('gives every species a positive value and distance', () => {
    for (const [name, info] of Object.entries(SPECIES)) {
      expect(info.value, name).toBeGreaterThan(0);
      expect(info.sampleDistance, name).toBeGreaterThan(0);
    }
  });

  it('matches what the game actually paid, for species that have been sold', () => {
    /*
     * Cross-checked against `SellOrganicData.Value` in the corpus: 14 of 14
     * matched exactly. These three are spot checks that the transcription did
     * not shift a row.
     */
    expect(SPECIES['Bacterium Vesicula']?.value).toBe(1_000_000);
    expect(SPECIES['Roseum Brain Tree']?.value).toBe(1_593_700);
    expect(SPECIES['Stratum Tectonicas']?.value).toBe(19_010_800);
  });

  it('keys off the name the journal writes', () => {
    // `Species_Localised`, verbatim. Every species the corpus reported is here.
    expect(speciesInfo('Fonticulua Campestris')).toEqual({ value: 1_000_000, sampleDistance: 500 });
    expect(speciesInfo('Aleoida Coronamus')?.sampleDistance).toBe(150);
  });

  it('returns nothing for a species it does not know', () => {
    // A new species from a game update must read as unknown, not as zero.
    expect(speciesInfo('Thargoid Barnacle')).toBeNull();
    expect(speciesInfo(null)).toBeNull();
  });

  it('spans the range that makes a genus-level guess impossible', () => {
    /*
     * The reason an unscanned row shows no value: Bacterium alone runs from 1M
     * to 8.4M, so a figure before the species is known would be invention.
     */
    const bacteria = Object.entries(SPECIES).filter(([n]) => n.startsWith('Bacterium '));
    const values = bacteria.map(([, i]) => i.value);
    expect(Math.min(...values)).toBe(1_000_000);
    expect(Math.max(...values)).toBeGreaterThan(8_000_000);
  });
});

describe('credits, abbreviated for a widget over a game', () => {
  it('uses one decimal below ten million and none above', () => {
    expect(formatCredits(1_000_000)).toBe('1.0M');
    expect(formatCredits(9_739_000)).toBe('9.7M');
    expect(formatCredits(19_010_800)).toBe('19M');
  });

  it('handles the small values too', () => {
    expect(formatCredits(119_037)).toBe('119k');
  });

  it('returns nothing for a nonsense figure rather than "NaN"', () => {
    expect(formatCredits(Number.NaN)).toBe('');
    expect(formatCredits(-1)).toBe('');
  });
});
