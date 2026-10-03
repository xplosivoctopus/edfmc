# The Activity Journal

Elite already writes a machine journal. This is the other one: a record of what
the commander *did*, in language they would use themselves.

Measured against the real corpus: **288,616 journal events across 299 files
produce 463 activity entries** — a reduction of about 623:1. That ratio is the
feature. A history that reproduces the journal has not interpreted anything.

Everything here is local by default, and no files are written during normal
operation. It leaves the machine in exactly one circumstance: you connect
**EDFM Commander Journal** and entries go to your own EDFM account. That is off
until you turn it on, and it is the only path out — see
[JOURNAL-SYNC.md](JOURNAL-SYNC.md).

---

## Two different things, deliberately kept apart

| | Activity Journal | Live activity state |
|---|---|---|
| **What it is** | A historical record | Current operational progress |
| **Lifetime** | Durable, stored in SQLite | Durable, stored separately as *state* |
| **Granularity** | One entry per thing accomplished | Every step, while it is happening |
| **Answers** | "What did I do?" | "What am I in the middle of?" |
| **Lives in** | `packages/activity/src/exobiology.ts` | `packages/activity/src/live.ts` |

The distinction is the whole design. Writing progress into history would turn the
Journal into a stage-by-stage event list, which is what it exists not to be; and
having only history meant the overlay could show nothing but the last completed
thing, which largely restated Current Context.

**Live state never becomes an entry.** It is persisted, but as *current state*
rather than as events: one row per genus per body in `exobiology_progress`,
overwritten as it changes. A body with four genera has four rows however many
samples were taken.

That distinction is the whole point. Leaving the planet, leaving the system or
closing the app must not lose a half-finished specimen — a commander called
away mid-run should come back and see exactly where they stopped instead of
guessing — but writing each sample into the Journal would turn history into the
stage-by-stage list it exists not to be.

---

## What it records today

| Subtype | Entries in the corpus | From |
|---|---|---|
| `signals-detected` | 107 | `SAASignalsFound` carrying genera |
| `sample-completed` | 68 | `ScanOrganic` with `ScanType: Analyse` |
| `data-sold` | 5 | `SellOrganicData` |
| `mission-completed` | not yet measured | `MissionCompleted` |

The counts above are from the 299-file snapshot named at the top of this document.
The sequence measurements below were taken later, against 303 files and 323
`ScanOrganic` events, so the two do not line up exactly; each states its own
corpus rather than being quietly reconciled.

`Log` and `Sample` scans produce nothing. They are progress toward one specimen,
and an entry each would bury the completion in its own noise. Live progress is
shown in the overlay instead — see **The measured sample sequence** below.

Measured on the later snapshot: this suppresses **243 of 323 `ScanOrganic`
events**, leaving 80 completions.

---

## Findings that changed the design

### The measured sample sequence is four events, not three

The obvious reading of the event names is wrong, and building on it would have
reported every specimen finished one sample early.

Measured across the corpus (303 files, 289,725 events, 323 `ScanOrganic`):

```
Log  ->  Sample  ->  Sample  ->  Analyse      80 of 83 runs
Log                                            3 of 83 runs (abandoned)
```

`Sample` occurs **twice**, so a stage number cannot be derived from `ScanType`
alone: the same value means "2 of 3" the first time and "3 of 3" the second.
Counting is the only correct way to do it.

`Analyse` is **not** the third sample. It is the completion event that follows it,
and it was directly preceded by a `Sample` of the same species in 80 of 80 cases.
Every one of the 24 completed species took exactly three samples.

`WasLogged` is present on all 323 scans and was `false` on every one. A field with
no observed variation carries no information, so nothing reads it.

### Almost nothing resets a sample run

This is the finding that most contradicts intuition. Measuring what appears
*between* the stages of a single organism shows that ordinary sampling is full of
events that look like interruptions:

| Between stages of one organism | Runs |
|---|---|
| `Touchdown`, `Liftoff` | 74, 68 |
| `Embark`, `Disembark` | most |
| `SuitLoadout`, `Music`, `BackpackChange`, `DockSRV` | most |
| `Fileheader`, `LoadGame`, `Location`, `Shutdown` | 4 |

Commanders fly between plants: land, get out, sample, board, take off, land again.
That *is* the activity. Resetting on boarding the ship, changing suit or landing
would break the feature for nearly every real run. Even a **game restart** appears
mid-run four times, so quitting to the menu does not abandon a sample.

