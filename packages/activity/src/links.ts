/**
 * Links on activity entries.
 *
 * Two kinds, kept apart because their failure modes differ. EDFM links point at
 * a wiki this project controls; external links point at galaxy databases it does
 * not.
 *
 * ## Why species do not link to species pages
 *
 * The obvious design is `Stratum Tectonicas` -> `/wiki/Stratum_Tectonicas`. It
 * was checked against the live wiki before being built, and **no species or genus
 * page exists** -- all 25 species and 11 genera observed in the corpus are
 * absent; only `Exobiology` is there.
 *
 * So the obvious design produces 25 broken links that look authoritative. This
 * resolves through a verified set instead and falls back to a page that does
 * exist. When EDFM gains species pages, `VERIFIED_EDFM_PAGES` is the only thing
 * that changes: no stored entry is touched, because entries store the organism,
 * not a URL.
 *
 * That separation is the point. A URL written into the database at scan time is
 * a URL that rots.
 */

import { pageUrl } from '@edfm/context';

import type { ActivityEntry, ActivityLink } from './types.js';

/**
 * EDFM pages confirmed to exist, checked 2026-09-28 via `action=query&titles=`.
 *
 * Checked and absent at the same time, listed so nobody links them believing
 * they were merely overlooked: every genus and species name in the corpus, and
 * `Biological Signals`.
 */
export const VERIFIED_EDFM_PAGES: readonly string[] = [
  'Exobiology',
  'Exploration',
  'Detailed Surface Scanner',
  'Mining',
  'Mining Hotspot',
  'Planetary Rings',
  'Surface Mining',
  'Colonisation',
  'Trailblazers',
];

/** A page title, or null when nothing verified covers it. */
export function resolveEdfmPage(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = VERIFIED_EDFM_PAGES.find((p) => p.toLowerCase() === title.toLowerCase());
  return match ?? null;
}

/**
 * Where an external galaxy database is configured.
 *
 * Deliberately a template rather than a hard-coded host. EDFM is not a galaxy
 * database and should not pretend to be one, but which third party to prefer is
 * a decision that can change -- and when it does, no stored entry should need
 * rewriting.
 *
 * `null` is a supported configuration: the journal is useful offline, and no
 * entry requires an external link to make sense.
 */
export interface ExternalLinkProvider {
  readonly name: string;
  /** `{system}` is replaced with the URL-encoded system name. */
  readonly systemUrl: string;
}

/**
 * No provider by default.
 *
 * Choosing one means sending a commander's location to a third party the moment
 * they click, and none of the candidates' deep-link formats has been verified
 * here. Shipping an unverified URL template would produce exactly the broken
 * link the species check above avoided.
 */
export const DEFAULT_EXTERNAL_PROVIDER: ExternalLinkProvider | null = null;

export function externalSystemLink(
  systemName: string | null,
  provider: ExternalLinkProvider | null = DEFAULT_EXTERNAL_PROVIDER,
): ActivityLink | null {
  if (!systemName || !provider) return null;
  const url = provider.systemUrl.replace('{system}', encodeURIComponent(systemName));
  if (!/^https:\/\//i.test(url)) return null;
  return { label: `${systemName} on ${provider.name}`, url, kind: 'external' };
}

/**
 * Links for one entry.
 *
 * Reads the entry's own data rather than taking a category-specific argument, so
 * a future category adds a case here and nothing else changes.
 */
export function linksFor(
  entry: ActivityEntry,
  provider: ExternalLinkProvider | null = DEFAULT_EXTERNAL_PROVIDER,
): readonly ActivityLink[] {
  const links: ActivityLink[] = [];

  // The organism, when the wiki has a page for it. Today it never does, so this
  // falls through to the category page below -- which is the honest outcome, and
  // starts working by itself the day those pages are written.
  const species = typeof entry.data['species'] === 'string' ? entry.data['species'] : null;
  const speciesPage = resolveEdfmPage(species);
  if (speciesPage) {
    links.push({ label: species!, url: pageUrl(speciesPage), kind: 'edfm' });
  }

  const categoryPage = CATEGORY_PAGE[entry.category];
  if (categoryPage && !links.some((l) => l.label === categoryPage)) {
    links.push({ label: categoryPage, url: pageUrl(categoryPage), kind: 'edfm' });
  }

  const external = externalSystemLink(entry.systemName, provider);
  if (external) links.push(external);

  return links;
}

const CATEGORY_PAGE: Record<ActivityEntry['category'], string | null> = {
  exobiology: 'Exobiology',
  exploration: 'Exploration',
  mining: 'Mining',
  colonisation: 'Colonisation',
  /*
   * Null because it is UNVERIFIED, not because missions have no page.
   *
   * Every other entry here was confirmed to exist against the live wiki before
   * being linked, for the reason at the top of this file: a link that looks
   * authoritative and 404s is worse than no link. A `Missions` page was not
   * checked, because the network this was written on refuses edfieldmanual.com.
   *
   * Confirming it is one query -- `action=query&titles=Missions` -- and if it
   * exists, this line and `VERIFIED_EDFM_PAGES` are the whole change. Guessing
   * it in the meantime is the exact mistake the 25 absent species pages taught.
   */
  missions: null,
};
