# EDFM Commander Journal sync

Optional, off by default, and **push-only**: derived Activity Journal entries go
up to your own EDFM account. Nothing comes back down, because the deployed API
has no read endpoint — see *Limitations*.

Two things go up, and they are separate decisions:

- **New activity**, automatically, from the moment you connect.
- **Your existing activity**, only when you ask for it. See *Uploading an
  existing history*.

The boundary, in one line:

```
Elite journal → EDFMC parser → durable Activity Journal entry → serializer → EDFM
```

Never `raw Frontier event → EDFM`. The game's own files stay on your machine.

---

## Getting a token

*Settings → Connections → EDFM Commander Journal → **Open EDFM token page***, which
opens `Special:CommanderJournalSync` on the wiki.

Generate a journal sync token on the website and paste it into the app. Then
press **Connect**.

- **A token is not your EDFM password.** The app never asks for one, and a
  password would not work as a sync credential.
- **The token is shown once**, on the website. The app never displays it again.
- It looks like `edfmj_v1_<22 characters>.<43 characters>`. The app checks that
  shape before storing anything, so an obvious paste accident is a clear message
  rather than a `401` you have to interpret.

---

## How the credential is stored

In the **Windows Credential Manager**, through the same keyring path every other
integration uses. Encrypted at rest by the OS, scoped to your user account, with
no vault password to invent.

**It never enters JavaScript.** There is no command that reads a secret back, and
a test fails the build if one is added. The authenticated HTTP request is made in
Rust: the token goes from the credential store straight into an `Authorization`
header. A secret that reaches a renderer can reach a log line, an error message,
a crash report or a screenshot, so it never gets there.

Redirects are refused outright, so the header cannot be replayed to a plain-HTTP
location.

---

## Connecting

1. The token is stored.
2. `GET /rest.php/edfm-journal/v1/status` is called with it.
3. The response is validated against the real schema — not merely checked for a
   200.
4. Only then does the connection read as **Connected**.

If verification fails, **the credential is removed again** rather than left
behind looking configured. The failure is reported in one of a few safe
categories — invalid or revoked token, EDFM unreachable, EDFM unavailable, or an
unreadable response — never as a raw server body.

---

## What is synchronised automatically

**New activity only.** A watermark is recorded the moment you connect, and only
entries that happened at or after it are uploaded without being asked for.

Connecting an account is not consent to upload your back catalogue: that is a
separate decision with its own weight, and it stays behind an explicit action.
Until you take it, your existing journal stays on this machine, untouched.

The app says so on the card, so it is not left to be assumed.

### Sent

- Derived Activity Journal entries: category, kind, when, system, body
- The entry's structured data, plus its human-readable title and detail
- A stable id per entry, so a retry cannot create a duplicate
- `companionVersion` — the real app version

### Not sent

- **Raw Frontier journal events or files.** The server rejects them too: keys
  normalising to `event`, `raw`, `rawjournal` and similar are refused, and this
  client drops them before they are offered.
- Your EDFM password, which is never asked for
- Screenshot images, or the paths they are stored at
- Notes and saved items
- Any other integration's credential

---

## Stable IDs and idempotency

The server's identity is `(your EDFM account, stable client id)`. The client id
is **the local Activity Journal entry id**, used directly.

That works because the local id was already compatible. Measured across 546 real
entries before anything was written: every one matched the server's identifier
pattern, the longest being 40 characters of the 128 allowed. Deriving a second id
would have been another identity to keep consistent for no gain.

So an exact retry is safe. The server answers `unchanged`, and nothing is
duplicated.

Resending an entry whose content changed returns `updated`. Note that the
server's digest includes `companionVersion`, so the first sync after an app
update will report entries as `updated` rather than `unchanged`. That is the
server's definition, not a bug here.

---

## Queue and retries

Entries are queued in the existing durable per-integration queue — on disk, not
in memory — so pending work survives a restart.

