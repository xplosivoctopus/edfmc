/**
 * Bundled context rules — version 1.
 *
 * This is the "small verified set" §6 asks for. Two kinds of verification went into
 * it, and both matter:
 *
 *  - **Every `page` title below was checked against a live listing of EDFM's pages**
 *    (MediaWiki `list=allpages`, 2026-09-01). No rule links to a page that does not
 *    exist. Inventing plausible-looking titles would produce broken links that look
 *    authoritative, which is the exact failure mode the project is built to avoid.
 *  - **Every trigger was checked against the 197,164-line journal corpus.** Each
 *    event named here actually occurs, and each service token was observed in real
 *    `StationServices` arrays.
 *
 * Several contexts named in the original brief are deliberately ABSENT because EDFM
 * has no corresponding page yet: settlement guides, mission-type guides, a
 * crime/security guide, and an Odyssey materials guide. Those are content gaps, not
 * code gaps — see docs/CONTEXT.md. Rules for them should be added server-side once
 * the pages exist, which is exactly why the rule set is server-driven.
 *
 * This bundled copy is the offline fallback (§22). The server-supplied set
 * supersedes it when one is available.
 */

import type { ContextRuleSet } from './types.js';

export const BUNDLED_RULES: ContextRuleSet = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00Z',
  source: 'bundled',
  rules: [
    /* ------------------------------------------------------------- combat */
    {
      id: 'interdicted',
      title: 'Being interdicted',
      subtitle: 'Someone is pulling you out of supercruise',
      when: { kind: 'event', name: 'Interdicted' },
      // Highest priority in the set: it is the only entry that is time-critical.
      priority: 95,
      ttlSeconds: 180,
      // Over the moment it resolves: escaped, back in supercruise, docked, jumped, or dead.
      endsOn: ['EscapeInterdiction', 'SupercruiseEntry', 'Docked', 'FSDJump', 'Died'],
      resources: [{ label: 'Frame Shift Drive Interdictor', page: 'Frame Shift Drive Interdictor' }],
      actions: [
        'Follow the blue circle to fight the interdiction.',
        'Or zero your throttle to submit deliberately.',
      ],
      // Editorial guidance from the project owner (edfieldmanual.com), not derived
      // from journal data — that is exactly what `note` is for.
      note: 'Submitting voluntarily lets your FSD recharge faster, so you can potentially escape sooner.',
    },

    /* ------------------------------------------------------- colonisation */
    {
      id: 'colonisation-depot',
      title: 'Construction site',
      subtitle: 'Delivering to a colonisation depot',
      when: { kind: 'event', name: 'ColonisationConstructionDepot' },
      priority: 85,
      ttlSeconds: 900,
      // Leaving the depot ends it; while still there the event keeps re-firing.
      endsOn: ['Undocked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Colonisation', page: 'Colonisation' },
        { label: 'Trailblazers', page: 'Trailblazers' },
        { label: 'Pioneer Supplies', page: 'Pioneer Supplies' },
      ],
    },
    {
      id: 'station-pioneer-supplies',
      title: 'Pioneer Supplies available',
      when: { kind: 'service', id: 'pioneersupplies' },
      priority: 45,
      ttlSeconds: 1800,
      resources: [
        { label: 'Pioneer Supplies', page: 'Pioneer Supplies' },
        { label: 'Colonisation', page: 'Colonisation' },
      ],
    },

    /* --------------------------------------------------------- exobiology */
    {
      id: 'exobiology-scan',
      title: 'Sampling biology',
      subtitle: 'Scanning organic life on foot',
      when: { kind: 'event', name: 'ScanOrganic' },
      priority: 80,
      ttlSeconds: 600,
      // Lifting off ends the sampling run. Embark does not -- the next patch may be a short hop away.
      endsOn: ['Liftoff', 'FSDJump', 'Docked', 'SellOrganicData'],
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },
    /*
     * Vista Genomics, but only when there is something to sell.
     *
     * The service is present at 155 of 295 stations -- over half, including fleet
     * carriers -- so on its own it fires constantly and told commanders to sell data
     * they did not have.
     *
     * Gating it needs a holdings figure the journal never states: neither `Backpack`
     * (suit inventory) nor `Materials` (engineering stock) includes organic data. So
     * `exobiologyToSell` accumulates completed `Analyse` scans and subtracts what
     * sales report, and is treated as a lower bound rather than a total. See its
     * doc comment for why a death resets it, and why that is the conservative
     * choice rather than a claim about the mechanic.
     */
    {
      id: 'station-vista-genomics',
      title: 'Vista Genomics available',
      subtitle: 'You have exobiology data to sell',
      when: {
        kind: 'all',
        of: [
          { kind: 'service', id: 'vistagenomics' },
          { kind: 'state', path: 'exobiologyToSell', op: 'gt', value: 0 },
        ],
      },
      priority: 55,
      ttlSeconds: 1800,
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },

    /* -------------------------------------------------------- engineering */
    /*
     * Engineering is triggered by *activity*, not by a station service.
     *
     * There was previously a rule keyed on the `engineer` service token, which was
     * wrong: that token appears at 227 of 242 distinct stations in the corpus —
     * including all 17 Fleet Carriers — so it does not mean "at an Engineer". It
     * reported "At an Engineer" while docked at the commander's own carrier.
     *
     * `tuning` was evaluated as an alternative and rejected too: 103 of 266
     * stations, including Lave Station and Hutton Orbital. Its actual meaning is
     * unverified, and a rule built on an unverified token is a guess.
     *
     * EngineerCraft / EngineerProgress / EngineerContribution are unambiguous —
     * they only occur when the commander is actually engineering something.
     * Recognising the *station* as an Engineer needs a station-identity list,
     * which is reference data belonging server-side. See docs/CONTEXT.md.
     */
    {
      id: 'engineering-activity',
      title: 'Engineering',
      subtitle: 'Recent engineering activity',
      when: {
        kind: 'any',
        of: [
          // Unambiguous: only emitted when something is actually being modified.
          { kind: 'event', name: 'EngineerCraft' },
          { kind: 'event', name: 'EngineerContribution' },
          /*
           * EngineerProgress has two shapes, and only one of them means anything
           * happened. 277 of 338 occurrences in the corpus carry an `Engineers`
           * array — a full progress summary emitted at startup and periodically
           * through a session, regardless of what the commander is doing. Keying
           * on the event name alone made "Engineering" appear while parked on a
           * Fleet Carrier.
           *
           * The remaining 61 omit that array and describe a single real change.
           */
          {
            kind: 'all',
            of: [
              { kind: 'event', name: 'EngineerProgress' },
              { kind: 'not', of: { kind: 'field', path: 'Engineers', op: 'exists' } },
            ],
          },
        ],
      },
      priority: 75,
      ttlSeconds: 300,
      // Engineering happens docked or landed, so leaving ends it. This is the case that was reported: "Engineering" shown at a station three systems from the Engineer.
      endsOn: ['Undocked', 'Liftoff', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Engineering', page: 'Engineering' },
        { label: 'Engineering Blueprints', page: 'Engineering Blueprints' },
        { label: 'Engineers', page: 'Engineers' },
        { label: 'Engineer Unlock Guide', page: 'Engineer Unlock Guide' },
      ],
    },
    /*
     * Material Traders, by kind.
     *
     * `StationServices` carries only the bare token `materialtrader` and never
     * says which of the three kinds the station has -- measured over 141 docks at
     * trader stations, with no field in any event naming the type. The type comes
     * from `MaterialTrade.TraderType`, so it is known for stations the commander
     * has actually traded at and UNKNOWN elsewhere. See `learnTrader`.
     *
     * Inferring it from station economy was measured and rejected: High Tech gave
     * `encoded` 7 times but `raw` once, Industrial gave `manufactured` 10 times
     * but `raw` twice, and Extraction produced all three. A rule built on that
     * would confidently name the wrong trader.
     *
     * Hence four rules rather than one. The typed three are worth the duplication
     * because which kind it is, is the whole question a commander has when they see
     * a trader -- and the untyped rule still fires when the answer is not known,
     * so nothing is lost by not knowing.
     */
    {
      id: 'station-material-trader-encoded',
      title: 'Encoded Material Trader',
      subtitle: 'Trades encoded materials',
      when: {
        kind: 'all',
        of: [
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'encoded' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader-raw',
      title: 'Raw Material Trader',
      subtitle: 'Trades raw materials',
      when: {
        kind: 'all',
        of: [
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'raw' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader-manufactured',
      title: 'Manufactured Material Trader',
      subtitle: 'Trades manufactured materials',
      when: {
        kind: 'all',
        of: [
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'manufactured' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader',
      title: 'Material Trader available',
      // Deliberately does not name a kind. Fires only while the kind is genuinely
      // unestablished, so it degrades to the honest statement rather than guessing.
      subtitle: 'Kind unknown until you trade here once',
      when: {
        kind: 'all',
        of: [
          { kind: 'service', id: 'materialtrader' },
          { kind: 'not', of: { kind: 'state', path: 'traderType', op: 'exists' } },
        ],
      },
      priority: 55,
      ttlSeconds: 1800,
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },

    /* ------------------------------------------------------------- mining */
    {
      id: 'mining-prospecting',
      title: 'Prospecting',
      subtitle: 'Assessing an asteroid',
      when: { kind: 'event', name: 'ProspectedAsteroid' },
      priority: 70,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Mining', page: 'Mining' },
        { label: 'Laser Mining', page: 'Laser Mining' },
        { label: 'Core Mining', page: 'Core Mining' },
        { label: 'How to Use a Prospector Limpet', page: 'How to Use a Prospector Limpet' },
      ],
    },
    /*
     * `SAASignalsFound` fires for EVERY detailed surface scan, not just rings.
     * Measured: 198 events, of which only 29 are rings -- so keying on the event
     * name alone was wrong 85% of the time, and the overlay announced "Ring
     * scanned -- hotspot signals found" after DSS-ing a planet.
     *
     * The same trap as `ApproachSettlement` firing at Guardian ruins: an event name
     * that reads like it means one thing and fires for a superset.
     *
     * `BodyName` ending in "Ring" separates them exactly -- 29 of 29 rings, zero
     * false positives across the corpus. A structural test on the signal payload
     * was tried and is worse: ring signals are bare commodity names
     * ("Serendibite") while planet signals are `$SAA_SignalType_*;` tokens, but
     * planets with surface mining sites report `$PlanetaryMiningLocation_Name;`,
     * which that test misclassified 11 times.
     */
    {
      id: 'mining-ring-scan',
      title: 'Ring scanned',
      subtitle: 'Hotspot signals found',
      when: {
        kind: 'all',
        of: [
          { kind: 'event', name: 'SAASignalsFound' },
          { kind: 'field', path: 'BodyName', op: 'endsWith', value: 'Ring' },
        ],
      },
      priority: 60,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Mining Hotspot', page: 'Mining Hotspot' },
        { label: 'How to Find a Mining Hotspot', page: 'How to Find a Mining Hotspot' },
        { label: 'Planetary Rings', page: 'Planetary Rings' },
      ],
    },
    {
      id: 'mining-refining',
      title: 'Refining',
      when: { kind: 'event', name: 'MiningRefined' },
      priority: 50,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Refinery', page: 'Refinery' },
        { label: 'How to Use a Refinery', page: 'How to Use a Refinery' },
        { label: 'How to Resolve a Full Refinery', page: 'How to Resolve a Full Refinery' },
      ],
    },

    /* ----------------------------------------------------- fleet carriers */
    {
      id: 'fleet-carrier',
      title: 'Fleet Carrier services',
      when: {
        kind: 'any',
        of: [
          { kind: 'service', id: 'carriermanagement' },
          { kind: 'service', id: 'carrierfuel' },
          { kind: 'state', path: 'stationType', op: 'eq', value: 'FleetCarrier' },
        ],
      },
      priority: 60,
      ttlSeconds: 1800,
      resources: [
        { label: 'Fleet Carriers', page: 'Fleet Carriers' },
        {
          label: 'Fleet Carrier Administration Systems',
          page: 'Fleet Carrier Administration Systems',
        },
      ],
    },

    /* --------------------------------------------------------- powerplay */
    {
      id: 'powerplay-activity',
      title: 'Powerplay activity',
      when: {
        kind: 'event',
        name: ['PowerplayMerits', 'PowerplayCollect', 'PowerplayDeliver', 'PowerplayRank'],
      },
      priority: 40,
      ttlSeconds: 600,
      // Powerplay work is per-system; leaving the system ends its relevance.
      endsOn: ['FSDJump'],
      resources: [{ label: 'Powerplay', page: 'Powerplay' }],
    },

    /*
     * There is deliberately no `outfitting` rule.
     *
     * That service is present at 167 of 266 distinct stations (62.8%). A context
     * that fires at two-thirds of stations tells the commander nothing they cannot
     * already see in the station menu, and crowds out contexts that do.
     *
     * Prevalence measured across the corpus, and the bar every service rule here
     * has to clear:
     *   engineer         227/242 (93.8%)  rejected - says nothing
     *   outfitting       167/266 (62.8%)  rejected - low value
     *   shipyard         148/266 (55.6%)  not used
     *   vistagenomics    137/266 (51.5%)  used
     *   tuning           103/266 (38.7%)  rejected - meaning unverified
     *   pioneersupplies  101/266 (38.0%)  used
     *   carriermanagement 44/266 (16.5%)  used
     *   materialtrader    37/266 (13.9%)  used
     */
  ],
};
