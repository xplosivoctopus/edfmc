/**
 * The data-sharing audit: one honest answer to "what has left this machine?"
 *
 * This is the screen a commander opens when they want to check, not to
 * configure. So it is built from what the queue and the integration state
 * actually record, and it is careful in one specific direction: **it never
 * describes activity that did not happen.** A row reading "Connected" beside a
 * service nothing has ever been sent to is the exact failure this exists to
 * prevent, and it would discredit every other line on the page.
 *
 * Pure functions over plain records, so every claim below is testable without a
 * database, a network or a window.
 */

import { sanitiseError } from './queue.js';
import { integrationStatus, mayTransmit } from './registry.js';
import type { IntegrationDescriptor, IntegrationId } from './types.js';

/** Queue counts for one integration and one commander. */
export interface QueueSummary {
  readonly queued: number;
  readonly attempting: number;
  readonly accepted: number;
  readonly retryable: number;
  readonly rejected: number;
  /**
   * Items whose owning commander could not be established.
   *
   * Counted separately and never sent. Surfaced rather than hidden, because
   * "nothing is queued" and "something is queued that we refuse to attribute"
   * are different facts and only one of them is reassuring.
   */
  readonly unattributed: number;
  /** Earliest scheduled retry, or null when nothing is waiting. */
  readonly nextAttemptAt: string | null;
}

export const EMPTY_QUEUE: QueueSummary = {
  queued: 0,
  attempting: 0,
  accepted: 0,
  retryable: 0,
  rejected: 0,
  unattributed: 0,
  nextAttemptAt: null,
};

export interface SharingInput {
  readonly enabled: boolean;
  readonly hasCredential: boolean;
  readonly queue: QueueSummary;
  /** ISO 8601 of the last accepted transmission, or null if there has never been one. */
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
}

/**
 * What is happening with one service, in the terms a commander would ask in.
 *
 * `not-built` is deliberately distinct from `never-sent`: "this cannot send yet"
 * and "this could send but has had nothing to send" are different, and rolling
 * them together would hide unfinished work behind an innocuous-looking idle
 * state.
 */
export type TransmissionState =
  | 'not-built'
  | 'off'
  | 'needs-credential'
  | 'never-sent'
  | 'idle'
  | 'pending'
  | 'failing';

export interface SharingRow {
  readonly id: IntegrationId;
  readonly name: string;
  readonly descriptor: IntegrationDescriptor;
  readonly status: ReturnType<typeof integrationStatus>;
  readonly transmission: TransmissionState;
  /** One sentence, safe to show verbatim. */
  readonly summary: string;
  readonly enabled: boolean;
  readonly hasCredential: boolean;
  readonly queue: QueueSummary;
  readonly lastSuccessAt: string | null;
  /** Sanitised again here; see the note on defence in depth below. */
  readonly lastError: string | null;
  /** Whether anything has ever been accepted by this service for this commander. */
  readonly everSent: boolean;
  readonly canRetryNow: boolean;
  readonly canClearRejected: boolean;
}