| Outcome | What happens |
|---|---|
| Acknowledged (`created`, `updated`, `unchanged`) | Removed from the queue |
| Rejected for its content | Marked failed; never retried |
| `duplicate_in_batch` | Retried — that is *our* batching mistake, not a bad entry |
| Network failure, 5xx, 429 | Retried with a stored backoff |
| Response unreadable | **Nothing is marked synced**; everything stays queued |

That last row is the rule that matters: an entry counts as synchronised because
the server acknowledged **that entry**, never because the status code was 2xx.

An entry the server never mentioned stays queued too. Re-sending something it
already holds costs an `unchanged`; dropping something it never received loses
the record for good.

Backoff is stored on the row rather than held in a timer, so a wait survives a
restart instead of collapsing into a retry storm. When EDFM asks for a delay with
`Retry-After`, that delay is used.

**Syncing never blocks the game.** Entries are queued without being awaited, so
ingestion, the overlay and everything else carry on if EDFM is slow or down.

---

## Commander scoping

Every queue row, watermark and last-success marker is scoped to the commander's
FID. Commander A's activity can never upload under Commander B.

Switching commander switches the sync scope; pending work stays attached to the
commander it belongs to and is not processed as somebody else's.

One EDFM account is not assumed to be one Elite commander. The server resolves
the owner from the token alone — the app cannot name an owner in a request even
if it wanted to.

---

## If the token stops working

A revoked or invalid token puts the connection into **Needs attention**:

- Authenticated syncing stops. It is not retried, because it will not start
  working and repeating the request is rude to the server.
- Pending entries are **kept**.
- Nothing local is deleted.

Press **Reconnect** and paste a new token.

---

## Disconnect vs revoking

**Disconnect** removes the token from this machine. It does **not** revoke it on
EDFM — only the website can do that, so the app does not claim otherwise. Use
**Manage or revoke token on EDFM** for that.

Your local Activity Journal and queue survive disconnection. It is not a reason
to lose a record of what you did.

---

## Visibility stays on the website

Connecting does not publish anything. Your EDFM journal is **Private** by default,
and whether it is private, unlisted or public is managed on the website.

The app cannot change it. The sync endpoint accepts no visibility field, and the
server sets Private when it first creates a profile.

---

## Uploading an existing history

Two actions, on **two different screens**, and deliberately not one button. One
reads your journal files and writes to this machine; the other sends. "Give me a
complete field journal locally" and "publish my history to EDFM" are different
decisions, and a commander who wants only the first is a reasonable commander.

So the rebuild lives on the **Journal** screen, where it works whether or not an
EDFM account is connected. Only the upload is on the Connections card. Putting
the rebuild there too would have placed a local action behind a connection
nobody needs in order to use it.

### 1. Rebuild local history — on the Journal screen, sends nothing

Activity from before you installed the Companion was never recorded, because
reading the journal is what records it. Live ingest resumes from a single
`(file, offset)` checkpoint and never looks back, so a backfill on its own would
faithfully upload an empty history — **there was nothing locally to back-fill
from.**

So rebuilding replays every journal file still on disk through a *fresh*
Activity Journal engine and records what it finds.

- **It sends nothing.** Local only, and the UI says so.
- **It is safe to run repeatedly.** `replayFile` reproduces byte-identical
  `eventId`s, the entry id *is* that event id, and the insert is
  `INSERT OR IGNORE`, so a second pass writes nothing new.
- **It does not touch the live checkpoint.** That cursor drives current
  commander state; moving it backwards would replay months of state transitions
  over your live session.
- **A fresh engine, not the live one.** Pushing four months of historical events
  through the live engine would leave the app believing you are wherever you
  were in June.
- **History is attributed to whoever played it.** Each event carries the FID
  from its governing `Commander`/`LoadGame` event, so the engine is told who was
  playing as it goes. Only the signed-in commander's entries are kept: writing
  somebody else's history into the table on their behalf is work nobody asked
  for, and they can rebuild their own.

