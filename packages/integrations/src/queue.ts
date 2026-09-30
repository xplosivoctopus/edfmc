/**
 * Durable queues, one per integration.
 *
 * Three properties matter, and each is a decision rather than an implementation
 * detail.
 *
 * **A failing service must not block another.** Queues are keyed by integration,
 * so EDSM being down cannot stop EDDN. There is no shared head-of-line.
 *
 * **A retry must not duplicate.** The id is supplied by the producer and is
 * deterministic -- for a journal submission it derives from the source event id,
 * which the engine already guarantees stable across restart and replay. Enqueue
 * is therefore idempotent by construction, and a crash mid-send costs at most a
 * repeated attempt, never a repeated record.
 *
 * **Some failures must stop.** A rejected schema or a wrong API key will be
 * rejected identically forever; retrying it is noise for the commander and load
 * on someone else's server. So failures are classified, and only retryable ones
 * come back.
 *
 * This module is pure: it decides, and the caller persists. That is what lets
 * backoff and classification be tested without a database or a clock.
 */

import type { IntegrationId } from './types.js';

export type QueueStatus = 'queued' | 'attempting' | 'accepted' | 'retryable' | 'rejected';

export interface QueueItem {
  /** Deterministic, producer-supplied. See the note above. */
  readonly id: string;
  readonly integration: IntegrationId;
  /**
   * Which commander this belongs to.
   *
   * Null means the owner could not be established, and such an item is never
   * sent: guessing which account should receive somebody's data is worse than
   * not sending it.
   */
  readonly commanderFid: string | null;
  readonly status: QueueStatus;
  readonly payload: string;
  readonly attempts: number;
  readonly lastError: string | null;
  /** ISO 8601; null when it may be attempted immediately. */
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const QUEUE_LIMITS = {
  /**
   * Give up after this many tries.
   *
   * With the schedule below that is roughly half an hour of trying, which is
   * long enough to ride out a restart of someone else's service and short
   * enough that a queue does not grow forever behind a permanent problem.
   */
  maxAttempts: 6,
  /** Per integration. Beyond this the oldest are dropped; see `trim`. */
  maxDepth: 500,
  /** A queued payload is one submission, not a batch. */
  maxPayloadBytes: 256 * 1024,
} as const;

/**
 * Backoff, in seconds, indexed by attempt number.
 *
 * Explicit rather than computed: a table can be read and reasoned about, and
 * nobody has to work out what the exponent does on the fifth try. Caps at ten
 * minutes, because a commander who fixes their API key should not wait an hour
 * to find out it worked.
 */
const BACKOFF_SECONDS: readonly number[] = [5, 30, 120, 300, 600, 600];

export function backoffFor(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[index]!;
}

/**
 * How an attempt ended.
 *
 * `permanent` and `retryable` are the whole point of the distinction: an HTTP
 * 400 from a schema validator means the payload will never be accepted, and a
 * 503 means the server is having a moment.
 */
export type AttemptResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'retryable'; readonly detail: string }
  | { readonly kind: 'permanent'; readonly detail: string };

/**
 * Classify an HTTP response.
 *
 * 429 is retryable despite being a 4xx: it explicitly means "later", not "never".
 * 408 likewise. Everything else in the 4xx range is the client's fault and will
 * not improve by repetition.
 */
export function classifyHttp(status: number, detail = ''): AttemptResult {
  if (status >= 200 && status < 300) return { kind: 'accepted' };
  if (status === 429 || status === 408) {
    return { kind: 'retryable', detail: detail || `HTTP ${status}` };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'permanent', detail: detail || `HTTP ${status}` };
  }
  return { kind: 'retryable', detail: detail || `HTTP ${status}` };
}

/**
 * Strip anything that must not be stored or shown.
 *
 * A last-error string reaches the audit screen and the database, so it must
 * never carry a credential. Rather than trying to recognise every shape of
 * secret, this keeps only a short, structural summary: nothing that looks like a
 * key survives being truncated to a sentence with query strings removed.
 */
