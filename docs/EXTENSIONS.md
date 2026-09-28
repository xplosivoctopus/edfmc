# Extension architecture

How EDFM Companion is extended, where the boundaries are, and why they are drawn
where they are.

This document is the plan. `docs/PLUGINS.md` is the guide for writing one today.

---

## 1. Assessment of what exists

The current system is small, and most of what it does is right. Measured:
`packages/plugins` is 483 lines across three files, with 22 tests, plus 5 Rust
tests in the loader.

### What it gets right, and must not lose

**Plugins are data, and there is no code path that would run code if one shipped
it.** This is the load-bearing decision. `@edfm/context` conditions have a fixed
operator set, no `eval`, and deliberately no regular expressions — built that way
because rules arrive from an untrusted server, which is the same threat model as a
stranger's plugin. The hardening already applied.

**A denylist on observation, not a guideline.** `FORBIDDEN_OBSERVATION_EVENTS`
blocks `ReceiveText`, `Friends`, `Commander`, `LoadGame`, squadron and wing events.
It is deliberately event-level rather than field-level, because `ReceiveText` has no
safe subset worth the risk of getting a path match subtly wrong.

**Namespacing that cannot shadow.** Contributed ids are prefixed with the plugin
id, and `mergeContextRules` puts built-ins first so a collision cannot replace a
shipped rule.

**Failure is isolated and legible.** One broken plugin is rejected with a reason
naming its folder; the others load; the app starts.

**Bounds exist.** 50 plugins, 200 rules each, 512 KB manifest, capped TTLs.

### Concrete gaps

| Gap | Consequence |
|---|---|
| **Manifest size is bounded in the wrong layer** | `fs::read_to_string` in Rust reads the whole file before TypeScript checks `maxManifestBytes`. A 2 GB `plugin.json` is a memory exhaustion, not a rejection. Same for `README.md`. |
| No compatibility declaration | A pack written for a future rule schema loads and silently misbehaves rather than saying "needs a newer Companion". |
| No API versioning | Internal types *are* the contract. `ContextRule` changing is a breaking change for every plugin, invisibly. |
| No settings | Every pack that wants a preference has to hard-code it. |
| No plugin storage | Nowhere to keep state, so nothing can accumulate knowledge. |
| No networking | No integration with external services. |
| No overlay contribution | Packs can add context rules but cannot add a widget. |
| Install is "copy a folder" | Workable for authors, poor for players. |
| No integrity or provenance | A pack is whatever is in the folder. |
| Raw journal shape is the contract | Authors must know Frontier's quirks — that `ApproachSettlement` fires at Guardian ruins, that `SAASignalsFound` covers planets. |

---

## 2. Gap against typical EDMC plugins

EDMC plugins are Python with unrestricted access. The useful question is not "can
we run them" — we should not — but "what do they actually *do*", and can each be
served safely.

| EDMC capability | EDFMC today | Planned tier |
|---|---|---|
| Observe journal events | Context rules only | Semantic events (T2) |
| Current system / station / ship | No | Knowledge API (T2) |
| Plugin-local storage | No | Scoped storage (T2) |
| Settings UI | No | Settings schema (T1) |
| HTTP to an external service | No | Scoped networking (T2) |
| Main-window panel | No | Schema-driven panel (T2) |
| Overlay drawing | No | Widget schema (T1 data, T2 dynamic) |
| Desktop notifications | No | Capability (T2) |
| Arbitrary Python | **No, and never** | — |
| Read arbitrary files | **No, and never** | — |
| Read chat / friends / identity | **No, and never** | — |

The last three are the point. Most genuinely useful EDMC plugins need the first
eight; the unrestricted runtime is how they get them, not what they need.

---

## 3. Tiers

**Tier 1 — Community Packs.** Data only. What exists today, expanded: context
rules, research projects, overlay widget definitions, settings schemas, resource
mappings, checklists. Incapable of execution by construction, not by policy.
Automated validation is sufficient to publish one.

**Tier 2 — Capability Plugins.** Programmable, but the plugin never holds a
reference to anything internal. It receives *semantic events* it has permission
for, and calls a message API. Not built.

**Tier 3 — Advanced Extensions.** Isolated execution — a capability-limited worker
or sandboxed webview with no ambient authority. Architecturally reserved;
deliberately disabled. The invariant that makes it possible to add later is that
**Tier 2's API is a message contract, not an object graph** — so the same contract
works across a process boundary without redesign.

