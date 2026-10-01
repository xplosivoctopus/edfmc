/**
 * Species reference: base value and minimum sampling distance.
 *
 * Transcribed from the EDFM wiki organism index
 * (https://edfieldmanual.com/wiki/Exobiology), which maintains these from
 * Frontier journal records and validated community datasets.
 *
 * ## Why this is trustworthy enough to show
 *
 * Checked against the local corpus before being used, because a confidently
 * wrong number is worse than none:
 *
 * - All **26** species the journal has ever reported appear here, so
 *   `Species_Localised` is the right key and the names match exactly.
 * - For the **14** species actually sold to Vista Genomics, the base value here
 *   equals the `SellOrganicData.Value` the game paid — 14 of 14, no
 *   mismatches.
 *
 * ## What the value is not
 *
 * **Base value only.** It excludes the first-to-log bonus, which Frontier does
 * not document as a formula. A commander who is first to log a species is paid
 * more than this, so the figure is a floor rather than a prediction — and the
 * UI says "base" for that reason.
 *
 * ## Sampling distance
 *
 * The minimum separation between accepted samples of the same organism. It is
 * the number a commander needs *while sampling*, which is why it is kept here
 * alongside the value rather than left on the website.
 */

export interface SpeciesInfo {
  /** Base Vista Genomics value in credits, excluding first-discovery bonuses. */
  readonly value: number;
  /** Minimum metres between accepted samples. */
  readonly sampleDistance: number;
}

