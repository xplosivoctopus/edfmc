# Context Assistant

Surfaces EDFM material relevant to what the commander is doing, matched from journal
events by fixed rules.

## Determinism is a requirement, not a style choice

§6 forbids using a model to guess what the commander is doing, and the design takes
that literally. A context appears only when a rule's conditions are *literally*
satisfied by a journal event or by current state. There is no scoring, no inference,
no "probably mining". If the rule matches, the context shows; if it does not, nothing
shows.

This also makes the whole thing testable: the same event always produces the same
contexts.

## Rules are untrusted input

Rules are server-driven and versioned so EDFM's recommendations can change without
shipping a new desktop build. That means they arrive over the network, and the client
cannot audit what it is sent. Two design consequences:

- **Conditions are declarative.** There is no expression string, no `eval`, no
  function body — only a fixed set of comparisons combined with `all`/`any`/`not`. A
  compromised or buggy rule feed cannot execute code in the client.
- **There is deliberately no regex operator.** A server-supplied regular expression is
  a denial-of-service vector (catastrophic backtracking) against an application whose
  entire point is running quietly beside a game. `contains`, `startsWith` and
  `endsWith` cover the real matching needs.

Further guards, all tested:

- Dotted paths refuse `__proto__`, `constructor` and `prototype`.
- Condition recursion is depth-bounded.
- Rule count, resource count and string lengths are clamped on ingest.
- Duplicate rule ids are rejected — they would make expiry ambiguous.
- A missing or absurd TTL is clamped, so a context cannot pin itself on screen.
- Resource URLs must be `http(s)`. A rule set must not be able to hand the shell a
  `file:` or custom-scheme URL to open.
- An unrecognised condition kind (from a newer server) never matches and never throws.

## Condition kinds

| Kind | Matches against |
|---|---|
| `event` | The triggering event's raw name, or a list of names |
| `field` | A dotted path into the raw journal payload |
| `state` | A dotted path into current commander state |
| `service` | A normalized station-service id present in state |
| `all` / `any` / `not` | Composition |

`service` exists as its own kind rather than a `state` path because service tokens are
the most common trigger, and because matching **must** be case-folded: Frontier's raw
`StationServices` array genuinely mixes cases (`stationMenu` and `techBroker` sit
among 38 otherwise-lowercase tokens across the corpus).

## Priority and decay

§6 asks that the commander not be shown ten links at once.

- Each rule carries a **priority**; the resolver ranks by it and surfaces only the top
  few (3 in the main window, **1** in the overlay, where space over a game is scarce).
- Each rule carries a **TTL**. Without decay, a context triggered once would linger
  for the whole session. Re-matching refreshes expiry but is not treated as a change,
  so it does not force a re-render.
- Ties break on recency, because two rules of equal priority are best ordered by what
  the commander just did.

## The bundled rule set is verified twice

`packages/context/src/defaults.ts` is version 1, and doubles as the offline fallback
(§22). Everything in it was checked against reality, not assumed:

1. **Every linked page exists.** Titles were checked against a live MediaWiki
   `list=allpages` listing of EDFM (2026-09-01, ~280 pages). A rule pointing at a
   non-existent page produces a broken link that *looks* authoritative — worse than
   showing nothing. A test asserts this.
2. **Every trigger occurs in real journals.** Each event named was counted in the
   197,164-line corpus, and each service token was observed in real `StationServices`
   arrays. A rule keyed on an event the game never emits is dead weight that looks
   functional. A test asserts this too.

Rules store page *titles*, not URLs, so a change of domain or article path is a
one-line change rather than an edit to every rule.

## Station service tokens do not mean what their names suggest

A rule keyed on the `engineer` service token shipped briefly and was wrong: it
announced "At an Engineer" while the commander was docked at their own Fleet Carrier.

Measured across the corpus (242 distinct stations docked at):

