/**
 * Inara submission.
 *
 * ## What Inara can actually take, and what it cannot
 *
 * This was built against Inara's own API documentation rather than from memory,
 * and the documentation settled the design: **Inara has no event for organic or
 * biological data, and none for exploration scans.** Its write vocabulary is
 * travel, ranks, ships, materials, market and combat.
 *
 * That matters, because this app's Activity Journal records exobiology
 * milestones -- completed specimens, signals found, data sold. None of them has
 * an Inara equivalent. So unlike EDDN and EDSM, **Inara is not fed from the
 * Activity Journal at all**: there is nothing in the journal it could accept.
 *
 * What Inara can take, and what commanders actually want from it, is their
 * profile location staying current. So that is the whole of this integration --
 * `setCommanderTravelLocation`, and nothing else until a verified need appears.
 *
 * ## Why a "set" is not queued
 *
 * `setCommanderTravelLocation` overwrites the commander's current location
 * rather than appending to a log. A backlog of stale locations is therefore
 * worse than useless: replaying it would walk the profile through places the
 * commander has already left. Only the latest location is ever sent, which is
 * why this module takes one location and has no queue.
 *
 * ## The envelope
 *
 * ```
 * { "header": { appName, appVersion, isBeingDeveloped, APIkey, commanderName,
 *               commanderFrontierID },
 *   "events": [ { eventName, eventTimestamp, eventData } ] }
 * ```
 *
 * Field spellings are corroborated by two independent sources: Inara's API
 * documentation and EDMarketConnector's production client. Both give
 * `starsystemName`, `starsystemCoords`, `stationName`, `marketID` and
 * `starsystemBodyName` -- note the lowercase `system` and the uppercase `ID`.
 *
 * ## Credentials, corrected
 *
 * An earlier note in this project claimed Inara required an application key
 * registered by the project owner. **That was wrong.** The header carries the
 * *user's personal API key*, from their own Inara settings page; a generic
 * application key exists only for read-only events, which this does not use.
 */

export const INARA_URL = 'https://inara.cz/inapi/v1/';

/** Where a commander creates their own key. */
export const INARA_KEY_PAGE = 'https://inara.cz/elite/cmdr-settings-api/';

/**
 * Inara's documented status codes.
 *
 * 200 is success; 202 and 204 are warnings that still mean the event was
 * handled. 400 is the failure, and the documentation is explicit that at the
 * header level it may mean failed authorisation and cancel the whole batch.
 */
export const INARA_OK = 200;
export const INARA_WARNING = 202;
export const INARA_SOFT_ERROR = 204;
export const INARA_ERROR = 400;

/** The one event this client sends. */
export const INARA_SET_LOCATION = 'setCommanderTravelLocation';

export interface InaraEvent {
  readonly eventName: string;
  /** ISO 8601, and the documentation asks for the real time of the event. */
  readonly eventTimestamp: string;
  readonly eventData: Readonly<Record<string, unknown>>;
}

export interface InaraHeader {
  readonly appName: string;
  readonly appVersion: string;
  /** True while developing, which tells Inara to skip global events. */
  readonly isBeingDeveloped: boolean;
  readonly APIkey: string;
  readonly commanderName: string;
  /** `F123456`. Omitted rather than guessed when the journal has not said. */
  readonly commanderFrontierID?: string;
}

export interface InaraBatch {
  readonly header: InaraHeader;
  readonly events: readonly InaraEvent[];
}

/** A location as this app knows it. Every field may be unknown. */
export interface InaraLocation {
  readonly systemName: string | null;
  /** `[x, y, z]` in light years, as the journal's `StarPos` gives it. */
  readonly systemCoords: readonly [number, number, number] | null;
  readonly stationName: string | null;
  readonly marketId: number | null;
  readonly bodyName: string | null;
  readonly occurredAt: string;
}

/**
 * Build the location event, or decline.
 *
 * Returns null without a system name, which Inara documents as required. The
 * alternative -- sending an empty or placeholder name -- is a known way to
 * corrupt a profile, and EDMarketConnector carries a bug report about exactly
 * that, so it is refused here rather than sent hopefully.
 */
