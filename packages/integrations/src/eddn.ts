/**
 * EDDN: the community data relay.
 *
 * Everything here is transcribed from the **live** branch of EDCD/EDDN, checked
 * 2026-09-29, because its own README says in capitals not to trust any other
 * branch as a description of the running service.
 *
 * EDDN is public. Anything sent is visible to anyone, forever, so the
 * sanitisation here is not a formality -- it is the entire safety property. The
 * schema names fields that must be absent, and several of them are
 * commander-private (`Wanted`, `ActiveFine`, `MyReputation`), so getting this
 * wrong publishes something about a person rather than about the galaxy.
 *
 * The approach is therefore **deny by default**: only the events the schema
 * names are considered at all, and forbidden keys are stripped recursively
 * rather than at the top level, because `Factions` is an array of objects with
 * its own forbidden fields.
 */

export const EDDN_UPLOAD_URL = 'https://eddn.edcd.io:4430/upload/';

/** The schema's own event enum. Nothing outside this list is ever sent. */
export const EDDN_JOURNAL_EVENTS: readonly string[] = [
  'Docked',
  'FSDJump',
  'Scan',
  'Location',
  'SAASignalsFound',
  'CarrierJump',
  'CodexEntry',
];

/**
 * Keys the journal schema forbids.
 *
 * Two kinds, deliberately in one list because the code treats them identically:
 * commander-private (`Wanted`, `ActiveFine`, `MyReputation`) and simply
 * out-of-scope (`FuelLevel`, `BoostUsed`).
 *
 * `Latitude`/`Longitude` matter more than they look: they say where on a planet
 * a commander was standing.
 */
export const EDDN_FORBIDDEN_KEYS: readonly string[] = [
  'ActiveFine',
  'CockpitBreach',
  'BoostUsed',
  'FuelLevel',
  'FuelUsed',
  'JumpDist',
  'Latitude',
  'Longitude',
  'Wanted',
  'IsNewEntry',
  'NewTraitsDiscovered',
  'Traits',
  'VoucherAmount',
  // Inside Factions entries.
  'HappiestSystem',
  'HomeSystem',
  'MyReputation',
  'SquadronFaction',
];

export interface EddnIdentity {
  /** "preferably simply the relevant in-game Commander name" -- the schema's words. */
  readonly uploaderID: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
  /** Both mandatory per the live spec. */
  readonly gameversion: string;
  readonly gamebuild: string;
}

/** System position, which most events do not carry and the schema requires. */
export interface EddnAugmentation {
  readonly starSystem: string;
  readonly starPos: readonly [number, number, number];
  readonly systemAddress: number;
  /**
   * Horizons/Odyssey flags from LoadGame.
   *
   * `undefined` means the LoadGame carried no such boolean, and the spec is
   * emphatic about that case: do not include it, **not even as false**. So these
   * are optional rather than defaulted, and the builder omits them.
   */
  readonly horizons?: boolean;
  readonly odyssey?: boolean;
}

export interface EddnMessage {
  readonly $schemaRef: string;
  readonly header: Record<string, string>;
  readonly message: Record<string, unknown>;
}

/**
 * Strip everything the schema forbids, at every depth.
 *
 * Recursive because `Factions` is an array of objects carrying their own
 * forbidden keys. A top-level-only sweep would publish `MyReputation` for every
 * faction in the system.
 */
export function sanitiseForEddn(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitiseForEddn);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // "Remove any data where the name of the relevant key has a _Localised
    // suffix." Checked by suffix, not by a pattern, so it cannot mis-fire.
    if (key.endsWith('_Localised')) continue;
    if (EDDN_FORBIDDEN_KEYS.includes(key)) continue;
    out[key] = sanitiseForEddn(v);
  }
  return out;
}

/**
 * Build a message, or explain why there is not one.
 *
 * Returns null rather than throwing: most journal events are simply not EDDN's
 * business, and that is the normal case rather than an error.
 *
 * `test` routes to the schema's test form, which the spec requires when
 * exercising EDDN-handling code. The default is deliberately `true` at every
 * call site that is not a real submission.
 */
export function buildEddnJournalMessage(
  event: string,
  raw: Readonly<Record<string, unknown>>,
  identity: EddnIdentity,
  augment: EddnAugmentation,
  options: { readonly test?: boolean } = {},
): EddnMessage | null {
  if (!EDDN_JOURNAL_EVENTS.includes(event)) return null;

  const timestamp = raw['timestamp'];
  if (typeof timestamp !== 'string') return null;

  const cleaned = sanitiseForEddn(raw) as Record<string, unknown>;

  // The schema's required properties. Most events carry StarSystem and
  // SystemAddress themselves; almost none carry StarPos, so it is supplied from
  // the position the commander is actually at.
  const message: Record<string, unknown> = {
    ...cleaned,
    timestamp,
    event,
    StarSystem: (cleaned['StarSystem'] as string) ?? augment.starSystem,
    StarPos: augment.starPos,
    SystemAddress: (cleaned['SystemAddress'] as number) ?? augment.systemAddress,
  };

  // Absent means absent. The spec is explicit that a false is not an acceptable
  // substitute for "the game did not say".
  if (augment.horizons !== undefined) message['horizons'] = augment.horizons;
  if (augment.odyssey !== undefined) message['odyssey'] = augment.odyssey;

  const suffix = options.test === true ? '/test' : '';
  return {
    $schemaRef: `https://eddn.edcd.io/schemas/journal/1${suffix}`,
    header: {
      uploaderID: identity.uploaderID,
      softwareName: identity.softwareName,
      softwareVersion: identity.softwareVersion,
      gameversion: identity.gameversion,
      gamebuild: identity.gamebuild,
    },
    message,
  };
}

/**
 * Final check before anything leaves the machine.
 *
 * Belt and braces over `sanitiseForEddn`, and worth the duplication: this is a
 * public relay, and the cost of one forbidden field slipping through is a
 * permanent public record of something about a person. Returns the offending
 * key paths so a failure is diagnosable rather than just refused.
 */
export function auditEddnMessage(message: EddnMessage): readonly string[] {
  const problems: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (key.endsWith('_Localised')) problems.push(here);
      else if (EDDN_FORBIDDEN_KEYS.includes(key)) problems.push(here);
      walk(v, here);
    }
  };

  walk(message.message, '');

  for (const field of ['uploaderID', 'softwareName', 'softwareVersion', 'gameversion', 'gamebuild']) {
    if (!message.header[field]) problems.push(`header.${field} is missing`);
  }
  for (const field of ['timestamp', 'event', 'StarSystem', 'StarPos', 'SystemAddress']) {
    if (message.message[field] === undefined) problems.push(`message.${field} is missing`);
  }

  return problems;
}