**What it cannot recover.** Only what your journal files still contain. Files you
have deleted, or that were lost to a reinstall or a disk cleanup, hold activity
nothing can recover. Stated rather than implied, because a rebuild that quietly
returns less than you expected looks like a bug in the app rather than a gap in
the source.

### 2. Upload — on the Connections card: explicit, previewed, resumable

The count and the span are shown **before** the upload is offered, so the choice
is made against a real number rather than in the abstract.

- Only `sample-completed`, `signals-detected`, `data-sold` and `footfall` are
  sent. The list is named explicitly rather than taking whatever is in the
  table, because the table outlives the rules: an entry per `landed` used to be
  recorded, it was dropped as noise, and those rows are still on disk. A
  backfill driven by "everything stored" would upload hundreds of them.
- It queues into the same durable per-integration queue, so it survives a
  restart and resumes rather than starting over.
- One batch at a time with a pause between them. A backfill is the only time
  this client sends sustained traffic, so it is paced deliberately rather than
  looping as fast as the server will answer.
- Stopping is safe. Everything still queued goes on a later sync.
- **The watermark is left alone.** It still governs what new activity is queued
  automatically; an upload is a one-off decision, not a change of policy.

### Why `synced_at` exists

An acknowledged entry is deleted from the queue — correct, it is finished work
and the queue is not an archive — but that left **nothing remembering that EDFM
had it**. A second upload therefore re-queued the entire history and sent it
again, and the preview counted entries the server already held. Nothing was
corrupted (the server answers `unchanged`), but it was thousands of needless
requests and a count that misled about what was left to do.

Migration 15 adds `activity_entries.synced_at`, set when the server acknowledges
that entry and before its queue row is removed. The preview and the upload both
skip rows that have it.

Rows written before the migration get `NULL`, meaning *it is not known whether
EDFM has this*. That is the honest value: the first upload after upgrading may
re-send entries the server already holds, and will then record the answer. It is
never the other way round — nothing is marked sent that was not.

---

## Limitations

- **Push-only.** The deployed API has `/status` and `/batch` and no read
  endpoint, so EDFMC uploads and nothing comes back. Cross-device restore needs
  functionality that does not exist yet.
- **No date or category ranges on an upload.** It is all of the syncable
  categories or none. Ranges are a real request and nothing here blocks them;
  they are simply not built.
- **Missions are recorded locally but cannot be sent.** The Activity Journal now
  records a `mission-completed` entry when a mission is handed in, with the
  reward the game paid. EDFM's journal extension allowlists four categories —
  `exobiology`, `exploration`, `mining`, `colonisation` — and `missions` is a
  fifth, so the server would answer `unsupported_category` and the entry would be
  marked permanently rejected. Queueing work that cannot succeed would fill the
  Failed count with entries nothing the commander does can fix, so it is not
  queued at all. Adding the category to the wiki extension and then adding
  `mission-completed` to `SYNCABLE_SUBTYPES` is the whole change; the entries are
  already being recorded and stored against that day.
- **No session grouping.** The server supports `sessionId`, but EDFMC does not
  populate sessions — an automatic boundary rule would be a guess presented as a
  fact, which this project avoids.
- **The queue is keyed `(integration, id)`, not by commander.** Every statement
  that reads, sends, deletes or retries is still scoped to one commander, so
  nothing is ever transmitted under the wrong account. But the *key* is not, so
  if two commanders on one machine ever produced the same entry id, the second
  could not be queued while the first was still pending.

  In practice it is unreachable: the id is the journal event id,
  `sourceFile:byteOffset`, and journal filenames are timestamped per session, so
  two commanders have different files and different ids. It is recorded because
  the preview and the upload have to agree about it, and briefly they did not —
  the preview was scoped to the commander while the upload was an
  `INSERT OR IGNORE` colliding on the key, so the count offered was larger than
  the work performed. Both now match on `(integration, id)`, which is what the
  insert actually does.
- **5xx responses have no defined shape.** The extension catches only its own
  validation errors, so a database or runtime failure returns whatever MediaWiki
  produces. Those are treated as retryable and their contents are never shown.
