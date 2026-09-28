# EDFM Companion — Architecture

Status: **all phases implemented**. Sections below that describe a design
decision still describe the shipped one unless they say otherwise.
Last updated: 2026-09-01

This document records *why* decisions were made. Code describes itself; this file
exists to explain the reasoning so a future maintainer does not silently undo it.

---

## 1. Evidence base

Every claim in this document concerning Elite Dangerous behaviour was validated
against a real corpus on the development machine, **not** against documentation alone:

| Property | Value |
|---|---|
| Journal files analysed | 220 |
| Total lines parsed | 197,164 |
| Distinct event types observed | 197 |
| Date range | 2026-06-07 to 2026-09-01 |
| Game builds observed | 4.3.3.0, 4.4.0.0, 4.4.0.1, 4.4.0.2, 4.4.0.3 |
| Malformed JSON lines | 0 |

Field-presence rates quoted below are measured from that corpus. See
[JOURNAL.md](JOURNAL.md) for the full findings and methodology.

**Rule adopted:** no parser may treat a field as required unless it was observed at
100% presence across the corpus *and* its absence would be semantically impossible.
Everything else is modelled as optional.

---

## 1a. Project principles

Three rules that outrank convenience anywhere they apply.

> **If the game did not report it, do not guess.**

A value the journal did not provide is `Unknown`, never a plausible default.
Field presence is measured, not assumed (§1).

> **Verify aggressively. Reveal conservatively.**

The verification engine may compare anything against EDFM's data, including
places this commander has never been. The player-facing application may show only
what this commander's own game has told them. These are different questions,
answered in different places.

> **If this commander's game has not revealed it, the Companion must not reveal it.**

The stricter form of the first rule, for exploration and exobiology. A commander
who enjoys exploring must never have a discovery spoiled because EDFM already
knows the answer. Enforced structurally — see [SPOILERS.md](SPOILERS.md).

## 2. Technology decisions

### 2.1 Desktop: Tauri 2 + TypeScript

Chosen over a .NET/Avalonia alternative. Deciding factors:

- **Overlay support is native.** Tauri 2 exposes transparent, always-on-top, and
  click-through (`set_ignore_cursor_events`) windows without a third-party layer.
  That maps directly onto the Section 7 requirement set.
- **The native layer is Rust**, giving first-class Win32 interop for window tracking
  and DPI without writing C++.
- **Small binaries** (~10 MB vs a bundled runtime), which matters for an application
  whose explicit design constraint is running alongside a game.
- **Linux stays open.** Platform-specific work is confined to two Rust modules
  (known-folder resolution, overlay window management) behind traits.

Research did not identify a materially better alternative, so the stated preference
was kept. Toolchain verified present: Node 24.19.0, rustc 1.98.0 MSVC, MSVC 14.44.

### 2.2 Why the journal engine is TypeScript, not Rust

This is the one place we deliberately diverge from "put the hard native work in Rust".

The journal engine is *parsing and domain logic*, not OS integration. In TypeScript:

- the **replay harness, the live pipeline, and the unit tests are the same code
  path** — which is the Section 3 requirement, and is much weaker if replay runs
  through a different language binding than live play;
- normalization logic is shared with the backend and the contracts package;
- fixture-driven tests run in milliseconds without a compile step.

Rust retains what it is actually better at: known-folder resolution, the overlay
window, and process/window tracking.

The file *tailing* primitive is TypeScript too, because the correctness-critical part
is offset bookkeeping, not I/O throughput. At Elite's event rate (the busiest observed
session was 3.35 MB across several hours) this is not a performance concern.

### 2.3 EDDN worker: Python

Deliberately *not* the same language as the API. EDDN's own reference subscriber is
Python; `pyzmq` and `jsonschema` are the most battle-tested tools for this exact job
(SUB socket, zlib frames, `$schemaRef` validation). Section 2 explicitly permits
favouring reliability over language uniformity, and the worker is a server-side
process that never touches the desktop toolchain.

### 2.4 Backend: TypeScript + PostgreSQL

Shares typed contracts with the desktop client via `packages/contracts`. Migrations
from commit one, and implemented: station verification ships with spoiler gating.

---

## 3. Component boundaries

