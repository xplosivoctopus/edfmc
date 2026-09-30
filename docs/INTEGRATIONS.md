# External integrations

Four services, four genuinely different models, one shared rule: **the commander
can see what leaves their machine before it leaves, and nothing leaves until they
switch it on.**

Data goes from the game's journal, through the Companion, to the service. **It
never passes through EDFM.** Your API keys are yours; the EDFM server never sees
one.

---

## Status

| Service | State | Needs |
|---|---|---|
| **EDDN** | **Implemented** | Nothing — it is anonymous community sharing |
| EDSM | Designed | Your API key, and a round of live testing |
| Inara | Designed | **App registration by the project owner** |
| EDAstro | Investigated, not built | Confirmation of what it accepts directly |

Every one ships **off**. Three of the four report "Not built yet" in the UI
rather than offering a switch that does nothing — an integration that looks
active while sending nothing is worse than one that admits it is unfinished,
because the commander assumes their data is going somewhere it is not.

---

## EDDN

Transcribed from the **live** branch of `EDCD/EDDN` on 2026-09-29, because its
README says in capitals not to trust any other branch as a description of the
running service.

- **Endpoint** `https://eddn.edcd.io:4430/upload/` — the trailing slash is required
- **Events sent** exactly the seven the schema names: `Docked`, `FSDJump`,
  `Scan`, `Location`, `SAASignalsFound`, `CarrierJump`, `CodexEntry`
- **Header** `uploaderID`, `softwareName`, `softwareVersion`, and — easy to miss —
  **`gameversion` and `gamebuild`, both mandatory**

### Sanitisation is the whole safety property

EDDN is public and permanent. Anything sent is visible to anyone, forever. So
this is **deny by default**: only those seven events are considered, and the
schema's forbidden keys are stripped **recursively**, because `Factions` is an
array of objects carrying its own forbidden fields. A top-level sweep would
publish `MyReputation` for every faction in the system.

Stripped: `ActiveFine`, `CockpitBreach`, `BoostUsed`, `FuelLevel`, `FuelUsed`,
`JumpDist`, `Latitude`, `Longitude`, `Wanted`, `IsNewEntry`,
`NewTraitsDiscovered`, `Traits`, `VoucherAmount`, every `*_Localised` key, and
within factions `HappiestSystem`, `HomeSystem`, `MyReputation`,
`SquadronFaction`.

`Latitude`/`Longitude` matter more than they look: they say **where on a planet a
commander was standing**.

A second pass, `auditEddnMessage`, runs before anything is sent. The duplication
is deliberate — this is the last point at which a mistake is still private.

### The odyssey flag

The spec is emphatic, and the code follows it exactly: if `LoadGame` carried no
`Odyssey` boolean, the flag is **omitted entirely**. Not sent as `false`.

### Testing

EDDN provides `/test` schema forms and requires their use when exercising
EDDN-handling code. Nothing in the test suite contacts the network at all; the
message builder defaults to the test schema everywhere except a real submission.

---

## EDSM — designed, needs your key

Documented API: `POST https://www.edsm.net/api-journal-v1` with
`commanderName`, `apiKey`, `fromSoftware`, `fromSoftwareVersion` and the journal
message.

**What you need to do:** EDSM → Settings → *My API Key*. The key identifies your
account; treat it as a password.

Not switched on yet because it warrants testing against a real account first, and
because of the credential boundary described below.

---

## Inara — designed, needs project-owner action

Inara is **not** a journal-forwarding API. It takes its own event vocabulary, so
the adapter must translate rather than relay.

**What the project owner must do:** register EDFM Companion as an application
with Inara to obtain an application key. That is not something this codebase can
invent, and no placeholder will be shipped in its place.

Individual commanders would additionally supply their own personal API key.

---

## EDAstro — investigated, deliberately not built

EDAstro already consumes much of what it needs **from EDDN**. Sending the same
records directly would be duplication rather than contribution.

Which observations it accepts directly has not been confirmed against current
documentation, and this project does not send data on a guess. Left explicitly
unbuilt with that reason stated in the UI.

---

## Credentials

**Stored in the OS credential store** — Windows Credential Manager, via the
`keyring` crate's native backend. Encrypted at rest by the OS, scoped to the user
account, no vault password to invent.

Considered and rejected:

- **`tauri-plugin-stronghold`** — a real encrypted vault, but unlocked by a
  password the commander must invent and re-enter. For one API key that is worse
  security in practice, because such passwords end up trivial or written down.
- **The settings table** — plain SQLite. Calling that credential storage would be
  exactly the kind of claim this project has already had to correct once.

### The boundary that matters more than the storage

**There is no command that reads a secret back out.** The frontend can store one,
clear one, and ask whether one exists — never fetch it. A secret that reaches
JavaScript can reach a log line, an error message, a crash report or a
screenshot.

A Rust test asserts that no such getter exists, so adding one is a deliberate act
that fails the suite rather than an oversight.

**The consequence, recorded so it is not rediscovered later: any integration
needing a credential must perform its HTTP request in Rust.** EDDN needs none,
which is why it is the one implemented first.

---

## What is never shared, by any of them

- Chat, friends, wings, squadrons
- Your Activity Journal, your notes, your saved items
- Your credits, loadout, fines, bounties or faction reputation
- Where you are standing on a planet
- Anything at all while an integration is switched off

The privacy manifests in `packages/integrations/src/registry.ts` are rendered
directly by the **Connections & Data Sharing** screen and are **checked by tests
against the sanitiser**, so the promise and the code cannot drift apart.

That list is *intersected* across the integrations, not concatenated
(`universalNeverShares`): a guarantee that holds for three services and not the
fourth is not a guarantee, and printing it as one at the top of the page would
be the most consequential kind of wrong that screen could be. Anything covered
by some but not all of them appears in the per-service lists instead.

---

## Durable queues

One queue per integration, so a failing service cannot block another. There is no
shared head-of-line: EDSM being down does not stop EDDN.

| Status | Meaning |
|---|---|
| `queued` | Waiting to be sent |
| `attempting` | In flight |
| `accepted` | The service took it |
| `retryable` | Failed, will be tried again after a wait |
| `rejected` | Will never be sent — and why |

**A retry cannot duplicate.** The id is supplied by the producer and is
deterministic; for a journal submission it derives from the source event id,
which is already stable across restart and replay. Enqueueing the same
observation twice is the same row. The primary key is `(integration, id)`,
because the same event may legitimately be owed to two services and one
accepting it says nothing about the other.

**Some failures must stop.** A 4xx from a schema validator or an auth check will
be rejected identically forever, so it is marked `rejected` immediately rather
than retried. `429` and `408` are the exceptions — they mean *later*, not
*never*. Everything else backs off on a fixed schedule (5s, 30s, 2m, 5m, 10m,
10m) and gives up after six attempts, recording why.

Backoff is **stored on the row**, not held in a timer, so a wait survives a
restart instead of collapsing into a retry storm.

**An item whose owner cannot be established is never sent.** Guessing which
account should receive somebody's data is worse than not sending it.

**A stored error never carries a credential.** Query strings and named credential
parameters are stripped, and the text is bounded, before anything reaches the
database or the audit screen.