export function toInaraLocation(at: InaraLocation): InaraEvent | null {
  if (at.systemName === null || at.systemName.trim().length === 0) return null;

  const eventData: Record<string, unknown> = { starsystemName: at.systemName };

  if (at.systemCoords !== null) eventData['starsystemCoords'] = at.systemCoords;
  if (at.stationName !== null) eventData['stationName'] = at.stationName;
  if (at.marketId !== null) eventData['marketID'] = at.marketId;
  if (at.bodyName !== null) eventData['starsystemBodyName'] = at.bodyName;

  /*
   * `starsystemBodyCoords` is deliberately never sent, although Inara accepts
   * it. It is the commander's latitude and longitude on a planet surface, and
   * this project's privacy guarantee lists "Where you are standing on a planet"
   * among the things no integration ever shares. The body name alone keeps the
   * profile accurate without putting a surface position on a public page.
   */

  return { eventName: INARA_SET_LOCATION, eventTimestamp: at.occurredAt, eventData };
}

export function buildInaraBatch(input: {
  readonly apiKey: string;
  readonly commanderName: string;
  readonly commanderFrontierID: string | null;
  readonly appName: string;
  readonly appVersion: string;
  readonly isBeingDeveloped: boolean;
  readonly events: readonly InaraEvent[];
}): InaraBatch {
  return {
    header: {
      appName: input.appName,
      appVersion: input.appVersion,
      isBeingDeveloped: input.isBeingDeveloped,
      APIkey: input.apiKey,
      commanderName: input.commanderName,
      ...(input.commanderFrontierID !== null
        ? { commanderFrontierID: input.commanderFrontierID }
        : {}),
    },
    events: input.events,
  };
}

/* ------------------------------------------------------------ responses */

export interface InaraEventResult {
  readonly index: number;
  readonly status: number;
  readonly text: string;
  readonly accepted: boolean;
}

export type InaraOutcome =
  | { readonly kind: 'accepted'; readonly perEvent: readonly InaraEventResult[] }
  | { readonly kind: 'credential'; readonly message: string }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Whether a documented status means Inara handled the event. */
export function isInaraAccepted(status: number): boolean {
  return status === INARA_OK || status === INARA_WARNING || status === INARA_SOFT_ERROR;
}

/**
 * Read a response.
 *
 * Treated as untrusted input throughout. As with EDSM, the HTTP status is not
 * what decides the outcome -- `header.eventStatus` is -- and a body this cannot
 * read is never taken as success.
 */
export function parseInaraResponse(body: unknown): InaraOutcome {
  if (!isRecord(body)) return { kind: 'malformed', reason: 'the reply was not an object' };

  const header = body['header'];
  if (!isRecord(header)) return { kind: 'malformed', reason: 'the reply carried no header' };

  const status = header['eventStatus'];
  if (typeof status !== 'number') {
    return { kind: 'malformed', reason: 'the reply carried no status' };
  }
  const text = typeof header['eventStatusText'] === 'string' ? header['eventStatusText'] : '';

  if (status === INARA_ERROR) {
    /*
     * Documented as possibly meaning failed authorisation, with the whole batch
     * cancelled. Retrying a rejected key cannot succeed and hammers the server,
     * so this stops and asks the commander to look at it.
     */
    return { kind: 'credential', message: text || 'Inara rejected the request.' };
  }
  if (!isInaraAccepted(status)) {
    return { kind: 'retry', reason: text || `Inara replied with status ${status}` };
  }

  const rawEvents = body['events'];
  if (!Array.isArray(rawEvents)) {
    return { kind: 'malformed', reason: 'the reply carried no per-event results' };
  }

  const perEvent: InaraEventResult[] = [];
  rawEvents.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const code = typeof raw['eventStatus'] === 'number' ? raw['eventStatus'] : -1;
    perEvent.push({
      index,
      status: code,
      text: typeof raw['eventStatusText'] === 'string' ? raw['eventStatusText'] : '',
      accepted: isInaraAccepted(code),
    });
  });

  return { kind: 'accepted', perEvent };
}
