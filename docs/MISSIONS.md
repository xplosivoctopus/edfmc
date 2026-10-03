# Mission Planner

Tracks active missions, groups them by destination, expiry and type, and persists
them across restarts.

## What the journal will not tell you

Measured across the corpus (n=270 `MissionAccepted`):

| Field | Presence |
|---|---|
| `MissionID`, `Name`, `Faction`, `Influence`, `Reputation`, `Wing` | 100% |
| `Expiry` | 99.3% |
| **`DestinationSystem`** | **54.8%** |
| **`DestinationStation`** | **47.0%** |
| `Reward` | 48.1% |
| `Donation` | 44.4% |
| `TargetFaction` | 30.7% |
| `Commodity` / `Count` | 22.6% |
| `KillCount` | 10.0% |
| `DestinationSettlement` | 4.8% |

**Roughly half of accepted missions carry no destination at all.** Those are shown
in their own group headed "No destination given" rather than bucketed under a
placeholder, because "the game did not say where" is a different fact from
"somewhere unnamed".

**Massacre progress is not journalled.** Only accepted and completed transitions are
reliable, so no partial kill counter is shown — §8 anticipated this, and the corpus
confirms it. The accepted `KillCount` is displayed as a requirement, never as
progress.

## Delivery progress IS journalled, and is exact

The one exception, and worth being precise about because §8's "do not fake
incremental progress" is easy to over-apply. `CargoDepot` (n=45) carries real
numbers, all at 100% presence:

| Field | Meaning |
|---|---|
| `ItemsDelivered` | **Cumulative** total delivered so far |
| `TotalItemsToDeliver` | The requirement |
| `ItemsCollected` | Collected from a start market, for depot-sourced missions |
| `Count` | This delivery's amount |

Remaining is `TotalItemsToDeliver - ItemsDelivered`. That is measured, not inferred,
so showing "150 t left of 1386" is reporting what the game said rather than guessing.

Three details that would each produce wrong numbers:

- **`ItemsDelivered` is cumulative**, observed going 540 → 1512 across two events for
  one mission. Accumulating instead of assigning would report 2052 delivered against
  a 1512 requirement, and replaying a journal would inflate it without bound.
- **`Progress` is unusable.** It read `0.000000` on 43 of 45 occurrences, including
  while 540 of 1512 were delivered. Trusting it would report no progress at all.
- **UNKNOWN is not zero.** No `CargoDepot` event means either the mission is not a
  depot mission or nothing has been delivered yet — the display falls back to the
  accepted count rather than claiming "0 delivered".

Destination groups and the cargo summary count **remaining**, not the accepted total.
After handing in 1,236 of 1,386, the number the next run is planned around is 150;
showing 1,386 there would be actively misleading.

`MissionAccepted.Count` matched `TotalItemsToDeliver` in every case checked, so the
depot event also fills in a count for missions where acceptance did not report one.

Observed on `Mission_Collect*`, `Mission_Mining`, `Mission_Delivery_*` and
`Mission_DeliveryWing`. `UpdateType` was "Deliver" (43) or "Collect" (2).

## Four traps in the mission events

Each of these would produce silently wrong results, and each has a test.

### 1. The `Missions` snapshot uses different names

The same mission appears under three different names depending on the event:

| Event | Name |
|---|---|
| `MissionAccepted` | `Mission_Altruism` |
| `Missions` snapshot | `Mission_Altruism_name` |
| Colonisation entry | `$Mission_Colonisation_Initial_Name;` |

Joining on name would silently fail. **Everything joins on `MissionID` only.**
`missionTypeKey()` folds all three forms — plus Frontier's inconsistent casing
(`MISSION_Salvage_Illegal` beside `Mission_Courier`) — to one key, used for
categorising and never for joining.

### 2. `Missions.Expires` has ambiguous units

Normal missions report seconds remaining (85523, 42077). A colonisation entry
reported `1789699599`, which is only sensible as a Unix timestamp — as a duration it
would be 56 years.

Rather than guess per-mission which unit applies, **`Expires` is not used for expiry
at all.** `MissionAccepted.Expiry` (an ISO string, 99.3% present) is the sole source,
and the snapshot is used solely to reconcile *which* missions exist.

### 3. MissionID can exceed JavaScript's safe integer range

`MissionID` is u64. One real value in the corpus — `18446744073709551615` (2^64-1),
the colonisation pseudo-mission sentinel, seen 113 times — exceeds `Number.MAX_SAFE_INTEGER`
and loses precision the moment `JSON.parse` touches it.

That sentinel is excluded rather than tracked, and `Mission.idIsReliable` records the
distinction so an imprecise id can never be silently joined against a genuine one.
Real mission ids are around 1e9 and unaffected.

### 4. Cargo cannot be derived from mission category

`Mission_Altruism` and `Mission_AltruismCredits` are both donations, but the first is
"donate 32 units of Micro Controllers" — 32t of hold — and the second is credits.
An early implementation gated cargo on category and undercounted, because category is
itself an inference from a name.