```
+----------------------------------------------------------+
| apps/desktop  (Tauri 2)                                   |
|  +----------------+        +---------------------------+  |
|  | Rust native    |        | TypeScript UI + logic     |  |
|  |  known folder  |<--IPC->|  journal engine           |  |
|  |  overlay win   |        |  state store              |  |
|  |  window track  |        |  local SQLite             |  |
|  +----------------+        +---------------------------+  |
+---------------------------+------------------------------+
                            | HTTPS, typed contracts
                            v
+----------------------------------------------------------+
| services/api   (TS + PostgreSQL)                          |
|   context rules | verifications | research | markets      |
+-----------+-------------------------------+--------------+
            |                               |
            v                               v
+-----------------------+      +---------------------------+
| services/eddn-worker  |      | MediaWiki (edfieldmanual) |
| Python | pyzmq | SUB  |      | MediaWiki 1.46.0 api.php  |
| eddn.edcd.io:9500     |      | articlepath /wiki/$1      |
+-----------------------+      +---------------------------+
```

**Security boundary.** The desktop client is untrusted. Discord webhooks, database
credentials, and administrative keys exist only in `services/*`. The client submits
*observations*; it never writes reference data. Discord notification is emitted by the
backend, never by the client.

---

## 4. The journal pipeline

```
JournalDirectory  --watch-->  JournalTailer  (byte offsets, partial-line safe)
                                    |
                                    v  raw line + provenance
                              JournalParser   --> ParseFailure (counted, never fatal)
                                    |
                                    v  RawJournalEvent
                              JournalNormalizer --> UnknownEvent (preserved verbatim)
                                    |
                                    v  TypedDomainEvent  (raw always retained)
                              StateStore / EventBus
```

### 4.1 Event identity — how restart-without-duplication works

Every event gets a deterministic identity:

```
eventId = `${journalFileName}:${byteOffset}`
```

Stable across restarts, unique within a commander's journal directory, and requiring
no content hashing. The checkpoint stores `(fileName, byteOffset)`; on restart we
resume from exactly that offset, so an event is emitted once. Replaying the same file
through the pipeline yields identical ids, which is what makes the replay harness a
genuine regression test rather than an approximation.

Timestamps are explicitly **not** used as identity: the corpus contains many events
sharing a timestamp to the second.

### 4.2 Partial-write safety

The tailer emits a line only when a terminating newline has been observed. A trailing
fragment is buffered and the persisted offset is **not** advanced past it. All 220
files in the corpus are CRLF-terminated; both LF and CRLF are handled.

### 4.3 Rotation

Observed behaviour: Elite opens a new `Journal.<timestamp>.<part>.log` per session.
Across the whole corpus `part` was always `1` and the filename suffix always `01` —
**no size-based continuation was observed in three months of play**.

Continuation is nonetheless handled defensively, because older client versions did
split journals. Rotation is detected by directory scan plus filename ordering, never
by assuming newest mtime is the active file.

### 4.4 Edge cases found in real data (not hypothesised)

Discovered in the corpus and encoded as tests:

- **Zero-byte journal files exist.** Two were present. A watcher that naively selects
  the newest file and waits would stall forever. The selector skips empty files when
  choosing a resume target but still tracks them for rotation.
- **`{ "timestamp":..., "event":"MarketID" }`** — a real, payload-less event emitted by
  build 4.4.0.3. A normalizer keyed on "MarketID is a numeric field" must not choke.
- **220 files but 218 `Fileheader` events**, because of the two empty files. Code must
  not assume a journal begins with a header.

---

## 5. What the data does and does not support

Recorded so features are not designed around assumptions.

### Supported — verified present

- **Station service verification (§9).** `Docked` carries `StationServices`,
  `MarketID`, `SystemAddress`, `StationType`, `DistFromStarLS`, `LandingPads` and
  `StationEconomies` at 100% presence (n=1798). `ApproachSettlement` carries
  `StationServices` at 100% (n=440), giving a second observation channel.
- **Colonisation delivery tracking (§16/§17) is fully automatic.**
  `ColonisationConstructionDepot` (n=5699) is a *complete snapshot* — every emission
  carries the full `ResourcesRequired` array with `RequiredAmount`, `ProvidedAmount`
  and `Payment`, plus `ConstructionProgress`/`Complete`/`Failed`. No inference needed.
  This resolves the §17 open question affirmatively.
- **Coordinates.** `FSDJump.StarPos` is present at 100% (n=3837), so distance-based
  routing has a real basis — for systems the commander has actually visited.

### Not supported — must not be faked

- **Mission destinations are frequently absent.** `MissionAccepted.DestinationSystem`
  is present in only **54.8%** of cases and `DestinationStation` in **47.0%** (n=270).
  Donation, mining and some combat missions carry no destination at all. The planner
  must render "no destination given" rather than inventing one.
