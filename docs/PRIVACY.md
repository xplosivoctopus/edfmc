# Privacy

The Companion reads the Elite Dangerous journal, which is a detailed record of a
commander's activity: identity, finances, travel history, chat, friends, squadron and
private-group membership. That access is a responsibility, and this document is the
commitment we hold ourselves to.

## Current state

**Nothing leaves the machine unless you turn verification on.** It is off by default
and there is no telemetry and no analytics in any configuration.

With verification **off** — the default — the application makes no network requests at
all.

With verification **on**, exactly two things happen, both only for stations you dock
at or fly past:

1. A **reference lookup** by MarketID. This tells the server which station you are at.
   It is a location disclosure, and it is the reason the feature needs consent even
   before anything is submitted.
2. An **observation submission**: what your game reported about that station.

Turning it back off stops both immediately — the setting is consulted at call time,
not read once at startup — and clears the reference data already cached.

Submission is queued locally and sent in the background, so an outage costs
nothing but latency and a queued observation survives a restart. Fleet carrier
observations are never uploaded at all: their services are the owner's current
configuration rather than a fact about the galaxy, so the server cannot derive
anything from one and sending it would be traffic with no possible result.

### What a submission contains

The station's MarketID, name, type, system, the service tokens your game reported, the
timestamp, the journal event name and its `file:byteOffset`, your game version and
build, and the Companion version.

### Identity: what is sent, and what is kept

This section said for some time that identifiers were "sent as one-way hashes". That
was **wrong**, and the correction matters more than the wording: they are sent as
values and hashed on arrival. What follows is what the code does.

| | Anonymous | CMDR-attributed |
|---|---|---|
| Frontier ID | **sent as a value** | **sent as a value** |
| Commander name | not sent | **sent as a value** |
| Journal filename | sent as a value | sent as a value |
| Stored by the server | keyed hashes only | keyed hashes only |

**In transit.** HTTPS to `api.edfieldmanual.com`. Your FID goes in both modes, because
independence scoring is meaningless without something that distinguishes reporters.
Your commander name goes only when you have asked to be credited.

**On arrival.** The server immediately derives a keyed HMAC-SHA-256 of each value,
domain-separated so a name that happens to equal a filename cannot hash alike in two
columns, and truncated to 32 hex characters. The commander name is case-folded first,
so `Hadfield` and `hadfield` are one person.

**What is written to disk.** The hashes. The values are not persisted in any table, so
a database dump contains no commander FIDs, names or journal filenames. The salt is
required at boot and rejected if it is short enough to brute-force — FIDs are short and
structured, so a weak key would make the hashes reversible by anyone holding the
database.

**The honest summary.** Attribution is still a decision about credit rather than
disclosure, because the server keeps no name either way. But "the server never sees
your FID" is not something this design claims: it sees it, uses it, and does not keep
it. Trusting that is a decision about the operator, which is why contribution is
off until you switch it on.

**Could the client hash instead?** Analysed and rejected, not overlooked:

- Hashing with the *server's* salt would require shipping the salt to every client,
  at which point it is not a secret and the short, structured FID space makes the
  hashes trivially reversible by anyone. Strictly worse than today.
- Hashing with a *client-held* salt would keep the value off the wire, but any client
  could mint unlimited identities by changing its salt. Independence scoring would
  become Sybil-forgeable, and §9's whole purpose is that thirty reports from one
  person are not thirty reporters.

A blind-signature or oblivious-PRF scheme could in principle give both properties. It
is not built, and pretending otherwise in this document is what created the error
above.

**Your IP address** is not stored. A keyed, truncated hash of it is kept so one source
flooding the endpoint can be noticed.

## What is stored locally

| Table | Contents |
|---|---|
| `settings` | User preferences, e.g. a manual journal folder override |
| `journal_checkpoint` | Journal filename and byte offset, scoped per commander FID |
| `commander_state` | Current system, station, ship and docking state |
| `ingest_stats` | Aggregate counters: lines read, events emitted, malformed lines |
| `unknown_events` | Event **names** without a typed shape, and how often they occurred |
| `discovery_state` | What your own game has revealed to you, scoped per commander FID |
| `verification_queue` | Findings awaiting submission, so an outage costs nothing |

`unknown_events` deliberately stores names and counts only. An unknown event's body
can contain arbitrary commander detail, and we have no reason to keep it.

## What is never done

- The journal is never copied, uploaded, or transmitted in whole or in part.
- Chat (`ReceiveText`, `SendText`), friends, squadron membership and private-group
  names are read only insofar as they pass through the pipeline; none is persisted
  and none is logged.
- Full travel history is not accumulated.
- Financial state beyond the current credit balance shown on the dashboard is not
  retained.

## Logging

Structured logs record event **names**, byte offsets, file names and counters — never
event payloads. When a line cannot be parsed we log the reason, the file and the
offset, and deliberately not the line itself, because a malformed line is still
journal content.

Anything resembling a credential is redacted before it reaches a log sink, and the
diagnostics export applies the same redaction plus a payload-free allowlist.

## Network features, and the rules they follow

Station verification (Phase 5) is built. Research contribution (Phase 6) and
market/logistics queries (Phase 8) are not. All of them honour these rules:

1. **Opt-in.** Contribution features are off until explicitly enabled. Verification
   is off by default today, and revoking consent takes effect immediately.
2. **Minimum payload.** A submission carries only the structured fields the feature
   needs. Verification sends an observation about one station, not a session.
3. **Visible before sending.** The exact payload is inspectable before anything is
   transmitted.
4. **Separable traffic.** Requests required for the application to function are
   distinguished from optional contributions in both settings and documentation.
5. **Identity is a choice.** Anonymous and CMDR-attributed modes are user-selected;
   EDFM-account-linked is not built. A commander name is never treated as
   authentication. Both modes send the FID as a value and the server keeps only a
   keyed hash, so the choice affects credit rather than what is retained.
6. **Discord identity only on explicit link.** Never inferred, never derived.

## What the server keeps

Documented here rather than only in [API.md](API.md), because a promise about a
desktop app that stops at the network boundary is not a privacy policy.

- **Submissions** are retained as an audit record (§19), including the observation and
  the hashes — never the identifiers.
- **Discrepancies** are aggregated across reporters. Thirty commanders reporting one
  wrong service is one finding, not thirty.
- **Discord reports** are posted to a moderation Forum as one thread per issue.
  They carry an opaque reference, never the discrepancy key — that key contains
  both values, so posting it would restore everything redaction removes.
  Spoiler-sensitive findings are **not posted at all** by default, because a
  Forum post is public and permanent. Your commander name is not included unless
  the server operator explicitly enables it. See [DISCORD.md](DISCORD.md).

## Offline behaviour

Journal monitoring, commander state, mission tracking, local research recording and
the overlay are designed to work with no network at all. Optional submissions queue
locally and retry with backoff, so a network outage costs nothing but latency.
