/**
 * External service integrations.
 *
 * Four services, four genuinely different models, and one shared idea: the
 * commander must be able to see what leaves their machine before it leaves.
 *
 * ## What is deliberately NOT shared between adapters
 *
 * There is no common `send(event)` interface, because the services do not share
 * a model and pretending otherwise would mean lying to at least three of them.
 * EDDN takes sanitised raw journal messages on a public relay. EDSM takes
 * journal lines with a per-commander API key. Inara takes its own event
 * vocabulary, not journal forwarding. EDAstro takes specialised observations.
 *
 * What they DO share is the lifecycle, the privacy manifest, and the rule that
 * a disabled integration performs no network activity at all.
 */

/** Which service. Stable strings: these are persisted and appear in settings. */
export type IntegrationId = 'eddn' | 'edsm' | 'inara' | 'edastro';

/**
 * Where an integration stands, as the commander would describe it.
 *
 * `needs-configuration` is separate from `error` on purpose: "you have not given
 * me an API key" is not a failure, and showing it as one teaches people to
 * ignore error states.
 */
export type IntegrationStatus =
  | 'disabled'
  | 'needs-configuration'
  | 'ready'
  | 'syncing'
  | 'error'
  | 'not-implemented';

/**
 * What an integration sends, in the commander's terms, and what it never sends.
 *
 * Both halves are required. A list of what is shared invites the question "and
 * what else?", and the answer belongs on the same screen -- `Connected` on its
 * own is the label this exists to replace.
 *
 * These are claims the code must actually honour, so the sanitiser is tested
 * against them rather than the other way round.
 */
export interface PrivacyManifest {
  readonly shares: readonly string[];
  readonly neverShares: readonly string[];
  /** One sentence on what the service is, for someone who has not met it. */
  readonly summary: string;
  /** Whether a credential must be supplied before anything can be sent. */
  readonly requiresCredential: boolean;
  /** Where to get that credential, when one is needed. */
  readonly credentialHelp?: string;
}

export interface IntegrationDescriptor {
  readonly id: IntegrationId;
  readonly name: string;
  readonly homepage: string;
  readonly privacy: PrivacyManifest;
  /**
   * False when the adapter is designed but cannot run yet.
   *
   * Stated rather than hidden: an integration that silently does nothing is
   * worse than one that says it is not built.
   */
  readonly implemented: boolean;
  /** Why it is not implemented, shown verbatim. */
  readonly pendingReason?: string;
}

/**
 * Never logged, never persisted in plain settings, never sent to EDFM.
 *
 * The value only ever travels between the OS credential store and the service
 * it belongs to. See docs/INTEGRATIONS.md for the storage decision.
 */
export interface IntegrationCredential {
  readonly id: IntegrationId;
  /** e.g. an EDSM commander name. Not itself secret, but still local. */
  readonly account?: string;
  readonly secret: string;
}

/** Outcome of an attempted send. Deliberately carries no response body. */
export type SendOutcome =
  | { readonly kind: 'sent'; readonly messages: number }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly detail: string };

export const INTEGRATION_LIMITS = {
  /** A batch is a courtesy to the service, not a way to move a backlog at once. */
  maxBatch: 20,
  /** Nothing this project sends is large; anything bigger is a bug. */
  maxMessageBytes: 256 * 1024,
  requestTimeoutMs: 15_000,
} as const;
