# EDFM Companion

The official desktop companion for the [Elite Dangerous Field Manual](https://edfieldmanual.com/).

It watches your journal as you play, works out what you are doing, and puts the
relevant EDFM material in front of you — in a window or in an overlay on top of
the game. It also tracks your missions, your colonisation sites, and where to
buy what those sites need.

**Not an EDMC plugin.** It does not require EDMarketConnector, and it never
touches the game: no memory reading, no injection, no input automation.

## Download

**[→ Get the latest release](../../releases/latest)**

Download the `.msi`, run it, and start Elite. That is the whole setup — the app
finds your journal folder by itself.

You need **Windows 10 or 11**. Nothing else: no Node, no Rust, no database, no
account.

Two things to expect on first run:

- **Windows will warn that the publisher is unrecognised.** The installer is not
  code-signed. Choose **More info → Run anyway**. Every release publishes
  SHA-256 checksums and a signed build attestation, so you can check a download
  came from this repository — but neither removes the warning, and
  [docs/RELEASING.md](docs/RELEASING.md) is straight about the difference.
- **Nothing is sent anywhere.** Contributing observations to EDFM is optional and
  switched off until you turn it on in Settings.

## What it does

- **Knows where you are** — system, station, ship, missions — and keeps
  "the game did not say" visibly different from "the game said none".
- **Surfaces the right EDFM pages** for what is happening right now, in the app
  or as an overlay over the game.
- **Tracks missions** including delivery progress, so you can see what is left
  rather than doing the arithmetic.
- **Tracks colonisation sites** automatically and plans your buying: which
  stations to visit, in what order, and why each one was chosen.
- **Keeps a field journal** of what you actually did — organisms sampled, bodies
  landed on, signals found — built from your journal and kept on your machine.
- **Records field research** locally — what you find at settlements — with the
  honesty to say when a sample is too small to mean anything.
- **Takes plugins**, which are plain JSON and cannot run code. See
  [docs/PLUGINS.md](docs/PLUGINS.md).
- **Helps EDFM improve**, if you let it, by reporting where the game disagrees
  with the wiki.

## Your data

Your journal contains your chat, friends, finances and travel history. It is
read on your machine and **never uploaded**.

With contribution switched on, the app sends one thing: observations about
stations you dock at, over HTTPS. Your Frontier ID travels with them so the
server can tell two reporters apart, and your commander name travels only if you
have asked to be credited. The server hashes both on arrival and stores only the
hashes, so a database dump holds no commander identifiers — but it does see the
values in transit, and this project will not claim otherwise. There is no
telemetry and no analytics in any configuration.

With contribution off, the app makes no network requests on its own. It is not
silent in every configuration, and the distinction is worth stating: asking it to
plan a colonisation run sends a market query, because that is the feature. That
request carries commodity names and nothing about you, and happens only when you
ask for it.

[docs/PRIVACY.md](docs/PRIVACY.md) is the full account.

## Design commitments

These are constraints, not aspirations:

- **Verify aggressively. Reveal conservatively.** The verification engine may
  compare anything against EDFM's data; the app shows only what your own game has
  reported. Nobody gets their exploration spoiled because EDFM already knows the
  answer. See [docs/SPOILERS.md](docs/SPOILERS.md).
- **Never guess.** A value the journal did not provide is rendered `Unknown`.
  Field presence was measured across a 197,164-line corpus; anything below 100%
  is typed optional. See [docs/JOURNAL.md](docs/JOURNAL.md).
- **Raw is never discarded.** Normalization is additive, so a mapping mistake can
  be corrected later without having lost the observation.
- **Read-only with respect to the game.** No memory access, no DLL injection, no
  input automation, no botting.
- **Secrets stay server-side.** The desktop client is untrusted and never holds
  Discord webhooks, database credentials or administrative keys.

---

# Development

Everything below is for working on the Companion. If you just want to use it,
the [download](#download) above is all you need.

## Building from source

Requires **Node.js 20+** and **Rust stable** with the MSVC toolchain.

```bash
npm install
```

```bash
npm run tauri dev --workspace @edfm/desktop
```

To produce installers locally:

```bash
npm run tauri build --workspace @edfm/desktop
```

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a version tag is pushed, so cutting one is `git tag v0.1.0 && git push origin v0.1.0`.

## Tests

```bash
npm test --workspaces --if-present
```

Tests needing PostgreSQL skip unless `EDFM_TEST_DSN` is set, and refuse to run
against a database not named for testing — they `TRUNCATE`, and pointing them at
the development database while the EDDN worker was ingesting into it wiped a
table mid-run.

```bash
createdb edfm_test
```

## Validating against a game update

Elite changes. After any update, re-measure rather than assuming:

```bash
pwsh scripts/profile-journal.ps1 -Events Docked,MissionAccepted
```

Any field that drops below 100% presence must become optional in the parser. The
corpus tests replay your real journals and fail if parsing regresses; they skip
automatically on machines without a journal folder. This is not theoretical — it
is how `ApproachSettlement` was found to fire for Guardian ruins, which had been
quietly polluting the research corpus.

## Repository layout

```
apps/desktop         Tauri 2 + React/TypeScript client
packages/
  elite-journal      Journal engine: tailer, parser, normalizer, state, replay
  context            Deterministic context rules
  missions           Mission tracking and delivery progress
  verification       Evidence model, spoiler gating, comparison engine
  research           Research framework and the settlement-materials project
  logistics          Market confidence, sourcing plans, construction projects
  plugins            Plugin manifest schema and validation
services/
  api                Backend API: reference data, submissions, notification
  eddn-worker        EDDN ingestion, Python
docs/                Architecture and subsystem documentation
scripts/             Journal profiling tooling
```

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack decisions and why, component boundaries, risks |
| [JOURNAL.md](docs/JOURNAL.md) | Measured journal behaviour, field presence rates, edge cases |
| [PRIVACY.md](docs/PRIVACY.md) | What is stored, what is sent, what never leaves the machine |
| [SPOILERS.md](docs/SPOILERS.md) | Discovery gating and how spoiler safety is enforced |
| [VERIFICATION.md](docs/VERIFICATION.md) | Verification engine, evidence model, discrepancy lifecycle |
| [API.md](docs/API.md) | Backend endpoints, identity hashing, notification rules |
| [DISCORD.md](docs/DISCORD.md) | Forum reporting, duplicate policy, tag configuration |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | How the API and EDDN worker are hosted and updated |
| [RELEASING.md](docs/RELEASING.md) | Release process, the code-signing gap, checksums and provenance |
| [ACTIVITY-JOURNAL.md](docs/ACTIVITY-JOURNAL.md) | The commander field journal: what is recorded, and what the journal cannot prove |
| [RESEARCH.md](docs/RESEARCH.md) | Research framework, session model, data-quality rules |
| [LOGISTICS.md](docs/LOGISTICS.md) | Confidence engine, sourcing planner, construction projects |
| [INTEGRATIONS.md](docs/INTEGRATIONS.md) | EDDN, EDSM, Inara, EDAstro: what each sends, and where credentials live |
| [PLUGINS.md](docs/PLUGINS.md) | Installing and writing plugins, and why they are safe |
| [EXTENSIONS.md](docs/EXTENSIONS.md) | Extension architecture: tiers, threat model, API boundaries, roadmap |
| [EDDN.md](docs/EDDN.md) | EDDN ingestion, schemas, normalization decisions |
| [OVERLAY.md](docs/OVERLAY.md) | Overlay design and the no-injection boundary |
| [CONTEXT.md](docs/CONTEXT.md) | Context rules and how they are evaluated |
| [MISSIONS.md](docs/MISSIONS.md) | Mission tracking and delivery progress |

## Licence

MIT — see [LICENSE](LICENSE).

The overlay was written from scratch against the Win32 API rather than derived
from EDMCOverlay, specifically so this project was free to choose a permissive
licence.

Elite Dangerous is a trademark of Frontier Developments plc. This project is
unofficial and not affiliated with or endorsed by Frontier Developments.
