# Elite Dangerous Journal — Empirical Findings

All figures here were measured, not quoted from documentation. Where this document
disagrees with a third-party wiki, trust this document *for these builds* and re-run
the profiler after a game update.

## Corpus

| Property | Value |
|---|---|
| Location | Windows Saved Games known folder, `Frontier Developments/Elite Dangerous` |
| Files | 220 (`Journal.*.log`), 107.2 MB |
| Lines | 197,164 |
| Lines with no `event` field | 0 |
| Distinct event types | 197 |
| Range | 2026-06-07 to 2026-09-01 |
| Builds | 4.3.3.0 (r327343), 4.4.0.0 (r330116), 4.4.0.1 (r330377), 4.4.0.2 (r330465), 4.4.0.3 (r330683) |

Reproduce with `scripts/profile-journal.ps1` (see bottom).

## Locating the directory

Do **not** hardcode `C:\Users\...`. The correct source is the Windows *Saved Games*
known folder (`FOLDERID_SavedGames`), then `Frontier Developments/Elite Dangerous`.
The Rust layer resolves this via the shell known-folder API. A manual override is
always available in Settings, and the resolver reports which strategy succeeded.

The resolver never rejects, and it keeps *"we looked and it is not there"*
(`none`) apart from *"we could not look"* (`probe-failed`) — the existence check
is an IPC call into the native layer, which can fail for reasons that have
nothing to do with the path being asked about. Only the first case means **set a
path in Settings**; reporting the second as a missing folder would send someone
to fix a path that was never the problem. A failed probe surfaces as an error
rather than as "No journal folder".

## File format

- One JSON object per line, **CRLF**-terminated (verified on the 5 most recent files).
- Filenames: `Journal.<UTC timestamp>.<NN>.log`.
- Across the entire corpus the `NN` suffix was always `01` and `Fileheader.part` was
  always `1`. **No size-based continuation occurred in three months.** Continuation is
  still handled defensively.
- Largest single file observed: 3,354,705 bytes.

## Real edge cases present in the corpus

These are not hypothetical. Each has a regression test.

1. **Zero-byte journals.** `Journal.2026-07-28T190946.01.log` and
   `Journal.2026-07-28T191037.01.log` are 0 bytes. Selecting "the newest journal"
   naively lands on an empty file and the watcher stalls.
2. **Header-less files.** 220 files but only 218 `Fileheader` events, precisely
   because of the two empty files. Never assume line 1 is a header.
3. **A payload-less event.** Build 4.4.0.3 emitted literally
   `{ "timestamp":"2026-09-01T18:26:38Z", "event":"MarketID" }` — an event whose name
   collides with a field name used elsewhere, carrying no data at all.
4. **Duplicate timestamps.** Many events share a timestamp to the second, so
   timestamps cannot serve as event identity. Byte offset is used instead.

## Field presence — measured

Percentages are share of occurrences of that event carrying the field.
Anything below 100% is optional and is typed as such.

### Fileheader (n=218)
All of `timestamp, event, part, language, Odyssey, gameversion, build` at 100%.
This is the authoritative source for the build stamped onto every downstream event.

### LoadGame (n=278)
100%: `Commander, FID, Horizons, Odyssey, gameversion, build, language, GameMode,
Credits, Loan, Ship, timestamp, event`
Optional: `FuelCapacity 99.6%`, `ShipName 99.6%`, `FuelLevel 99.6%`,
`ShipIdent 99.6%`, `ShipID 99.6%`, `Ship_Localised 69.8%`, `Group 16.5%`,
`StartLanded 15.5%`

`Group` appears only in private-group sessions. Ship fields are absent when the load
occurs on foot.

### Docked (n=1798)
100%: `StationName, StationType, MarketID, StarSystem, SystemAddress, StationFaction,
StationGovernment(+_Localised), StationServices, StationEconomy(+_Localised),
StationEconomies, DistFromStarLS, LandingPads, Taxi, Multicrew, timestamp, event`
Optional: **`StationAllegiance 32.0%`**, `ActiveFine 4.3%`, `StationState 0.8%`,
`Wanted 0.4%`, `StationName_Localised 0.1%`

The 100% block is what Station Service Verification (§9) may rely on.
`StationAllegiance` at 32% must never generate a discrepancy.

### Undocked (n=1811)
100%: `MarketID, StationName, StationType, Taxi, Multicrew, timestamp, event`
Optional: `StationName_Localised 0.1%`