`FSDJump` never once appears between the stages of a run (0 of 83), which is what
makes leaving the system a signal rather than a guess.

Time is not a signal either: the longest gap between two stages of one organism was
**50,313 seconds** — about fourteen hours — so nothing expires on a timer.

**So the reset rules are:**

| Signal | Effect | Evidence |
|---|---|---|
| `ScanOrganic` for a different system/body/species | Replaces the run | The 3 abandoned runs were each followed by a different species' `Log` |
| `Analyse` | Completes it | 80 of 80 |
| Leaving the body or system | **Stops displaying it; nothing is lost** | Progress is stored, so returning restores it |
| `SellOrganicData` | Retires a *completed* specimen | The data has left the ship |
| Commander change | Clears it | Architectural: progress belongs to whoever took it |
| Starting a different genus | Returns the previous *partial* row to unscanned | 80 of 80 completed runs were contiguous |
| Commander change | Clears the display | Progress is stored per commander |

### One specimen at a time

Starting a different genus returns the previous *partial* row to unscanned.

The evidence: of the 80 completed runs, **every one was contiguous** — no run
ever resumed after another species intervened — and the only 3 interrupted runs
never completed. If partial progress survived switching organisms, at least one
resumed run would be expected among 80.

Completed specimens are never reset. `Analyse` banked them.

### The genus roster: what is still down there

A detailed surface scan reports which genera a body carries, so the overlay can
say what has **not** been collected rather than only what has. That this works is
a measurement:

| | Result |
|---|---|
| `SAASignalsFound.Genuses[].Genus` vs `ScanOrganic.Genus` | Same tokens; 11 of 11 sampled genera were listed |
| Genera sampled that the body's scan never listed | **0** |
| `SAASignalsFound.BodyID` vs `ScanOrganic.Body` | Matched on all 54 sampled bodies |
| Biological signal count vs genera listed | Equal, 119 of 119 |
| Bodies scanned more than once | 17 of 60 — a repeat scan merges |

Of 60 bodies with a genus list: **47 finished, 6 partially worked, 7 untouched.**
"Unscanned" is an ordinary state, not an edge case.

Matching is on the **raw token**, not the localised name. The two agreed on every
genus measured, but the token is language-independent and the localised string is
a display concern.

The scan gives a genus and **not** a species, so an unsampled row says `Bacterium`
and does not guess which bacterium.

**A body with no surface scan has an empty roster**, and that is not a claim that
nothing is there. It is the difference between "the scan listed these" and "we
have not looked". The widget shows nothing at all in that case rather than an
empty panel.

One species per genus per body (90 of 90) and one variant per species (90 of 90),
so a row is keyed by genus and its species and variant columns stay null until
sampled.

### Base values come from the wiki, and were checked against the game

The overlay shows a species' **base Vista Genomics value** and **minimum sampling
distance** once it has been sampled, transcribed from the EDFM organism index at
`https://edfieldmanual.com/wiki/Exobiology` into `packages/activity/src/species.ts`.

Verified against the corpus before being shown, because a confidently wrong
number is worse than none:

- All **26** species the journal has ever reported appear in the table, so
  `Species_Localised` is the right key and the names match exactly.
- For the **14** species actually sold, the table's value equals the
  `SellOrganicData.Value` the game paid — 14 of 14, no mismatches.

**Base value excludes the first-to-log bonus**, which Frontier does not document
as a formula, so the figure is a floor rather than a prediction.

**Nothing is shown on an unscanned row.** A surface scan reports a genus, and a
genus spans species worth very different amounts — Bacterium alone runs from
1,000,000 to 8,418,000 Cr. A figure there would be a guess with a number
attached.

### What the journal does not establish

**Whether leaving discards progress.** An earlier version cleared a run on
`FSDJump`, which was a guess: `FSDJump` never appears between the stages of a run
in the corpus, so there was no evidence either way about what the game does.
Persisting is the behaviour that loses nothing regardless of the answer, so the
display simply follows the body the commander is at and the stored rows outlive
it. `Died` is likewise no longer treated as a reset — 18 deaths, exactly one near
a run, is not enough to discard a commander's work on.

**Which genera an earlier session already collected.** The tracker only sees this
session's events, so a specimen collected last week would be reported "unscanned"
— a confident wrong answer, and the one failure that would make the whole panel
untrustworthy. Completions are therefore seeded from the durable Journal before
the roster is built. Older entries stored only the localised genus name, so the
seed matches on either that or the raw token.