| Token | Distinct stations | Verdict |
|---|---|---|
| `engineer` | **227 / 242 (93.8%)**, including all 17 Fleet Carriers | Rejected — says nothing |
| `outfitting` | 167 / 266 (62.8%) | Rejected — fires at two-thirds of stations |
| `shipyard` | 148 / 266 (55.6%) | Not used |
| `vistagenomics` | 137 / 266 (51.5%) | Used, **but gated** — see below |
| `tuning` | 103 / 266 (38.7%), incl. Lave and Hutton Orbital | Rejected — meaning unverified |
| `pioneersupplies` | 101 / 266 (38.0%) | Used |
| `carriermanagement` | 44 / 266 (16.5%) | Used |
| `materialtrader` | 37 / 266 (13.9%) | Used |

### A service token can name a family without naming the variant

`materialtrader` is present or absent reliably, but it never says **which** of the
three traders a station has. Measured over 141 docks at trader stations: no field in
any event names the type, and the token itself is always the bare string.

`MaterialTrade.TraderType` does name it (`encoded` / `raw` / `manufactured`), so the
kind is learned from the commander having traded there and remembered per MarketID —
the same treatment as a fleet carrier name, and for the same reason: the trade that
revealed it may have been months ago.

Inferring it from station economy instead was measured and **rejected**:

| Primary economy | Trader kinds actually observed |
|---|---|
| High Tech | `encoded` ×7, **`raw` ×1** |
| Industrial | `manufactured` ×10, **`raw` ×2** |
| Extraction | `raw` ×4, `encoded` ×1, `manufactured` ×1 |
| Refinery | `raw` ×2 |
| Agriculture | `encoded` ×1 |

The widely-repeated economy-to-type mapping is therefore wrong often enough to name
the wrong trader. Stability was checked too, since remembering the answer depends on
it: across 29 stations with observed trades, **none ever reported a second kind**.

Hence four rules rather than one — three that name a kind, and one that fires only
while the kind is genuinely unestablished and says so. A corpus test asserts both
measured claims, so a game update that changes either fails the suite.

**`techBroker` has the same shape but no solution.** Nothing in the journal
distinguishes a Guardian broker from a Human one — "broker" appears only as the bare
token and in unrelated `BrokerPercentage` fields. That variant cannot be answered from
the commander's own journal at all, and would need reference data.

### Presence of a service is not a reason to mention it

`vistagenomics` is at 155 of 295 stations, carriers included, so the rule fired at
over half of all docks and told commanders to sell exobiology data they were not
carrying. Prevalence made it noise.

Gating it needs a holdings figure **the journal never states** — see `docs/JOURNAL.md`
— so `exobiologyToSell` accumulates completed `Analyse` scans and subtracts what sales
report. Three properties make that safe to act on:

- **It is a lower bound, not a total.** Zero means "nothing confirmed", not "you are
  carrying nothing". The rule's silence is the absence of a claim.
- **Only `Analyse` counts.** Log and Sample are progress toward one specimen — 183 of
  243 scans — so counting them would inflate a holding roughly fourfold.
- **A death resets it, and that is a choice about which error to make, not a claim
  about the mechanic.** Whether death destroys unsold data could not be established
  from 18 deaths in the corpus. Resetting risks withholding a reminder; not resetting
  risks sending someone across the bubble to sell data they no longer have.

The count is also recovered from recent journals at startup, or it would be zero every
launch and the gate would simply replace one unhelpful behaviour with another. That
walk is bounded: only events since the most recent sale or death matter, so it stops
at the first one it finds, and an undercount is the correct direction for a lower bound.

**Prevalence is the bar a service rule has to clear.** A token present at most
stations cannot be telling the commander anything specific, however suggestive its
name is.

Engineering is therefore triggered by **activity** rather than by a station service.