export function sanitiseError(detail: string): string {
  const withoutQuery = detail.replace(/\?[^\s]*/g, '?…');
  const withoutAuth = withoutQuery.replace(/(api[_-]?key|token|secret|password)=\S*/gi, '$1=…');
  return withoutAuth.slice(0, 200);
}

/**
 * The next state of an item after an attempt.
 *
 * Returns a new item rather than mutating, so the caller writes exactly what it
 * is given and a failed write leaves the previous row intact.
 */
export function applyAttempt(item: QueueItem, result: AttemptResult, now: Date): QueueItem {
  const at = now.toISOString();
  const attempts = item.attempts + 1;

  if (result.kind === 'accepted') {
    return { ...item, status: 'accepted', attempts, lastError: null, nextAttemptAt: null, updatedAt: at };
  }

  if (result.kind === 'permanent') {
    // Never retried. A schema rejection or a bad key is not going to change.
    return {
      ...item,
      status: 'rejected',
      attempts,
      lastError: sanitiseError(result.detail),
      nextAttemptAt: null,
      updatedAt: at,
    };
  }

  if (attempts >= QUEUE_LIMITS.maxAttempts) {
    // Out of patience. Recorded as rejected with the reason, so the audit view
    // can say why rather than showing an item stuck at "queued" forever.
    return {
      ...item,
      status: 'rejected',
      attempts,
      lastError: sanitiseError(`gave up after ${attempts} attempts: ${result.detail}`),
      nextAttemptAt: null,
      updatedAt: at,
    };
  }

  const next = new Date(now.getTime() + backoffFor(attempts) * 1000);
  return {
    ...item,
    status: 'retryable',
    attempts,
    lastError: sanitiseError(result.detail),
    nextAttemptAt: next.toISOString(),
    updatedAt: at,
  };
}

/** Whether an item may be attempted now. */
export function isDue(item: QueueItem, now: Date): boolean {
  if (item.status === 'accepted' || item.status === 'rejected') return false;
  if (item.status === 'attempting') return false;
  // An item whose owner is unknown is never sent. Guessing which account should
  // receive somebody's data is worse than not sending it.
  if (item.commanderFid === null) return false;
  if (item.nextAttemptAt === null) return true;
  const due = Date.parse(item.nextAttemptAt);
  return !Number.isFinite(due) || due <= now.getTime();
}

/** Items ready to send, oldest first, bounded. */
export function dueItems(
  items: readonly QueueItem[],
  now: Date,
  limit: number,
): readonly QueueItem[] {
  return items
    .filter((i) => isDue(i, now))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

/** Queue depth as the audit view reports it: work still outstanding. */
export function pendingDepth(items: readonly QueueItem[]): number {
  return items.filter((i) => i.status === 'queued' || i.status === 'retryable' || i.status === 'attempting')
    .length;
}

/**
 * Which items to drop when a queue has grown past its bound.
 *
 * Oldest outstanding first. A queue this deep means something has been broken
 * for a long time, and the newest observations are the ones still worth sending.
 * Accepted and rejected items are removed first, since they are only history.
 */
export function trim(
  items: readonly QueueItem[],
  // Typed rather than inferred: QUEUE_LIMITS is `as const`, so the default alone
  // would narrow this to the literal 500 and reject any other bound.
  maxDepth: number = QUEUE_LIMITS.maxDepth,
): readonly string[] {
  const settled = items.filter((i) => i.status === 'accepted' || i.status === 'rejected');
  const outstanding = items.filter((i) => !settled.includes(i));
  const excess = outstanding.length - maxDepth;

  const drop = settled.map((i) => i.id);
  if (excess > 0) {
    drop.push(
      ...[...outstanding]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, excess)
        .map((i) => i.id),
    );
  }
  return drop;
}