- **`Docked.StationAllegiance` is present only 32.0% of the time.** Absence is *not*
  evidence of independence — it is modelled as unknown and must never generate a
  verification discrepancy.
- **Massacre-mission progress is not journalled.** Only accepted/completed transitions
  are reliable, exactly as §8 anticipated. No incremental counter will be shown.
- **`StationEconomies` proportions do not sum to 1.0.** A real sample summed to 1.10
  (0.90 + 0.10 + 0.05 + 0.05). Do not normalise or renormalise these.

---

## 6. Normalization policy

**Raw is never discarded.** Every `TypedDomainEvent` retains `raw` (the parsed object
verbatim), the raw event name, source file, byte offset, timestamp, and the game
version/build in force. Normalization is an *additive* layer.

This matters concretely: `StationServices` tokens are **not consistently cased**. One
real array contains `"stationMenu"` alongside `"dock"`, `"searchrescue"` and
`"registeringcolonisation"`. We store the raw token *and* a normalized identifier;
§9 comparison happens on the normalized id while the report carries the raw token as
evidence. Section 9's "preserve RAW station-service tokens" requirement is therefore a
correctness measure, not merely an audit nicety.

Similarly `ScanOrganic.Body` is an **integer BodyID**, not a body name — a field easy
to mistype as a string from its name alone.

Unknown events are preserved, counted, and surfaced in diagnostics at debug level.
They never throw and never halt the pipeline.

---

## 7. Overlay approach

Built as described: a separate Tauri window — `transparent`, `alwaysOnTop`, `decorations: false`
— with `set_ignore_cursor_events(true)` in normal mode and `false` in edit mode.
Position tracked against the Elite Dangerous window via Win32.

**No DLL injection, no code injection, no input automation** (§31). Hard constraint.

**Exclusive fullscreen is expected not to work** and will not be claimed until
demonstrated. A non-injecting external overlay cannot reliably compose above a DirectX
exclusive-fullscreen swapchain; this is inherent to the approach, not a bug we can
fix. The application will detect the situation and recommend Borderless, matching the
§7 requirement to communicate the limitation rather than overpromise.

EDMCOverlay and similar projects are GPL. We have not read or copied their source.

---

## 8. Local persistence

SQLite. Tables are normalized, not a JSON dumping ground (§26). Phase 1 defines
`settings`, `journal_checkpoint`, `commander_state`, `ingest_stats`. Later phases add
`missions`, `research_queue`, `submission_queue`, `cached_context_rules`,
`overlay_layouts`.

The checkpoint table is the mechanism behind "restart does not duplicate state".

---

## 8a. Host wiring

The engine's I/O sits behind a `JournalFs` port with two adapters:

| Host | Adapter | Installed by |
|---|---|---|
| Node (tests, replay, tooling) | `@edfm/elite-journal/node` | side-effecting import |
| Tauri webview | `apps/desktop/src/lib/tauriFs.ts` | `setDefaultFs(tauriFs)` |

The core package contains **no `node:` imports**. That is deliberate: when it did,
Vite externalised `node:fs` into the desktop bundle, shipping a stub whose only
possible behaviour was to fail confusingly at runtime. Hosts now wire their adapter
explicitly, so there is no platform guess to get wrong.

The Tauri adapter is backed by four narrow read-only commands rather than a broad
filesystem permission, so a renderer compromise cannot reach arbitrary user files.

## 9. Known technical risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Exclusive fullscreen overlay likely impossible without injection | Detect and recommend Borderless; never claim support until demonstrated |
| 2 | Frontier changes journal schema without notice | Raw preserved, unknown-tolerant parser, build recorded per event; 5 builds already seen in 3 months |
| 3 | Commodity naming differs across sources | `ColonisationConstructionDepot` uses `$aluminium_name;`; Market/EDDN use other forms. One normalization table with raw retention is required before Logistics |
| 4 | Mission destination gaps (54.8%) undermine routing | Planner degrades explicitly; routing deferred until coordinate coverage is proven |
| 5 | Verification false positives from optional fields | Only fields at 100% presence may generate discrepancies; unknown is not absent |
| 6 | EDDN live schemas may lag GitHub master | Worker pins the `live` branch schema set and validates `$schemaRef` |

---

## 10. External interfaces (verified 2026-09-01)