**The stage count after an app restart.** The journal reader resumes from a byte
offset rather than replaying history, so starting the app midway through a run
means the first event it sees is a `Sample` that could be the second or the third.
Both are consistent with what was observed.

So **no number is claimed**: `samplesTaken` is `null` and the overlay omits the
stage line, showing "Sampling" and the organism instead. A wrong "1 / 3" would tell
the commander two samples remain when one does. `Analyse` recovers a definite count,
because it is itself proof of three.

These are the reason the feature looks the way it does. Each was measured before
anything was written.

### Landings and footfalls are not recorded

Every planetary `Touchdown` used to become an entry — 283 of them, and 335 in
the current snapshot. That was wrong in both directions: a landing is parking,
not a milestone, and the volume buried the things that are.

That was replaced for a while by a footfall entry: a `Disembark` onto a world
whose last `Scan` reported `WasFootfalled: false`. It is removed at the
commander's request. The journal could not back the claim cleanly either:
`WasFootfalled` describes the body when it was **scanned**, and against the
game's own cumulative `Statistics.Exploration.First_Footfalls` counter the
inference produced 98 candidates where the counter moved by 78.

Footfall rows written before the removal stay in the database untouched. They
are not shown in the Activity Journal and are not sent by journal sync.

### Missions record the hand-in, not the acceptance

A mission produces **one** entry, on `MissionCompleted` — the moment it is handed
in and paid.

Accepting is not recorded. Taking a mission is an intention, and a journal of
intentions is the parking-event problem the 463 removed `Touchdown` entries
already taught. Failure and abandonment are not recorded either, for the same
reason in reverse: they are things that did not happen. The mission store tracks
all four outcomes for the live view; only one of them is history worth keeping.

**The reward is the one the game paid**, from `MissionCompleted.Reward`, not the
figure offered at acceptance — bonuses, faction effects and partial completions
move it, and what belongs in a record is what actually landed in the balance.

**Nothing in this entry is assumed to be present.** `MissionCompleted` carries
most of its fields conditionally: a donation mission has no `Reward` at all, a
courier run has no `MaterialsReward`. Only `MissionID` and `Name` are required,
and every other field is simply absent from `data` when the game did not send it.
An absent reward is absent, never zero — "this paid nothing" and "the game did not
say" are different claims, which is the rule the whole journal is built on.

Unlike the exobiology rules above, **these presence rates are not yet measured**.
They are stated as unmeasured rather than guessed; `test/corpus.test.ts` is where
they get established on a machine with real journals. Treating every field as
optional is the behaviour that is correct either way.

The colonisation pseudo-mission is refused. Construction contributions arrive as
`MissionCompleted` with the sentinel id 2^64-1 — 113 of them in the corpus — and
letting it through would put a phantom mission in the history every time a depot
was fed. It is rejected by testing `Number.isSafeInteger`, not the literal:
Frontier's `MissionID` is a u64, JavaScript loses precision above 2^53, and *any*
id that arrives rounded is one that cannot be matched back to its mission.

**These entries do not sync to EDFM yet**, and that is a server limitation rather
than a choice here. The journal extension allowlists four categories and
`missions` is the fifth, so it would answer `unsupported_category`. They are
recorded and shown locally, and `SYNCABLE_SUBTYPES` is the single line that
changes the day the wiki accepts them. See [JOURNAL-SYNC.md](JOURNAL-SYNC.md).

### First discovery is not claimed, and the reason is the data

`SellOrganicData.BioData` carries a per-species `Bonus`, which looks like the
first-discovery bonus and is tempting to treat as confirmation.

**Across all 45 sold entries in the corpus, `Bonus` was exactly 4× `Value`. There
is no counter-example.** With no case of `Bonus: 0`, the corpus cannot distinguish
"bonus means first discovery" from "bonus is always paid". The value is recorded;
no claim is made. A test asserts no entry contains the word "first".

Exploration sales are different — `MultiSellExplorationData.Bonus` *does* vary (48
zero, 3 non-zero), so it is informative. But it is aggregate per sale, not per
body, so it still cannot attribute a discovery to a specific body. Not modelled.

If a later game version distinguishes these, the evidence is a single field and
the lifecycle can be added without a schema change.

### EDFM has no species pages

The obvious link is `Stratum Tectonicas` → `/wiki/Stratum_Tectonicas`. Checked
against the live wiki: **all 25 species and 11 genera in the corpus are absent.**
Only `Exobiology` exists.