### FSDJump (n=3837)
100%: `StarSystem, SystemAddress, **StarPos**, Body, BodyID, BodyType, JumpDist,
FuelUsed, FuelLevel, Population, SystemAllegiance, SystemEconomy(+_Localised),
SystemSecondEconomy(+_Localised), SystemGovernment(+_Localised),
SystemSecurity(+_Localised), Taxi, Multicrew, timestamp, event`
Optional: `SystemFaction 51.6%`, `Factions 46.4%`, `Powers 33.3%`,
`PowerplayState 33.3%`, `ControllingPower 21.3%`, `PowerplayStateControlProgress
21.3%`, `PowerplayStateReinforcement 21.3%`, `PowerplayStateUndermining 21.3%`,
`PowerplayConflictProgress 12.0%`, `Conflicts 7.1%`, `ThargoidWar 0.1%`

`StarPos` at 100% is the basis for any distance calculation.

### Location (n=296)
100%: `StarSystem, SystemAddress, StarPos, Body, BodyID, BodyType, Docked,
Population, SystemAllegiance, SystemEconomy(+_Localised), SystemSecondEconomy
(+_Localised), SystemGovernment(+_Localised), SystemSecurity(+_Localised), timestamp,
event`
Optional: `DistFromStarLS 90.5%`, `SystemFaction 84.1%`, `Taxi/Multicrew 81.4%`,
`Factions 68.9%`, the whole station block `57.1%` (`StationName, StationType,
MarketID, StationServices, StationFaction, StationGovernment, StationEconomy,
StationEconomies`), `StationAllegiance 19.3%`, `Latitude/Longitude 14.2%`,
`InSRV 12.8%`, `OnFoot 5.7%`

The station block tracks `Docked == true`. `OnFoot`/`InSRV` appear only when true.

### ApproachSettlement (n=440)
100%: `Name, MarketID, SystemAddress, BodyID, BodyName, Latitude, Longitude,
StationFaction, StationGovernment(+_Localised), StationServices,
StationEconomy(+_Localised), StationEconomies, timestamp, event`
Optional: `StationAllegiance 48.0%`

A second verification channel: full `StationServices` without needing to dock.

### MissionAccepted (n=270)
100%: `MissionID, Name, LocalisedName, Faction, Influence, Reputation, Wing,
timestamp, event`
Optional: `Expiry 99.3%`, **`DestinationSystem 54.8%`**, `Reward 48.1%`,
**`DestinationStation 47.0%`**, `Donation 44.4%`, `TargetFaction 30.7%`,
`Commodity(+_Localised) 22.6%`, `Count 22.6%`, `TargetType(+_Localised) 20.0%`,
`Target 15.6%`, `KillCount 10.0%`, `Target_Localised 5.2%`,
`DestinationSettlement 4.8%`

**Roughly half of accepted missions carry no destination at all.** The planner shows
"no destination given" rather than inventing one.

### MissionCompleted (n=258)
100%: `MissionID, Name, LocalisedName, Faction, FactionEffects, timestamp, event`
Optional: `Reward 53.5%`, `DestinationSystem 53.5%`, `Donation/Donated 46.5%`,
`DestinationStation 45.7%`, `TargetFaction 29.8%`, `Commodity 21.7%`,
`TargetType 19.4%`, `Target 14.7%`, `KillCount 9.7%`, `MaterialsReward 7.8%`,
`DestinationSettlement 4.3%`

### MissionRedirected (n=67)
All nine fields at 100%: `MissionID, Name, LocalisedName, NewDestinationStation,
NewDestinationSystem, OldDestinationStation, OldDestinationSystem, timestamp, event`

### Missions (n=296)
100%: `Active, Complete, Failed, timestamp, event`. Emitted at session start — the
authoritative reconciliation snapshot for mission state.

### ColonisationConstructionDepot (n=5699)
100%: `MarketID, ConstructionProgress, ConstructionComplete, ConstructionFailed,
ResourcesRequired, timestamp, event`

Each emission is a **complete snapshot**; `ResourcesRequired[]` carries `Name`,
`Name_Localised`, `RequiredAmount`, `ProvidedAmount`, `Payment`. Delivery tracking
needs no inference. Commodity names use the `$aluminium_name;` form, which differs
from Market/EDDN naming — normalization required before Logistics.

### ColonisationContribution (n=371)
100%: `MarketID, Contributions, timestamp, event`

## Normalization hazards

- **`StationServices` casing is inconsistent.** A single real array:
  `["dock","autodock","commodities","contacts","missions","outfitting","rearm",
  "refuel","repair","engineer","missionsgenerated","flightcontroller",
  "stationoperations","powerplay","searchrescue","stationMenu","shop","livery",
  "socialspace","registeringcolonisation"]` — note `stationMenu` camelCased among
  lowercase peers. Compare case-insensitively; store the raw token as evidence.