The rule for adding a capability: *a plugin may only receive what it declared, and
the host must be able to answer "why does it have this?" from the manifest alone.*

---

## 4. Threat model

The adversary is a plugin author who is careless, or malicious, or whose account
was taken over after a pack was already trusted.

| Threat | Control |
|---|---|
| Exfiltrate commander identity | Identity is never in any extension API. `Commander`/`LoadGame` denied. No networking in T1. |
| Log chat | `ReceiveText`/`SendText` denied at event level, not field level. |
| Read arbitrary files | Extensions never receive a path. Loader reads one fixed folder. |
| Execute code | No code path exists in T1. T3 is isolated and off. |
| Spoiler leakage | Knowledge API must project through the existing spoiler gate, never the verification store. |
| Denial of service | Bounds on count, size, rules, TTL — *and* in the layer that reads, which is the gap above. |
| Shadow a built-in | Namespacing plus built-ins-first merge. |
| Impersonate another plugin | Reverse-DNS ids, uniqueness enforced at load. |
| Silent capability creep | Manifest declares; host enforces; UI shows. A pack that gains a capability must change its manifest, which is visible. |

**Signing is explicitly not a safety control.** It proves who published and that
bytes are intact. It says nothing about behaviour, and the UI must never imply
otherwise.

---

## 5. Stable API boundaries

The public contract is *not* `ContextRule`, `CommanderState`, `Companion`, React
components, Tauri APIs or the database schema. Those are internal and change freely.

Five independently-versioned surfaces:

| Surface | Version | Covers |
|---|---|---|
| Manifest | **2** | Package shape, `requires`, contributions |
| Journal Semantic | 1 | `player.docked`, `exobiology.scanned`, … |
| Knowledge | 1 | Read-only projected state |
| Overlay | 1 | Widget schema |
| Settings | 1 | Settings schema |

A manifest declares what it needs:

```json
{
  "manifestVersion": 2,
  "requires": { "edfmCompanion": ">=0.3.0 <1.0.0", "pluginApi": "^2.0" }
}
```

Incompatibility is detected **before activation** and reported with the reason.

---

## 6. Package format

`.edfmp`, a ZIP, validated fully before anything is written:

```
manifest.json
README.md
rules/  widgets/  assets/  icon.png
```

Rejected: path traversal, absolute paths, symlinks, oversized archives,
compression ratios indicating a bomb, executables where not permitted, nested
manifests that confuse attribution. Installation is atomic — a partial extract
never replaces a working pack.

---

## 7. Permission model

Explicit, stable, auditable strings. Tier 1 holds **none** — a data-only pack needs
no permission because it has no reach.

```
journal.docked   journal.missions   journal.scan-organic   journal.raw
state.location   state.ship         state.missions
storage.local    overlay.widget     ui.panel
network:https://api.spansh.co.uk    notifications.show
```

`journal.raw` and any wildcard network origin are high-risk and labelled as such.
Some categories are permanently unavailable: chat, friends, identity, credentials,
filesystem paths.

The inspector shows granted *and* denied, in text as well as icon — never colour
alone.

---

## 8. Phases

**A — Foundation (this milestone).** Manifest v2, compatibility declarations, API
version constants, the size-bound fix, v1 migration.
**B — Declarative surface.** Settings schema + UI, overlay widget schema, scoped
storage.
**C — Semantic layer.** Semantic events, knowledge API, permission model and
inspector.
**D — Packaging.** `.edfmp`, installer, validation UI, developer CLI, simulator.
**E — Capability plugins.** Message API in an isolated worker.
**F — Distribution.** Signing, repository, updates.

Deliberately not the order in the brief: packaging before semantics would mean
shipping a package format that has to change when the interesting contributions
arrive.

---

## 9. Migration

`manifestVersion: 1` keeps loading, unchanged, indefinitely. It is treated as a
Community Pack with no `requires` and no capabilities. No existing plugin breaks,
and the example plugin in this repository stays valid.

v2 adds fields; it removes nothing. An author upgrades to *declare* things, not to
keep working.

---

## 10. First milestone

Implemented now:

- Manifest API v2 with `requires`, validated and bounded
- Five API version constants as the published contract
- Compatibility evaluated before activation, with the reason surfaced
- `kind` declared explicitly; anything claiming executable capability is refused
  with a clear message, so Tier 2/3 fail closed before they exist
- The manifest/README read bounded **in the layer that reads**
- v1 manifests load untouched

Not in it: settings UI, storage, networking, semantic events, packaging. Each
needs the versioning this milestone establishes, which is why it is first.