- **EDDN relay:** `tcp://eddn.edcd.io:9500`, ZeroMQ **SUB**, empty topic subscription,
  each frame **zlib-compressed** JSON. Upload endpoint `https://eddn.edcd.io:4430/upload/`
  is not used — we are a consumer, and desktop clients must not upload directly.
- **EDDN live schemas** (`live` branch, 18 total): commodity-v3.0, journal-v1.0,
  outfitting-v2.0, shipyard-v2.0, approachsettlement-v1.0, fssallbodiesfound-v1.0,
  fssbodysignals-v1.0, fssdiscoveryscan-v1.0, fsssignaldiscovered-v1.0,
  navbeaconscan-v1.0, navroute-v1.0, scanbarycentre-v1.0, codexentry-v1.0,
  blackmarket-v1.0, dockingdenied-v1.0, dockinggranted-v1.0, fcmaterials_capi-v1.0,
  fcmaterials_journal-v1.0.
- **EDFM MediaWiki:** `https://edfieldmanual.com/`, MediaWiki **1.46.0**, `api.php` at
  root, `articlepath = /wiki/$1`. Use the API for search/metadata/canonical URLs; do
  not scrape rendered HTML.

## The `Companion` application service

`apps/desktop/src/lib/companion.ts` coordinates journal ingestion, commander
state, contexts, missions, verification, discovery, reference data, submission
queues, research, logistics, plugins, overlay state, SQLite persistence and
contribution statistics. It was 2,237 lines with 78 private fields.

That is worth being honest about rather than defending. It is also worth being
honest about what is and is not wrong with it.

### What is actually wrong

**Not much cohesion, in one specific sense.** The class has fourteen section
banners the author wrote by hand. Those are seams — they mark boundaries that
already exist conceptually and simply are not expressed in the module system.
Code that needs comment-drawn dividers to be navigable has outgrown one file.

**One real coupling hazard, now removed.** The four journal-history backfills
shared a subtle invariant: none may go through `applyEvent`, because the reducer
maintains "what just happened" and replaying a month-old event through it makes
the dashboard report stale activity as the latest thing the commander did. That
rule lived in four separate comments in four separate methods. A fifth backfill
written by someone who had not read all four would get it wrong, and the symptom
would be a confusing UI rather than a crash.

**Snapshot invalidation is the genuine architectural risk.** `snapshot()` must
return a referentially stable object or `useSyncExternalStore` aborts the render
tree — this has already shipped as a startup crash once. Every subsystem that
mutates state must route through `notify()`, and nothing in the type system
enforces it. Any extraction must preserve that, which is why
`apps/desktop/test/companion.test.ts` asserts identity with `toBe`.

### What is not wrong

**Size alone.** A 2,000-line class that is navigable, commented and tested is not
automatically a problem, and churning it into eight files for tidiness would move
regression risk around rather than reduce it.

**The seams that already work.** Journal parsing, context rules, missions,
verification, research, logistics and plugins are all *already* separate
packages with their own tests. `Companion` is the wiring between them and the
host, not a monolith that swallowed them. Much of its length is the wiring
being explicit rather than clever.

### What was extracted, and why that one

`lib/backfill.ts` — the four history-recovery routines. Chosen by measurement:
they touch only five things outside themselves (commander state, two persistence
callbacks, and a "something changed" signal), which is the narrowest coupling of
any candidate group, and they share the one invariant most likely to be broken
by someone adding a fifth. 152 lines moved; behaviour unchanged; the full suite
was green before and after.

### What to extract next, in order

Ranked by coupling measured against the rest of the class, not by size:

1. **Plugins** (~110 lines). Reads from disk, validates, merges rules into the
   resolver. Depends on one setting and one resolver call.
2. **Logistics** (~175 lines). Owns its own state and persistence; touches the
   rest mainly to notify.
3. **Research** (~90 lines). Same shape, smaller.
4. **Reference data and the submission queue.** Higher value but higher risk:
   they are the pieces gated on consent, and the gate is checked at call time
   precisely so revoking it takes effect immediately. Any extraction must keep
   that property, and it is the one most costly to get wrong.

Missions, discovery and overlay state are *not* recommended for extraction:
they read and write commander state closely enough that a boundary would mean
passing most of it across, which is coupling relabelled rather than removed.

### The constraint any refactor must preserve

The React-facing store exposes exactly one thing: a referentially stable
snapshot. Whatever moves, that contract does not, and a regression in it is a
white screen rather than a subtle bug.