That needed a second correction. Keying on the `EngineerProgress` event *name* was
also wrong: **277 of its 338 occurrences carry an `Engineers` array** — a full
progress summary emitted at startup and periodically through a session, regardless of
what the commander is doing. Only the 61 occurrences *without* that array describe a
real change. The rule now requires `EngineerCraft`, `EngineerContribution`, or an
`EngineerProgress` that has no `Engineers` array.

The same trap is worth checking for on any event that has both a summary and a
delta form — `Missions`, `Powerplay` and `Cargo` are all shaped this way.

**No service token reliably identifies an Engineer base.** Recognising one requires a
station-identity list — reference data that belongs server-side, since EDFM already
holds it. Until then the Companion says nothing rather than guessing.

The general lesson, and the reason this is recorded rather than quietly fixed: a
service token's *name* is not evidence of its meaning. Before a rule depends on one,
count how many distinct stations report it. A token present at 94% of stations cannot
be telling you anything specific.

## Content gaps found while building this

Several contexts named in the original brief have **no corresponding EDFM page**, so
no rule was written for them. These are content gaps, not code gaps — the rule engine
supports them the moment the pages exist, and because rules are server-driven, adding
them needs no client release:

| Wanted context | Status |
|---|---|
| Odyssey settlement guide | No settlement page found |
| Crime / security guide | No page found |
| Odyssey material guide | Only `Engineering Materials` exists, which is ship-side |
| Mission-type guides | No missions page found |
| Tech Broker | No page, though `techBroker` appears in 52 station observations — and the journal never says whether it is Guardian or Human |
| Black market | No page, though `blackmarket` appears in 475 |
| Apex Interstellar / Frontline Solutions / Bartender | No pages |

`vistagenomics` (872 observations) and `materialtrader` (131) *do* have usable targets
and are wired up. The trader rules deep-link
`Engineering Materials#Material Traders` rather than the top of the page, since one
page covers all three kinds; page *and* section existence are both asserted by test.

## An event name is not a description of when it fires

Twice now a rule has been keyed on an event whose name reads like one situation
while the game fires it for a superset.

| Event | Sounds like | Actually fires for |
|---|---|---|
| `ApproachSettlement` | arriving at a settlement | settlements **and Guardian ruins** |
| `SAASignalsFound` | ring hotspot scan | **every** detailed surface scan |

`SAASignalsFound` was the worse of the two: 198 events in the corpus, of which only
**29 are rings**. The rule was wrong 85% of the time, and the overlay announced
"Ring scanned — hotspot signals found" after a DSS of a planet.

`BodyName` ending in `Ring` separates them exactly — 29 of 29, no false positives.
A structural test on the payload looked more principled and is in fact worse: ring
signals are bare commodity names (`Serendibite`) while planet signals are
`$SAA_SignalType_*;` tokens, but planets with surface mining sites report
`$PlanetaryMiningLocation_Name;`, which that test misclassified 11 times.

The lesson is the same one the `engineer` service token taught: **count how often the
trigger fires for something other than the situation you mean.** Unit tests cannot
find this, because a fixture is chosen by the person who already believes the rule is
right. `packages/context/test/corpus.test.ts` now replays the real journals through
the bundled rules and asserts the ring rule matches rings and nothing else.

### What a planet scan is worth saying instead

Gating the ring rule left a planet DSS saying nothing, which is correct but not
useful — those 169 events carry real information:

| Signal | Events | Rule |
|---|---|---|
| `$SAA_SignalType_Biological;` | 103 | `planet-biological-signals` |
| `$PlanetaryMiningLocation_Name;` | 104 | `planet-surface-mining` |

They are independent — a body can have both, and 89 of these events carry two or more
signals — so they are two rules that can fire together rather than one combined one.

The biological rule keys on `Genuses`, not on the signal, because the two are exactly
equivalent in the corpus (103 events with the signal, all 103 with genera, none with
genera and no signal) and the genus list is the thing that makes a body worth landing
on.

