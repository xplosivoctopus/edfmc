# Deployment

Status: **live** at `https://api.edfieldmanual.com`.

The API and the EDDN worker run on the same machine as the EDFM wiki, following
the pattern already established there by MeritTracker: a systemd service bound
to loopback, an nginx reverse proxy in front, certbot for TLS, and a dedicated
PostgreSQL role per application.

## What runs where

| | |
|---|---|
| Code | `/var/www/edfm-api` (owner `teejay:www-data`, mode 750) |
| API service | `edfm-api.service` → `127.0.0.1:8787` |
| EDDN worker | `edfm-eddn.service` (no listener; outbound ZeroMQ only) |
| Database | PostgreSQL `edfm`, owned by role `edfm_app` |
| Public entry | nginx `api.edfieldmanual.com` → `127.0.0.1:8787` |
| TLS | Let's Encrypt, auto-renewing |

Deliberately **not** under `/var/www/edwiki`. That is the MediaWiki docroot,
root-owned and served by PHP-FPM; a Node service inside it would be both
unwritable and web-exposed as source.

## Secrets

Everything sensitive lives in two mode-`600` files owned by `teejay`, and
nothing sensitive is in git:

```
/var/www/edfm-api/services/api/.env            # DSN, identity salt, admin token, webhook
/var/www/edfm-api/services/eddn-worker/.env    # DSN only
```

The database password, identity salt and admin token were **generated on the
server** with `openssl rand` and have never been transmitted or displayed. To
read one, `sudo cat` the file on the box.

The worker takes its DSN from `EDFM_DATABASE_URL` in the environment, never from
`--dsn` on the command line: an argument is visible in `ps` to every user on a
shared machine. Verified via `/proc/<pid>/cmdline` — no process on the box has
the DSN in its arguments.

## Deploying a change

The tree is deployed with `git archive`, which ships exactly the committed files
— no `node_modules`, no `.venv`, and no `.env`, because untracked files are not
in the archive:

```bash
git archive --format=tar HEAD | ssh -p <port> <user>@<host> 'tar x -C /var/www/edfm-api'
```

Then, on the server, as needed:

```bash
cd /var/www/edfm-api && npm install --omit=dev --workspaces --include-workspace-root
```

```bash
npm run migrate --workspace @edfm/api && sudo systemctl restart edfm-api edfm-eddn
```

`tsx` is a **production** dependency of `@edfm/api`, not a dev tool: the service
executes TypeScript directly, so `--omit=dev` without it leaves the service
unable to boot.

## Administrative endpoints

`/v1/admin/*` is protected twice over, because either layer alone is thin:

- **In the application** by `EDFM_ADMIN_TOKEN`, compared in constant time. With
  no token configured the routes are never registered; with a wrong token the
  response is `404`, so the route's existence is not confirmed either.
- **In nginx** by `allow 127.0.0.1; deny all;`, so a leaked token is not
  sufficient on its own.

Reach them through an SSH tunnel:

```bash
ssh -p <port> -L 8787:127.0.0.1:8787 <user>@<host>
```

An earlier version also allowed the LAN range. That was removed: LAN traffic
hairpins through the router and arrives as the router's own address, so the rule's
effectiveness depended on NAT behaviour rather than on policy. External traffic
does preserve real client addresses, so rate limiting by IP still works.

## Health

```bash
systemctl status edfm-api edfm-eddn
journalctl -u edfm-api -f
journalctl -u edfm-eddn -f
```

```bash
curl https://api.edfieldmanual.com/v1/health
```

`/v1/stats` gives ingest progress — station, market, submission and discrepancy
counts. If `stations` stops climbing, the worker has stopped; it is
`Restart=always` precisely because a clean exit after an upstream disconnect
still means ingestion has silently stopped.

## Discord

**Enabled.** The webhook is in the API's gitignored `.env` (mode 600) and
`EDFM_DISCORD_ENABLED=true`. Verified from the box after enabling: the test
posted a Forum thread and returned `created`, and the webhook appears nowhere in
the journal.

Forum tag IDs are not configured, so reports post untagged. That is a supported
state rather than a failure -- an unmapped category is dropped and the report
still goes out. Set `EDFM_DISCORD_FORUM_TAGS` when you want them filed; see
[DISCORD.md](DISCORD.md) for how to find the IDs.

Administrative actions run through the SSH tunnel, since `/v1/admin/*` is
loopback-only:

```bash
ssh -p <port> -L 8787:127.0.0.1:8787 <user>@<host>
```

## Notes for next time

- `api.edfieldmanual.com` resolves **directly** to the host, not through
  Cloudflare like `api.xplosivoctopus.com`. That is what let HTTP-01 issuance
  work without touching Cloudflare.
- The host's own resolver answers `edfieldmanual.com` as `127.0.0.1`, so `dig`
  **on the server** is not a reliable check of public DNS. Query `@1.1.1.1`.
- The box already had every runtime needed: Node 20, PostgreSQL 18, Python 3.12,
  nginx, certbot. Nothing new was installed.