/** Keyed by `Species_Localised` exactly as the journal writes it. */
export const SPECIES: Readonly<Record<string, SpeciesInfo>> = {
  "Albidum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Aleoida Arcus": { value: 7252500, sampleDistance: 150 },
  "Aleoida Coronamus": { value: 6284600, sampleDistance: 150 },
  "Aleoida Gravis": { value: 12934900, sampleDistance: 150 },
  "Aleoida Laminiae": { value: 3385200, sampleDistance: 150 },
  "Aleoida Spica": { value: 3385200, sampleDistance: 150 },
  "Amphora Plant": { value: 1628800, sampleDistance: 100 },
  "Aureum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Bacterium Acies": { value: 1000000, sampleDistance: 500 },
  "Bacterium Alcyoneum": { value: 1658500, sampleDistance: 500 },
  "Bacterium Aurasus": { value: 1000000, sampleDistance: 500 },
  "Bacterium Bullaris": { value: 1152500, sampleDistance: 500 },
  "Bacterium Cerbrus": { value: 1689800, sampleDistance: 500 },
  "Bacterium Informem": { value: 8418000, sampleDistance: 500 },
  "Bacterium Nebulus": { value: 5289900, sampleDistance: 500 },
  "Bacterium Omentum": { value: 4638900, sampleDistance: 500 },
  "Bacterium Scopulum": { value: 4934500, sampleDistance: 500 },
  "Bacterium Tela": { value: 1949000, sampleDistance: 500 },
  "Bacterium Verrata": { value: 3897000, sampleDistance: 500 },
  "Bacterium Vesicula": { value: 1000000, sampleDistance: 500 },
  "Bacterium Volu": { value: 7774700, sampleDistance: 500 },
  "Bark Mounds": { value: 1471900, sampleDistance: 100 },
  "Blatteum Bioluminescent Anemone": { value: 1499900, sampleDistance: 100 },
  "Blatteum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Cactoida Cortexum": { value: 3667600, sampleDistance: 300 },
  "Cactoida Lapis": { value: 2483600, sampleDistance: 300 },
  "Cactoida Peperatis": { value: 2483600, sampleDistance: 300 },
  "Cactoida Pullulanta": { value: 3667600, sampleDistance: 300 },
  "Cactoida Vermis": { value: 16202800, sampleDistance: 300 },
  "Caeruleum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Clypeus Lacrimam": { value: 8418000, sampleDistance: 150 },
  "Clypeus Margaritus": { value: 11873200, sampleDistance: 150 },
  "Clypeus Speculumi": { value: 16202800, sampleDistance: 150 },
  "Concha Aureolas": { value: 7774700, sampleDistance: 150 },
  "Concha Biconcavis": { value: 19010800, sampleDistance: 150 },
  "Concha Labiata": { value: 2352400, sampleDistance: 150 },
  "Concha Renibus": { value: 4572400, sampleDistance: 150 },
  "Croceum Anemone": { value: 1499900, sampleDistance: 100 },
  "Crystalline Shards": { value: 1628800, sampleDistance: 100 },
  "Electricae Pluma": { value: 6284600, sampleDistance: 1000 },
  "Electricae Radialem": { value: 6284600, sampleDistance: 1000 },
  "Fonticulua Campestris": { value: 1000000, sampleDistance: 500 },
  "Fonticulua Digitos": { value: 1804100, sampleDistance: 500 },
  "Fonticulua Fluctus": { value: 20000000, sampleDistance: 500 },
  "Fonticulua Lapida": { value: 3111000, sampleDistance: 500 },
  "Fonticulua Segmentatus": { value: 19010800, sampleDistance: 500 },
  "Fonticulua Upupam": { value: 5727600, sampleDistance: 500 },
  "Frutexa Acus": { value: 7774700, sampleDistance: 150 },
  "Frutexa Collum": { value: 1639800, sampleDistance: 150 },
  "Frutexa Fera": { value: 1632500, sampleDistance: 150 },
  "Frutexa Flabellum": { value: 1808900, sampleDistance: 150 },
  "Frutexa Flammasis": { value: 10326000, sampleDistance: 150 },
  "Frutexa Metallicum": { value: 1632500, sampleDistance: 150 },
  "Frutexa Sponsae": { value: 5988000, sampleDistance: 150 },
  "Fumerola Aquatis": { value: 6284600, sampleDistance: 100 },
  "Fumerola Carbosis": { value: 6284600, sampleDistance: 100 },
  "Fumerola Extremus": { value: 16202800, sampleDistance: 100 },
  "Fumerola Nitris": { value: 7500900, sampleDistance: 100 },
  "Fungoida Bullarum": { value: 3703200, sampleDistance: 300 },
  "Fungoida Gelata": { value: 3330300, sampleDistance: 300 },
  "Fungoida Setisis": { value: 1670100, sampleDistance: 300 },
  "Fungoida Stabitis": { value: 2680300, sampleDistance: 300 },
  "Gypseeum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Lindigoticum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Lindigoticum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Lividum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Luteolum Anemone": { value: 1499900, sampleDistance: 100 },
  "Osseus Cornibus": { value: 1483000, sampleDistance: 800 },
  "Osseus Discus": { value: 12934900, sampleDistance: 800 },
  "Osseus Fractus": { value: 4027800, sampleDistance: 800 },
  "Osseus Pellebantus": { value: 9739000, sampleDistance: 800 },
  "Osseus Pumice": { value: 3156300, sampleDistance: 800 },
  "Osseus Spiralis": { value: 2404700, sampleDistance: 800 },
  "Ostrinum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Prasinum Bioluminescent Anemone": { value: 1499900, sampleDistance: 100 },
  "Prasinum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Puniceum Anemone": { value: 1499900, sampleDistance: 100 },
  "Puniceum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Radicoida Unica": { value: 119037, sampleDistance: 15 },
  "Recepta Conditivus": { value: 14313700, sampleDistance: 150 },
  "Recepta Deltahedronix": { value: 16202800, sampleDistance: 150 },
  "Recepta Umbrux": { value: 12934900, sampleDistance: 150 },
  "Roseum Anemone": { value: 1499900, sampleDistance: 100 },
  "Roseum Bioluminescent Anemone": { value: 1499900, sampleDistance: 100 },
  "Roseum Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Roseum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Rubeum Bioluminescent Anemone": { value: 1499900, sampleDistance: 100 },
  "Stratum Araneamus": { value: 2448900, sampleDistance: 500 },
  "Stratum Cucumisis": { value: 16202800, sampleDistance: 500 },
  "Stratum Excutitus": { value: 2448900, sampleDistance: 500 },
  "Stratum Frigus": { value: 2637500, sampleDistance: 500 },
  "Stratum Laminamus": { value: 2788300, sampleDistance: 500 },
  "Stratum Limaxus": { value: 1362000, sampleDistance: 500 },
  "Stratum Paleas": { value: 1362000, sampleDistance: 500 },
  "Stratum Tectonicas": { value: 19010800, sampleDistance: 500 },
  "Tubus Cavas": { value: 11873200, sampleDistance: 800 },
  "Tubus Compagibus": { value: 7774700, sampleDistance: 800 },
  "Tubus Conifer": { value: 2415500, sampleDistance: 800 },
  "Tubus Rosarium": { value: 2637500, sampleDistance: 800 },
  "Tubus Sororibus": { value: 5727600, sampleDistance: 800 },
  "Tussock Albata": { value: 3252500, sampleDistance: 200 },
  "Tussock Capillum": { value: 7025800, sampleDistance: 200 },
  "Tussock Caputus": { value: 3472400, sampleDistance: 200 },
  "Tussock Catena": { value: 1766600, sampleDistance: 200 },
  "Tussock Cultro": { value: 1766600, sampleDistance: 200 },
  "Tussock Divisa": { value: 1766600, sampleDistance: 200 },
  "Tussock Ignis": { value: 1849000, sampleDistance: 200 },
  "Tussock Pennata": { value: 5853800, sampleDistance: 200 },
  "Tussock Pennatis": { value: 1000000, sampleDistance: 200 },
  "Tussock Propagito": { value: 1000000, sampleDistance: 200 },
  "Tussock Serrati": { value: 4447100, sampleDistance: 200 },
  "Tussock Stigmasis": { value: 19010800, sampleDistance: 200 },
  "Tussock Triticum": { value: 7774700, sampleDistance: 200 },
  "Tussock Ventusa": { value: 3227700, sampleDistance: 200 },
  "Tussock Virgam": { value: 14313700, sampleDistance: 200 },
  "Violaceum Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
  "Viride Brain Tree": { value: 1593700, sampleDistance: 100 },
  "Viride Sinuous Tubers": { value: 1514500, sampleDistance: 100 },
};

/** Reference for a species, or null when it is not one this table knows. */
export function speciesInfo(species: string | null): SpeciesInfo | null {
  if (!species) return null;
  return SPECIES[species] ?? null;
}

/**
 * Credits, abbreviated for a widget over a game.
 *
 * `19.0M` rather than `19,010,800`: the overlay has one short line per
 * organism, and the comparison a commander makes at a glance is "is this one
 * worth the walk", not an exact figure.
 */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    // One decimal below 10M, none above: "9.7M" and "19M" are both the width
    // the column allows.
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