The mining rule needed a capability the engine did not have: that signal sits at index
0, 1 or 2, so `Signals.0.Type` would have found 18% of them. `field` paths now accept
`*` for "any element", bounded to two stars and 64 gathered values because rule sets
arrive from a server and from plugins.

## A context has to be able to end

The commander knows what they just did. What deserves the screen is what is true
**now** — so the hard part is not ranking a finished activity lower, it is noticing
that it finished at all.

Originally a TTL was the only thing that could end a context, and TTL was being used
as "how long to keep talking about it". `engineering-activity` had fifteen minutes of
it, so it followed a commander out of the Engineer's station, through supercruise and
across three jumps, and sat on the overlay at a station that has no Engineer —
covering up the Material Trader that was actually there.

`endsOn` fixes the cause: a rule lists the journal events that end it outright,
whatever the TTL says.

| Rule | TTL | Ends on |
|---|---|---|
| `interdicted` | 180s | `EscapeInterdiction`, `SupercruiseEntry`, `Docked`, `FSDJump`, `Died` |
| `engineering-activity` | 300s | `Undocked`, `Liftoff`, `FSDJump`, `SupercruiseEntry` |
| `exobiology-scan` | 600s | `Liftoff`, `FSDJump`, `Docked`, `SellOrganicData` |
| `mining-*` | 600s | `Docked`, `FSDJump`, `SupercruiseEntry` |
| `colonisation-depot` | 900s | `Undocked`, `FSDJump`, `SupercruiseEntry` |
| `powerplay-activity` | 600s | `FSDJump` |

TTL is now the fallback for when nothing announces the end, and every activity TTL
came down accordingly.

Two things this deliberately does **not** do. Station rules get no `endsOn` at all —
they are state-scoped, held open by their condition, and where the commander *is* has
no business being ended by an event. And `endsOn` is not a blunt list of "any movement
event": trading materials at an Engineer is part of engineering, so `MaterialTrade`
stays out of its list.

Every event name was checked against the corpus before being used. `AsteroidCracked`,
a plausible-looking candidate for the mining rules, is emitted **zero** times and would
have been dead config.

## Relevance decays for what happened; it does not for where you are

The two kinds of rule make different claims, and one static priority number cannot
carry both:

- **Event-scoped** rules describe something that *happened*. "Recent engineering
  activity" is by definition in the past and is worth saying less with every minute.
- **State-scoped** rules describe where the commander *is*. They are held open by
  their condition rather than a clock, and being docked at a Material Trader is
  exactly as true after twenty minutes as it was on arrival.

So an event-scoped context's priority decays linearly across its own TTL, and a
state-scoped one does not decay at all. A rule therefore declares how long its
subject stays interesting by choosing its TTL.

This was a real defect, not a refinement. `engineering-activity` (priority 75, TTL
900s) outranked a Material Trader (58) for a full fifteen minutes after the commander
had flown to another system and docked — and because **the overlay renders only the
top-ranked context**, the trader was not merely below it, it was invisible. The
overlay read "Engineering" at a station that has no Engineer.

Actively doing the thing still keeps it on top: each new `EngineerCraft` refreshes
`matchedAt` and restores full priority, so someone mid-session at an Engineer is
unaffected.

Decay alone was not enough, and it is worth being clear why. It changed *which*
context won while still assuming a finished activity deserved screen space for as
long as its TTL allowed. It is the right mechanism for the genuinely ambiguous middle
— someone who stopped engineering but has not left yet — and the wrong one for an
activity that is simply over. `endsOn` handles that case, and decay handles the rest.

## Overlay integration

The overlay receives only the single highest-ranked context, and its links are
rendered as **labels, not clickable links**. That is deliberate: the overlay is
click-through during normal play, so a link there could never be followed — showing
one would promise an interaction that cannot happen. The main window's Context page is
where resources actually open, in the user's browser.

## Provenance

Each active context records the event that triggered it and that event's id, shown on
the Context page (§27). When a context looks wrong, the first question — "what made
this appear?" — is answerable without guessing.
