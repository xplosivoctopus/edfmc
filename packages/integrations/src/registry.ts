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
 * The guarantees that hold for every integration, defined once.
 *
 * Previously each manifest spelled these out in its own words, so
 * `universalNeverShares` intersected them to nothing -- meaning the documented
 * claim "never shared by any of them" was an assertion no code backed. Sharing
 * the strings makes the universal promise *derived* from the manifests rather
 * than restated alongside them, which is the only version of it that cannot
 * drift out of agreement with the code.
 *
 * Anything genuinely specific to one service stays in that service's own list.
 */
export const UNIVERSAL_NEVER_SHARES: readonly string[] = [
  'Chat, friends, wings or squadrons',
  'Your Activity Journal, notes or saved items',
  'Your credits, ship loadout, fines or bounties',
  'Your reputation with any faction',
  'Where you are standing on a planet',
  'Anything at all while this integration is switched off',
];

export const INTEGRATIONS: Readonly<Record<IntegrationId, IntegrationDescriptor>> = {
  eddn: {
    id: 'eddn',
    name: 'EDDN',
    homepage: 'https://github.com/EDCD/EDDN',
    /*
     * The adapter, sanitiser and queue are built and tested; the submission loop
     * that feeds them from live journal events is not yet connected.
     *
     * Marked honestly rather than left as `true`, because an enable switch that
     * implies data is being shared when none is would be exactly the fake
     * "Connected" state this screen exists to prevent -- and it is the kind of
     * claim that erodes trust in every other statement on the page.
     */
    implemented: false,
    pendingReason:
      'Message building, sanitisation and queuing are complete and tested. The step that feeds live journal events into the queue is not connected yet, so nothing is being sent.',
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
        ...UNIVERSAL_NEVER_SHARES,
        'Your latitude and longitude, which are stripped before anything is sent',
      ],
    },
  },

  edsm: {
    id: 'edsm',
    name: 'EDSM',
    homepage: 'https://www.edsm.net/',
    implemented: false,
    pendingReason:
      'Adapter designed against the documented journal API; needs your EDSM commander name and API key, and a round of testing against a real account before it is switched on.',
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
        ...UNIVERSAL_NEVER_SHARES,
        'Your API key with anyone but EDSM — it never reaches EDFM',
      ],
    },
  },

  inara: {
    id: 'inara',
    name: 'Inara',
    homepage: 'https://inara.cz/',
    implemented: false,
    pendingReason:
      'Inara is not a journal-forwarding API: it takes its own event vocabulary, and an application must be registered with Inara to obtain an application key. That registration is the project owner’s to do — see docs/INTEGRATIONS.md.',
    privacy: {
      summary: 'A commander profile and community site, with its own event model rather than raw journal forwarding.',
      requiresCredential: true,
      credentialHelp:
        'Inara → Settings → API. Requires both your personal API key and an application key registered for EDFM Companion.',
      shares: [
        'Translated events describing travel, docking and activity',
        'Your Inara commander name',
      ],
      neverShares: [
        ...UNIVERSAL_NEVER_SHARES,
        'Your API key with anyone but Inara — it never reaches EDFM',
      ],
    },
  },

  edastro: {
    id: 'edastro',
    name: 'EDAstro',
    homepage: 'https://edastro.com/',
    implemented: false,
    pendingReason:
      'EDAstro consumes much of what it needs from EDDN already, so sending the same records twice would be duplication rather than contribution. Which observations it accepts directly has not been confirmed against current documentation, and nothing will be sent on a guess.',
    privacy: {
      summary: 'Exploration and exobiology cataloguing, much of which it already receives through EDDN.',
      requiresCredential: false,
      shares: [],
      neverShares: [
        ...UNIVERSAL_NEVER_SHARES,
        'Anything, until it is confirmed which submissions are supported directly',
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
