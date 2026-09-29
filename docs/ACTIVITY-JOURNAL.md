# The Activity Journal

Elite already writes a machine journal. This is the other one: a record of what
the commander *did*, in language they would use themselves.

Measured against the real corpus: **288,616 journal events across 299 files
produce 463 activity entries** — a reduction of about 623:1. That ratio is the
feature. A history that reproduces the journal has not interpreted anything.

Everything here is local. Nothing is uploaded, and no files are written during
normal operation.

---

## What it records today

| Subtype | Entries in the corpus | From |
|---|---|---|
| `landed` | 283 | `Touchdown` on a planet |
| `signals-detected` | 107 | `SAASignalsFound` carrying genera |
| `sample-completed` | 68 | `ScanOrganic` with `ScanType: Analyse` |
| `data-sold` | 5 | `SellOrganicData` |

`Log` and `Sample` scans produce nothing. They are progress toward one specimen —
183 of 243 measured scans — and an entry each would bury the completion in its own
noise. The stages are still visible in the completed entry's data.

---

## Findings that changed the design

These are the reason the feature looks the way it does. Each was measured before
anything was written.

### There is no "first landfall" entry

The brief asked for one, and the journal does not support it.

**The only footfall field in the entire journal is `Scan.WasFootfalled`** — present
on 100% of 10,383 scans (false 9,953, true 430). It reports the body's state *when
it was scanned*. Nothing reports that the commander *achieved* a first footfall:
`Touchdown` and `Disembark` carry no such flag, and no other event mentions
footfall at all.

"It was unvisited when I scanned it, and then I landed" is an inference. A good
one, but an inference, and presenting one as a fact is what this project does not
do. So a landing is recorded as a landing, and what the journal actually said is
kept in the entry's data (`hadPriorFootfallWhenScanned`) for the UI to state
plainly without claiming credit.

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

Activity is travel history, play times and locations. It never leaves the machine,
is never sent to EDFM, and is not written to files.

Logs record counts and categories only:

```ts
logger.info('activity', 'Recorded activity', { count, categories });
```

Never titles — those carry system names, body names and organism discoveries.

---

## The Live Journal overlay widget

The Journal screen is the history. The overlay widget is not a smaller copy of it
-- it answers a different question: *what did I just record?*

One entry, plus how many were recorded at the same body. Off by default, and it
collapses to a count after five minutes. `docs/OVERLAY.md` has the lifecycle and
why that shape was chosen.

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
- **Plugin-contributed processors.** The processor signature is already a pure
  function, which is the shape a plugin API would take, but the contract is not
  stable enough to publish.