So the obvious design ships 25 authoritative-looking 404s. Links resolve through
`VERIFIED_EDFM_PAGES` and fall back to a page that exists. Entries store the
organism, never a URL, so when EDFM gains species pages one list changes and every
historical entry starts linking correctly.

### No external galaxy-database links by default

EDSM, Inara and Spansh are all plausible. None of their deep-link formats was
verified here, and shipping an unverified template is the broken-link problem
again. `ExternalLinkProvider` is a template with no default, so choosing one later
changes configuration rather than stored data. The journal is fully useful
offline.

---

## Identity, and why replay cannot duplicate

An entry's id **is** the journal event id that produced it — `sourceFile:byteOffset`,
which the engine already guarantees is stable across restarts and replay. It was
chosen for exactly this property: timestamps repeat within a second, and content
hashing would make two identical scans collide.

So persistence is `INSERT OR IGNORE`. Re-reading a file re-derives the same ids and
the write is dropped. **Deduplication is a property of the primary key, not a
procedure that can be got wrong.** Verified by rebuilding the corpus twice and
comparing every id, and by checking all 463 are unique.

---

## Architecture

`packages/activity` holds the model and the processors, which are pure functions
from a journal event to zero or more entries. No database, no React, no Companion
— which is what lets them be tested against the real corpus directly.

The engine keeps exactly one piece of state: **BodyID → name**. `ScanOrganic`
reports `Body` as an integer, so an entry that names its body must resolve it from
something that carried both — `Scan`, `SAASignalsFound` or `Touchdown`. Resolved at
write time so the entry is self-contained. On real data this works: **68 of 68
completed samples resolved a body name.** The map is cleared on leaving a system,
because a BodyID is only unique within one, and on a commander change.

Migration 10 adds `activity_entries`, plus `activity_sessions` and
`activity_notes` — created empty on purpose. An automatic session boundary is a
guess about intent and will not be presented as fact until there is a rule worth
defending, but adding the tables later would be a migration against data users
already have.

Entries are scoped by commander FID and swapped with the discovery state, so two
commanders on one machine never see each other's history.

---

## Privacy

Activity is travel history, play times and locations. It is not written to files,
and it reaches no community database: EDDN, EDSM and Inara receive observations
about the galaxy, and a record of what *you* did is not one of those.

It goes to **your own EDFM account** if — and only if — you connect EDFM
Commander Journal, which ships off. New activity then uploads automatically, and
your existing activity only when you explicitly ask for it. Nothing else here
leaves the machine. [JOURNAL-SYNC.md](JOURNAL-SYNC.md) is the full account.

Logs record counts and categories only:

```ts
logger.info('activity', 'Recorded activity', { count, categories });
```

Never titles — those carry system names, body names and organism discoveries.

---

## The Live Journal overlay widget

The Journal screen is the history. The overlay widget answers a different
question, and which one depends on what is happening:

- **At a surface-scanned body** — every genus it carries, with where the commander
  got to on each: `3 / 3`, `2 / 3`, or `Unscanned`. Titled **Exobiology**.
- **Otherwise** — the newest recorded entry plus how many were recorded at the same
  body. Titled **Field Journal**, and it collapses to a count after five minutes.

Live progress always wins. That precedence is a function, `liveJournalPanel`, and
not a condition buried in markup, because it is the decision the widget's
usefulness depends on: showing "2 biological signals detected" while a sample run
is open repeats Current Context and wastes the space.

`docs/OVERLAY.md` has the lifecycle and why that shape was chosen.

## Deferred, explicitly

- **Sessions.** Schema exists; no automatic grouping, because a boundary rule that
  is a guess should not look authoritative.
- **Notes.** Schema exists; no editing UI.
- **Search and export.** The indexes to support them are in migration 10.
- **Screenshots.** `Screenshot` occurs once in the corpus — too little to design
  against. It carries `Filename`, `System` and `Body`, so referencing rather than
  copying will work when there is evidence to build on.
- **Mining and colonisation categories.** The model covers them; no processors
  yet. Exobiology was completed properly instead of three categories half-done.
- **Live states for other activities.** `LiveActivity` is a tagged union on `kind`
  with one member, and the overlay falls back to the recorded entry for a `kind` it
  does not recognise — so mining or delivery progress can be added without
  touching the widget's structure or breaking an older overlay.
- **Plugin-contributed processors.** The processor signature is already a pure
  function, which is the shape a plugin API would take, but the contract is not
  stable enough to publish.