**Cargo is decided by the data**: a mission requires cargo when it reports both a
`Commodity` and a `Count`. Category is used only to decide whether a *missing*
commodity is worth flagging, which surfaces as "(incomplete)" on a destination group
rather than a confident total that happens to be wrong.

## Mission explanations are editorial, not derived

Frontier's own mission titles assume the mechanic is already understood. "Source and
return 1,386 units of Bertrandite" never says that *you* buy the 1,386 tonnes — which
is precisely what a new commander needs to know before accepting it.

**The journal cannot tell us this.** `Mission_Collect_Industrial` (source it yourself)
and `Mission_Delivery_Boom` (cargo provided) both carry a `Commodity` and a `Count`
and nothing that separates them. The difference is game mechanics, which only a human
reference knows.

So `explanations.ts` is explicitly editorial content. It is bundled so the feature
works today, but structured like the context rules — versioned, keyed, replaceable —
so **EDFM should serve it**, and correct it, without a client release. This is
arguably wiki content that the Companion links to rather than restates; it sits in
the client for now only because EDFM has no missions page yet (see the content gaps
in [CONTEXT.md](CONTEXT.md)).

Rules for anything added there:

- describe only what the mission *requires*, never tactics or best routes;
- never state a mechanic that cannot be checked against the game;
- one or two sentences, because it renders beneath every mission;
- return null rather than filler — a vague line under every mission trains the eye
  to skip the ones worth reading.

Donations split on **data** rather than category: `Mission_Altruism` and
`Mission_AltruismCredits` are both `donation`, but one wants a commodity you have to
source and the other wants money. The presence of a `Commodity` decides which
explanation appears.

These lines are labelled **EDFM note** in the UI. Everything else on a mission row
was read out of the journal; this was not. Marking it keeps the provenance visible
rather than letting editorial guidance blend into reported fact — the same instinct
behind showing Unknown instead of a plausible default.

A separate `missionCaveat()` carries statements about *the Companion's* limits rather
than the mission's requirements — currently that Elite does not journal kill progress.
It is deliberately **not** labelled "EDFM note": it is not EDFM's guidance, it is our
own admission of a gap. Keeping the two apart matters: one is about the game, the
other is about us.

## "Completed" in the overlay means handed in is all that is left

A mission row reads **Completed** once the work is done but the reward is not yet
collected. Two signals say so, and both are reported by the game rather than
inferred:

1. **`MissionRedirected` has fired.** The game moves a mission's destination when
   its objective is met and it wants you to return — a massacre's kills reached,
   a scan taken. That is the game saying "done, come back".
2. **Every item has been delivered.** `CargoDepot` reports `ItemsDelivered`
   against `TotalItemsToDeliver`, so a depot mission is finished when the first
   reaches the second. Redirection does not fire for these.

**Nothing else is inferred.** A kill mission with no redirection yet is not
"probably nearly done": counting `Bounty` events against a target would be a
guess, and the overlay would tell a commander their work was finished when it was
not. Anything these two cannot establish stays simply active, which is the honest
answer and the common case.

Two mistakes that are easy to make here, and are tested against:

- **Both delivery figures unknown must not satisfy it.** A naive
  `delivered >= total` is true when neither is known, which would mark every
  courier mission done the moment it was accepted.
- **A handed-in mission must not read Completed.** `MissionCompleted` means the
  reward was collected: the mission leaves `active()` and disappears from the
  widget entirely. "Completed" is only ever shown for one that is still
  outstanding — which is also why the row is not dimmed. The reward is not paid
  until it is turned in, and fading it would read as "dealt with", which is
  exactly the mission that then gets forgotten.

The colour is green rather than the amber used for an expiry running out, because
those are opposites: amber is a deadline closing in, green is work already banked.

## Reconciliation, and the `ended-unknown` status

`Missions` is emitted at session start and is the authoritative list of what is
actually active. It is the only way to notice missions that ended while the
application was closed.

When a tracked mission is absent from all three snapshot lists, it gets the status
**`ended-unknown`**. It ended — completed, failed, abandoned or expired — and the
journal does not say which. Recording it as "completed" would invent an outcome and
inflate the commander's record, which matters once Phase 5 starts reporting
contribution history.

## Not yet built: recommended next destination

§8 permits a routing feature only when reliable coordinate and distance data exists.
`FSDJump.StarPos` is present at 100%, but only for systems the commander has
*visited* — a mission destination is frequently somewhere they have never been, and
its coordinates are simply not in the journal.

Routing therefore waits for the backend's system coordinate data. Claiming an
"optimised route" over destinations whose positions are unknown would be exactly the
kind of confident-but-baseless output this project exists to avoid.

## Passenger missions

Passenger fields (`PassengerCount`, `PassengerType`, `PassengerVIPs`,
`PassengerWanted`) were **not observed anywhere in the corpus**. They are parsed
defensively because Frontier documents them, but nothing asserts they behave as
expected — they read UNKNOWN until a real sample proves otherwise.