- **`StationEconomies` proportions do not sum to 1.0.** Observed
  `0.90 + 0.10 + 0.05 + 0.05 = 1.10`. Do not renormalise.
- **`ScanOrganic.Body` is an integer BodyID**, not a body name.
- **No event states exobiology holdings.** `Backpack` carries Items / Components /
  Consumables / Data (Odyssey suit inventory) and `Materials` carries Raw /
  Manufactured / Encoded (engineering stock). Neither includes organic data, so what
  a commander is carrying has to be derived from `ScanOrganic` and
  `SellOrganicData`. A corpus test asserts neither event grows an organic section.
- **Only `ScanOrganic.ScanType == "Analyse"` completes a specimen.** Measured
  Log 63 / Sample 120 / Analyse 60 across 243 events. Counting all three would
  roughly quadruple an apparent holding.
- **`SellOrganicData.BioData` length is the only quantity reported** for a sale —
  observed lengths 1, 1, 7, 8, 28 across 5 sales, 100% present.
- **Whether death destroys unsold exobiology data is not determinable from the
  journal.** Across 18 `Died` events, no window between two deaths ever sold more
  than it scanned, which is consistent with both possibilities. Do not assume either.
- **`MaterialTrade.TraderType`** (`encoded` / `raw` / `manufactured`) is the *only*
  place the kind of a Material Trader appears. `StationServices` carries the bare
  token `materialtrader` and nothing else — measured over 141 docks.
- **`CarrierJumpRequest.DepartureTime` states the jump time outright** — 100% present
  across 136 requests, and accurate: the observed `CarrierJump` follows it by a median
  of **+58s** (range -60s to +63s, the spread being when the *commander* loaded into
  the new system, not when the carrier left). Countdowns are ~15 minutes
  (min 911s, median 948s, max 2641s).
- **Carrier jump events only ever concern your OWN carriers.** `CarrierStats` is
  written solely for carriers the commander commands, and all 136 jump requests belong
  to the three carriers it names. None of the **45 other commanders' carriers** docked
  at produced one. Ownership is therefore a fact from the journal, not a heuristic.
- **`CarrierJump` is written only when the commander is aboard** — 53 while docked at
  an owned carrier, zero otherwise, against 136 requests. **Roughly half of all jumps
  are never witnessed**, so completion must be taken from `CarrierLocation`
  (CarrierID / StarSystem / SystemAddress / BodyID, all 100%), which reports where the
  carrier is regardless.
- **A jump can be scheduled from anywhere.** Only 47.8% of requests were made while
  aboard; 34.6% came from open space and 17.6% from a station in another system.
- **The journal never warns that someone else's carrier is about to jump.** Carriers
  emit exactly 12 distinct `ReceiveText` messages, and the only jump-related one is
  *"Docking request denied, jump is imminent"* (n=1) — a refusal when approaching, not
  a warning to anyone already aboard. No non-`Carrier*` event carries `DepartureTime`.
- **The post-jump cooldown is not in the journal.** `CarrierStats` carries fuel, jump
  range, finance, crew and packs — no timer field — and `CarrierJumpTimer` is never
  emitted. A cooldown display would have to hardcode a game constant Frontier has
  already changed once.
- **Nothing distinguishes a Guardian tech broker from a Human one.** `techBroker` is
  the only token, and "broker" otherwise appears solely in unrelated
  `BrokerPercentage` fields on `PayFines` / `PayBounties` / `RedeemVoucher`.
- **`$`-wrapped localisation tokens** (`$economy_Colony;`, `$aluminium_name;`) appear
  alongside `_Localised` companions. Keep both.

## Event frequency (top of 197)

`FSSSignalDiscovered` 45,545 · `Music` 26,628 · `ReceiveText` 18,990 ·
`ShipLocker` 15,651 · `Scan` 7,886 · `ShipTargeted` 7,297 ·
`ColonisationConstructionDepot` 5,699 · `StartJump` 5,486 · `UnderAttack` 5,183 ·
`FSDTarget` 4,157 · `FSDJump` 3,837 · `Cargo` 3,509

High-frequency, low-value events (`Music`, `FSSSignalDiscovered`, `UnderAttack`,
`ReservoirReplenished`) are filtered before reaching the UI to satisfy §30.

## Reproducing

```powershell
pwsh scripts/profile-journal.ps1 -Events @('Docked','MissionAccepted')
```

Re-run after every game update; a build change is the expected trigger for
re-validating field presence.