function transmissionOf(descriptor: IntegrationDescriptor, input: SharingInput): TransmissionState {
  if (!descriptor.implemented) return 'not-built';
  if (!input.enabled) return 'off';
  if (descriptor.privacy.requiresCredential && !input.hasCredential) return 'needs-credential';
  if (input.queue.retryable > 0 || input.lastError) return 'failing';
  if (input.queue.queued > 0 || input.queue.attempting > 0) return 'pending';
  if (input.lastSuccessAt === null && input.queue.accepted === 0) return 'never-sent';
  return 'idle';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summaryFor(
  descriptor: IntegrationDescriptor,
  state: TransmissionState,
  input: SharingInput,
): string {
  switch (state) {
    case 'not-built':
      // Told plainly that nothing is going anywhere, and why, instead of being
      // shown a switch and left to assume.
      return `Nothing has been sent, and nothing will be. ${descriptor.pendingReason ?? ''}`.trim();
    case 'off':
      return 'Switched off. Nothing is being sent.';
    case 'needs-credential':
      return 'Switched on, but waiting for your API key. Nothing is sent until you add one.';
    case 'never-sent':
      return 'Switched on. Nothing has been sent yet.';
    case 'pending':
      return `${plural(input.queue.queued + input.queue.attempting, 'item', 'items')} waiting to be sent.`;
    case 'failing':
      return input.queue.retryable > 0
        ? `${plural(input.queue.retryable, 'item', 'items')} failed and will be retried.`
        : 'The last attempt failed.';
    case 'idle':
      return 'Switched on, up to date, nothing waiting.';
  }
}

/**
 * Build one row.
 *
 * `lastError` is sanitised here even though it was sanitised before it was
 * stored. The duplication is the same reasoning as the second EDDN audit pass:
 * this is the last point before a string reaches a screen a commander may
 * screenshot, and a credential that slips through is not recoverable.
 */
export function sharingRow(descriptor: IntegrationDescriptor, input: SharingInput): SharingRow {
  const transmission = transmissionOf(descriptor, input);
  return {
    id: descriptor.id,
    name: descriptor.name,
    descriptor,
    status: integrationStatus(descriptor, {
      enabled: input.enabled,
      hasCredential: input.hasCredential,
      lastError: input.lastError,
    }),
    transmission,
    summary: summaryFor(descriptor, transmission, input),
    enabled: input.enabled,
    hasCredential: input.hasCredential,
    queue: input.queue,
    lastSuccessAt: input.lastSuccessAt,
    lastError: input.lastError === null ? null : sanitiseError(input.lastError),
    everSent: input.lastSuccessAt !== null || input.queue.accepted > 0,
    // Retrying is only meaningful when the service could actually send.
    canRetryNow:
      mayTransmit(descriptor, { enabled: input.enabled, hasCredential: input.hasCredential }) &&
      input.queue.retryable > 0,
    canClearRejected: input.queue.rejected > 0,
  };
}

export interface SharingAudit {
  readonly rows: readonly SharingRow[];
  /**
   * True when nothing has ever been transmitted by any integration.
   *
   * Stated as its own fact because it is the single thing most commanders open
   * this screen to confirm, and it deserves a plain sentence rather than four
   * rows of zeroes to add up.
   */
  readonly nothingEverSent: boolean;
  readonly totalPending: number;
  readonly totalRejected: number;
  readonly totalUnattributed: number;
  /** Whose sharing this describes. Null before a commander is identified. */
  readonly commanderName: string | null;
  readonly commanderFid: string | null;
}

export function sharingAudit(input: {
  readonly descriptors: readonly IntegrationDescriptor[];
  readonly state: Readonly<Partial<Record<IntegrationId, SharingInput>>>;
  readonly commanderName: string | null;
  readonly commanderFid: string | null;
}): SharingAudit {
  const rows = input.descriptors.map((d) =>
    sharingRow(d, {
      enabled: false,
      hasCredential: false,
      queue: EMPTY_QUEUE,
      lastSuccessAt: null,
      lastError: null,
      ...(input.state[d.id] ?? {}),
    }),
  );

  return {
    rows,
    nothingEverSent: rows.every((r) => !r.everSent),
    totalPending: rows.reduce((n, r) => n + r.queue.queued + r.queue.attempting, 0),
    totalRejected: rows.reduce((n, r) => n + r.queue.rejected, 0),
    totalUnattributed: rows.reduce((n, r) => n + r.queue.unattributed, 0),
    commanderName: input.commanderName,
    commanderFid: input.commanderFid,
  };
}

/**
 * The categories no integration shares, gathered once.
 *
 * Intersected rather than concatenated: a guarantee that holds for three
 * services and not the fourth is not a guarantee, and printing it as one at the
 * top of the page would be the most consequential kind of wrong this screen
 * could be. Per-service lists still show the rest.
 */
export function universalNeverShares(
  descriptors: readonly IntegrationDescriptor[],
): readonly string[] {
  const [first, ...rest] = descriptors;
  if (!first) return [];
  return first.privacy.neverShares.filter((item) =>
    rest.every((d) => d.privacy.neverShares.includes(item)),
  );
}
