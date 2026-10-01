/**
 * What each integration is, and what it does with a commander's data.
 *
 * These manifests are the contract the UI renders and the tests check the code
 * against. `Connected` on its own is exactly the label this replaces: it tells
 * someone that something is happening and nothing about what.
 *
 * Three of the four are **designed and not implemented**, and say so. An
 * integration that appears available and silently does nothing is worse than one
 * that states it is unfinished, because the commander assumes their data is
 * going somewhere it is not.
 */

import { EDDN_JOURNAL_EVENTS } from './eddn.js';
import type { IntegrationDescriptor, IntegrationId } from './types.js';

/**
 * The guarantees that hold for **every** integration, defined once.
 *
 * Each manifest spelled these out in its own words once, so
 * `universalNeverShares` intersected them to nothing and the documented claim
 * "never shared by any of them" was an assertion no code backed. Sharing the
 * strings makes the universal promise *derived* from the manifests rather than
 * restated alongside them.
 */
export const UNIVERSAL_NEVER_SHARES: readonly string[] = [
  'Chat, friends, wings or squadrons',
  'Your credits, ship loadout, fines or bounties',
  'Your reputation with any faction',
  'Where you are standing on a planet',
  'Anything at all while this integration is switched off',
];

/**
 * The additional guarantee the **community** databases carry.
 *
 * EDDN, EDSM and Inara receive observations about the galaxy. A
 * commander's own record of what they did is not an observation about the
 * galaxy, and it is not theirs to publish, so it never goes to any of them.
 *
 * This is deliberately *not* in `UNIVERSAL_NEVER_SHARES` any more. The
 * first-party EDFM sync exists precisely to send that record — to the
 * commander's own account, at their request, behind a credential they created
 * and can revoke. Claiming it as universal while one integration did the
 * opposite would be the kind of privacy statement this project has already had
 * to correct once.
 */
export const COMMUNITY_NEVER_SHARES: readonly string[] = [
  ...UNIVERSAL_NEVER_SHARES,
  'Your Activity Journal, notes or saved items',
];

export const INTEGRATIONS: Readonly<Record<IntegrationId, IntegrationDescriptor>> = {
  eddn: {
    id: 'eddn',
    name: 'EDDN',
    homepage: 'https://github.com/EDCD/EDDN',
    implemented: true,
    privacy: {
      summary:
        'The community data relay. Everything sent is public and permanent, and is what keeps station and market tools current.',
      requiresCredential: false,
      shares: [
        `Docking, jumps, scans and signals (${EDDN_JOURNAL_EVENTS.join(', ')})`,
        'The system you are in, its address and position',
        'Your commander name as an uploader id, which the relay requires',
        'Which game build produced the data',
      ],
      neverShares: [
        ...COMMUNITY_NEVER_SHARES,
        'Your latitude and longitude, which are stripped before anything is sent',
      ],
    },
  },

  'edfm-journal': {
    id: 'edfm-journal',
    name: 'EDFM Commander Journal',
    homepage: 'https://edfieldmanual.com',
    /*
     * Phase 1 uploads new derived Activity Journal entries to the commander's
     * own EDFM account. It is marked unbuilt until the serializer matches the
     * deployed contract: an enable switch that implied syncing while nothing
     * was sent is the state this screen exists to prevent.
     */
    implemented: true,
    privacy: {
      summary:
        'Your own EDFM account. It receives the Activity Journal entries this app derives — what you did — not the game files they came from.',
      requiresCredential: true,
      credentialHelp:
        'edfieldmanual.com \u2192 your account \u2192 Journal sync token. A token is not your EDFM password, and it is shown only once.',
      shares: [
        'Derived Activity Journal entries: what you did, where, and when',
        'A stable id per entry, so a retry cannot create a duplicate',
        'Which commander the entry belongs to, and which app version produced it',
      ],
      neverShares: [
        ...UNIVERSAL_NEVER_SHARES,
        'Raw Frontier journal events or files — only entries this app derived',
        'Your EDFM password, which is never asked for and is not a sync credential',
        'Screenshot images, or the paths they are stored at',
        'Your sync token with anyone but EDFM',
        'Your notes and saved items, which stay on this machine',
      ],
    },
  },

  edsm: {
    id: 'edsm',
    name: 'EDSM',
    homepage: 'https://www.edsm.net/',
    implemented: true,
    privacy: {
      summary:
        'Your personal flight log and exploration record, tied to your EDSM account rather than published anonymously.',
      requiresCredential: true,
      credentialHelp: 'EDSM → Settings → My API Key. The key identifies your account; keep it private.',
      shares: [
        'Journal entries for travel, docking and body scans',
        'Your EDSM commander name, which the API requires to attribute the log',
      ],
      neverShares: [
        ...COMMUNITY_NEVER_SHARES,
        'Your API key with anyone but EDSM — it never reaches EDFM',
      ],
    },
  },

  inara: {
    id: 'inara',
    name: 'Inara',
    homepage: 'https://inara.cz/',
    implemented: true,
    privacy: {
      summary:
        'A commander profile and community site. It keeps your profile location current; it has no event for exobiology, so none is sent.',
      requiresCredential: true,
      credentialHelp:
        'inara.cz → your commander → API settings. A personal API key, which is not your Inara password, and no application registration is needed.',
      shares: [
        'The star system you are in, and its coordinates',
        'The station you are docked at, when you are docked',
        'The body you are near, by name only',
        'Your Inara commander name',
      ],
      neverShares: [
        ...COMMUNITY_NEVER_SHARES,
        'Your API key with anyone but Inara — it never reaches EDFM',
        'Anything about your exobiology — Inara has no event that accepts it',
        'Your position on a planet surface, which Inara would accept but is not sent',
      ],
    },
  },

};

export function integrationsList(): readonly IntegrationDescriptor[] {
  return Object.values(INTEGRATIONS);
}

/**
 * Whether this integration may perform network activity right now.
 *
 * One function, used by every adapter, so "off means off" is a single testable
 * fact rather than a convention each adapter is trusted to follow.
 */
export function mayTransmit(
  descriptor: IntegrationDescriptor,
  state: { readonly enabled: boolean; readonly hasCredential: boolean },
): boolean {
  if (!descriptor.implemented) return false;
  if (!state.enabled) return false;
  if (descriptor.privacy.requiresCredential && !state.hasCredential) return false;
  return true;
}

/** Status as the commander would describe it. */
export function integrationStatus(
  descriptor: IntegrationDescriptor,
  state: { readonly enabled: boolean; readonly hasCredential: boolean; readonly lastError?: string | null },
): 'disabled' | 'needs-configuration' | 'ready' | 'error' | 'not-implemented' {
  if (!descriptor.implemented) return 'not-implemented';
  if (!state.enabled) return 'disabled';
  if (descriptor.privacy.requiresCredential && !state.hasCredential) return 'needs-configuration';
  if (state.lastError) return 'error';
  return 'ready';
}
