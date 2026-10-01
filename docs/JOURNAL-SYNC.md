# EDFM Commander Journal sync

Optional, off by default, and **push-only in Phase 1**: new derived Activity
Journal entries go up to your own EDFM account. Nothing comes back down, because
the deployed API has no read endpoint — see *Limitations*.

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

## What Phase 1 synchronises

**New activity only.** A watermark is recorded the moment you connect, and only
entries that happened at or after it are uploaded.

Connecting an account is not consent to upload your back catalogue: that is a
separate decision with its own weight, and it is deliberately deferred to Phase 2.
Your existing journal stays on this machine, untouched.

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

## Limitations

- **Push-only.** The deployed API has `/status` and `/batch` and no read
  endpoint, so EDFMC uploads new derived entries and nothing else. Historical
  backfill and cross-device restore need functionality that does not exist yet.
- **No history upload.** Deliberate; see Phase 2 below.
- **No session grouping.** The server supports `sessionId`, but EDFMC does not
  populate sessions yet — an automatic boundary rule would be a guess presented
  as a fact, which this project avoids.
- **5xx responses have no defined shape.** The extension catches only its own
  validation errors, so a database or runtime failure returns whatever MediaWiki
  produces. Those are treated as retryable and their contents are never shown.

---

## Phase 2, deferred

The architecture leaves room for an explicit action — *Sync existing Activity
Journal* — without replacing the queue. What it would add:

- Historical backfill behind a deliberate choice, with progress reporting
- Resumable batching for a large history
- Optional date or category ranges

Nothing in Phase 1 blocks it. The watermark is the only thing standing between
the existing journal and the server, and a backfill would simply enqueue behind
it.
