/**
 * EDFM Commander Journal sync, at the application boundary.
 *
 * The contract-level rules are covered in `@edfm/integrations`. What is asserted
 * here is what the *app* must never do: upload without being asked, let a
 * credential reach JavaScript, cross commanders, or put a token in a log.
 *
 * Several are source guards. The properties are absences, and an absence has no
 * call to assert — what can be asserted is that nothing in the sync path
 * reaches for the thing it must not touch.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Companion } from '../src/lib/companion.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const companionSrc = readFileSync(join(SRC, 'lib', 'companion.ts'), 'utf8');
const uiSrc = readFileSync(join(SRC, 'JournalSync.tsx'), 'utf8');
const rustSrc = readFileSync(
  fileURLToPath(new URL('../src-tauri/src/edfm_journal.rs', import.meta.url)),
  'utf8',
);
const rustEdsmSrc = readFileSync(
  fileURLToPath(new URL('../src-tauri/src/edsm.rs', import.meta.url)),
  'utf8',
);

/** Just the sync section, so a match elsewhere cannot mask a real finding. */
const syncSection = companionSrc.slice(
  companionSrc.indexOf('EDFM journal sync */'),
  companionSrc.indexOf('screenshots */'),
);

describe('the connection starts off', () => {
  it('is not connected until a token is stored', () => {
    const sync = new Companion().snapshot().journalSync;
    expect(sync.state).toBe('not-connected');
    expect(sync.hasCredential).toBe(false);
    expect(sync.pending).toBe(0);
    expect(sync.failed).toBe(0);
    expect(sync.lastSuccessAt).toBeNull();
  });

  it('has no watermark, so nothing is eligible to upload', () => {
    // The Phase 1 boundary. Without a watermark `isWithinPhaseOne` admits
    // nothing, so a disconnected app cannot queue a single entry.
    expect(new Companion().snapshot().journalSync.syncingSince).toBeNull();
  });
});

describe('the token never reaches JavaScript', () => {
  it('has no command that reads a credential back', () => {
    /*
     * The architecture this rests on. The authenticated request is made in
     * Rust, reading the token straight from the Windows Credential Manager, so
     * it cannot reach a log line, an error message or a screenshot.
     */
    expect(syncSection).not.toContain('credential_get');
    expect(syncSection).not.toContain('read_secret');
    // The frontend writes and clears; it never fetches.
    expect(syncSection).toContain('credentialSet(');
    expect(syncSection).toContain('credentialClear(');
  });

  it('sends the body to Rust and never the token', () => {
    // `edfm_journal_batch` takes the JSON document only.
    /*
     * The call carries the JSON document and nothing else. A `token:` argument
     * would mean the secret had been read into JavaScript to be passed along.
     */
    const call = /invoke<[^>]*>\('edfm_journal_batch',\s*\{([^}]*)\}/.exec(syncSection);
    expect(call, 'the batch call could not be found').toBeTruthy();
    expect(call![1]).toContain('body:');
    expect(call![1]).not.toMatch(/token|secret|bearer/i);
    // The header is built in Rust; the frontend never names it.
    expect(syncSection).not.toMatch(/Authorization/i);
  });

  it('keeps the token out of the UI after it is stored', () => {
    /*
     * The field is cleared on both paths -- success and failure -- so a token
     * cannot linger on screen, and nothing reads one back to display.
     */
    expect(uiSrc).toContain("setToken('')");
    // Masked while typing: this gets filled during streams and screen shares.
    expect(uiSrc).toContain('type="password"');
  });

  it('never logs anything that could carry the token', () => {
    /*
     * The message may say the word "token" — "Could not store the token" is
     * exactly what a commander needs to read. What must never appear is a token
     * *value*, so it is the structured payload that gets checked.
     */
    const logLines = syncSection.split('\n').filter((line) => line.includes('logger.'));
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      const payload = /\{([^}]*)\}/.exec(line);
      if (payload) {
        expect(payload[1], line).not.toMatch(/token|secret|bearer|trimmed/i);
      }
    }
  });

  it('builds transport errors from categories, not from error values', () => {
    // A transport error can carry the request URL; these strings reach a log.
    for (const reason of ['timeout', 'connection-failed', 'no-credential']) {
      expect(rustSrc).toContain(`"${reason}"`);
    }
  });
});

describe('what is uploaded, and what is not', () => {
  it('sends derived entries and never raw journal material', () => {
    /*
     * The boundary the whole feature is built around:
     *   Elite journal -> parser -> durable entry -> serializer -> EDFM
     * never
     *   raw Frontier event -> EDFM
     */
    expect(syncSection).toContain('this.activityEntries.filter');
    // No path from the raw event stream into the sync queue.
    expect(syncSection).not.toContain('event.source.raw');
    expect(syncSection).not.toContain('NormalizedEvent');
  });

  it('uploads nothing from before the connection', () => {
    // §9, enforced at the point entries are queued.
    expect(syncSection).toContain('isWithinPhaseOne');
    expect(syncSection).toContain('this.journalWatermark');
  });

  it('never queues anything while disconnected', () => {
    expect(syncSection).toMatch(/if \(this\.journalState === 'not-connected'\) return;/);
  });

  it('does not offer a backfill, which is Phase 2', () => {
    // Deliberately absent: uploading a back catalogue is its own decision.
    expect(uiSrc).not.toMatch(/sync existing/i);
    expect(uiSrc).not.toMatch(/backfill/i);
  });

  it('never sends screenshots, notes or saved items', () => {
    for (const forbidden of ['screenshot', 'filePath', 'note']) {
      expect(syncSection.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('commander scoping', () => {
  it('scopes every queue statement to the active commander', () => {
    /*
     * Commander A's activity must never upload under Commander B's token. The
     * queue is read, written, retried and deleted by `(integration, id,
     * commander_fid)` throughout.
     */
    const statements = syncSection.match(/integration_queue[\s\S]*?`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql, sql.slice(0, 80)).toContain('commander_fid');
    }
  });

  it('only sends entries belonging to the active commander', () => {
    // Belt and braces: the rows are scoped, and the entries are checked again.
    expect(syncSection).toContain('e.commanderFid === fid');
  });

  it('keys the watermark and last-success per commander', () => {
    // Two people share a machine, not an account.
    expect(syncSection).toContain('this.discoveryFid ?? ');
    expect(syncSection).toMatch(/edfm-journal\.\$\{suffix\}\.\$\{/);
  });
});

describe('failure behaviour', () => {
  it('stops syncing on an invalid credential instead of hammering the server', () => {
    /*
     * A dead token must stop authenticated syncing rather than being retried:
     * it will never start working, and repeating the request is both useless
     * and rude to the server.
     */
    expect(syncSection).toContain("'needs-attention'");
    expect(syncSection).toMatch(/invalid-credential[\s\S]{0,400}journalState = 'needs-attention'/);
    // And `Sync now` cannot be pressed in that state.
    expect(uiSrc).toMatch(/disabled=\{[^}]*needs-attention/);
  });

  it('marks nothing as synced when the response cannot be read', () => {
    /*
     * §27. A 200 whose body is unreadable acknowledged nothing, so everything
     * stays queued rather than being silently dropped.
     */
    expect(syncSection).toMatch(/parseBatchOutcome\(body\)/);
    expect(syncSection).toMatch(/outcome === null[\s\S]{0,400}backoffJournal/);
  });

  it('stores the retry delay on the row so it survives a restart', () => {
    expect(syncSection).toContain('next_attempt_at');
    expect(syncSection).toContain('attempts');
  });

  it('never blocks journal ingestion on the network', () => {
    // Queued without awaiting: syncing a record of the game must not gate
    // reading it.
    expect(companionSrc).toContain('void this.enqueueJournalEntries(activity)');
  });
});

describe('what the UI will not claim', () => {
  it('does not say disconnecting revokes the token', () => {
    // Only EDFM can revoke it; claiming otherwise would leave a commander
    // believing a live credential was dead.
    expect(uiSrc).toMatch(/does not revoke/i);
    expect(uiSrc).toMatch(/Manage or revoke token on EDFM/);
  });

  it('does not imply connecting publishes anything', () => {
    // Visibility is the website's, and Private is the server default.
    expect(uiSrc).toMatch(/managed on the website/i);
    expect(uiSrc).not.toMatch(/make (it )?public/i);
  });

  it('says plainly that history is not uploaded', () => {
    expect(uiSrc).toMatch(/Only activity recorded after you connected/i);
  });

  it('never asks for an EDFM password', () => {
    /*
     * The only mention of a password is the sentence telling the commander a
     * token is not one. There is no field that would collect it.
     */
    expect(uiSrc).toMatch(/not your EDFM password/i);
    const mentions = uiSrc.match(/password/gi) ?? [];
    // One in that sentence, one as the masked input type. Nothing else.
    expect(mentions.length).toBeLessThanOrEqual(2);
    expect(uiSrc).not.toMatch(/your password|enter.{0,20}password|EDFM account password/i);
  });
});

describe('the links point somewhere real', () => {
  it('uses the special page the wiki actually registers', () => {
    /*
     * The first version of this pointed at `Special:JournalSync`, which does
     * not exist, and sent commanders to "No such special page". The wiki
     * registers `Special:CommanderJournal`, `Special:CommanderJournalSync` and
     * `Special:CommanderJournalExport`; the sync one is where tokens are made.
     *
     * Pinned here because a wrong link fails silently from this side -- the app
     * opens a browser and never learns what loaded.
     */
    expect(uiSrc).toContain('https://edfieldmanual.com/wiki/Special:CommanderJournalSync');
    expect(uiSrc).not.toContain('Special:JournalSync"');
    expect(uiSrc).not.toMatch(/Special:JournalSync'/);
  });

  it('sends every outbound link over https to the real host', () => {
    const urls = uiSrc.match(/https?:\/\/[^'"`\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, url).toMatch(/^https:\/\/edfieldmanual\.com\//);
    }
  });
});

/* ----------------------------------------------------------------- EDDN */

const eddnSection = companionSrc.slice(
  companionSrc.indexOf('EDDN */'),
  companionSrc.indexOf('EDFM journal sync */'),
);

describe('EDDN publishes only when switched on', () => {
  it('queues nothing while the integration is off', () => {
    /*
     * The promise the Connections screen makes. Enforced where entries are
     * queued rather than where they are sent, so switching EDDN off does not
     * leave a queue quietly filling up behind it.
     */
    expect(eddnSection).toMatch(/if \(!this\.integrationState\.eddn\.enabled\) return;/);
    expect(eddnSection).toMatch(/if \(!INTEGRATIONS\.eddn\.implemented\) return;/);
  });

  it('rejects all but the seven schema events before building anything', () => {
    // The cheap check first: this runs on every journal line.
    const guard = eddnSection.indexOf('EDDN_JOURNAL_EVENTS.includes');
    const build = eddnSection.indexOf('buildEddnMessage');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(build);
  });

  it('audits every message again before it is stored', () => {
    /*
     * EDDN is public and permanent. The builder already sanitises; this is the
     * last point at which a mistake is still private.
     */
    expect(eddnSection).toContain('auditEddnMessage(message)');
    expect(eddnSection).toMatch(/problems\.length > 0[\s\S]{0,200}return;/);
  });

  it('refuses to invent anything the game did not report', () => {
    // No position, no system address, no game build means no message. EDDN
    // would rather have nothing than a record with a guessed coordinate.
    expect(eddnSection).toMatch(/if \(!isKnown\(s\.starSystem\)[\s\S]{0,120}return null;/);
    expect(eddnSection).toMatch(/if \(!isKnown\(s\.commander\)[\s\S]{0,120}return null;/);
  });

  it('omits the Odyssey flag rather than sending false', () => {
    // The spec is emphatic: absent is not false.
    expect(eddnSection).toMatch(/isKnown\(s\.odyssey\) \? \{ odyssey: s\.odyssey \} : \{\}/);
  });

  it('keys the queue on the journal event id, so a replay cannot double-publish', () => {
    // `sourceFile:byteOffset`, stable across restart and replay, with an
    // INSERT OR IGNORE behind it.
    expect(eddnSection).toContain('INSERT OR IGNORE INTO integration_queue');
    expect(eddnSection).toContain('event.source.provenance.eventId');
  });

  it('never sends on the ingest path', () => {
    /*
     * A slow upload must not delay reading the journal. Events are queued, and
     * a timer drains the queue separately.
     */
    expect(eddnSection).toContain('setInterval');
    expect(eddnSection).not.toMatch(/observeForEddn[\s\S]{0,400}await this\.postToEddn/);
  });

  it('retries the network but not a schema rejection', () => {
    // A 400 is identical however often it is sent; a gateway error is not.
    expect(eddnSection).toMatch(/verdict\.kind === 'permanent' \? 'rejected' : 'retry'/);
    expect(eddnSection).toMatch(/catch \{[\s\S]{0,160}return 'retry';/);
  });
});

/* ----------------------------------------------------------------- EDSM */

const edsmSection = companionSrc.slice(
  companionSrc.indexOf('EDSM */'),
  companionSrc.indexOf('EDDN */'),
);

describe('EDSM submits only when configured', () => {
  it('queues nothing while off, or without a key', () => {
    expect(edsmSection).toMatch(/if \(!this\.integrationState\.edsm\.enabled\) return;/);
    expect(edsmSection).toMatch(/if \(!this\.integrationState\.edsm\.hasCredential\) return;/);
  });

  it('honours the discard list EDSM publishes', () => {
    // 141 event names it has explicitly asked clients not to send.
    expect(edsmSection).toContain('isDiscardedByEdsm(event.source.event');
    expect(edsmSection).toContain('parseEdsmDiscard');
  });

  it('filters nothing when the discard list could not be fetched', () => {
    // An empty set filters nothing: guessing an event is unwanted would lose it.
    expect(edsmSection).toMatch(/if \(raw\.status !== 200\) return;/);
  });

  it('never reads the API key into JavaScript', () => {
    /*
     * The key travels from the credential store into the form body inside Rust.
     * The frontend hands over public fields only.
     */
    const start = edsmSection.indexOf("'edsm_submit'");
    expect(start, 'the submit call could not be found').toBeGreaterThan(-1);
    // The whole payload it hands over: public fields only.
    const payload = edsmSection.slice(start, start + 800);
    expect(payload).not.toMatch(/api_?key/i);
    expect(payload).not.toMatch(/secret/i);
    expect(edsmSection).not.toContain('credential_get');
    // The key is read on the Rust side, from the credential store.
    expect(rustEdsmSrc).toContain('read_secret(INTEGRATION)');
  });

  it('judges the outcome by msgnum, never by the HTTP status', () => {
    /*
     * The finding this is built around: EDSM answers HTTP 200 even when it
     * accepted nothing. Classifying on the status code would mark every
     * failure a success and silently discard the commander's log.
     */
    expect(edsmSection).toContain('parseEdsmResponse(parsed)');
    expect(edsmSection).not.toMatch(/raw\.status === 200\s*\)\s*\{[\s\S]{0,120}DELETE FROM integration_queue/);
  });

  it('stops rather than retrying a rejected credential', () => {
    const at = edsmSection.indexOf("outcome.kind === 'credential'");
    expect(at).toBeGreaterThan(-1);
    // Only this branch. A fixed window would run into the retry block below it
    // and find the `backoffQueue` that belongs there, not here.
    const branch = edsmSection.slice(at, edsmSection.indexOf('return;', at) + 'return;'.length);
    // Reports it and stops: no backoff, no resend. A key problem will not fix
    // itself by being retried.
    expect(branch).toContain('recordIntegrationError');
    expect(branch).toContain('return;');
    expect(branch).not.toContain('backoffQueue');
  });

  it('keeps an entry EDSM did not answer for', () => {
    // Per-entry results are matched by position; a missing one stays queued
    // rather than being assumed delivered.
    expect(edsmSection).toMatch(/if \(result === undefined\) continue;/);
  });

  it('keys the queue on the journal event id, so a replay cannot resubmit', () => {
    expect(edsmSection).toContain('INSERT OR IGNORE INTO integration_queue');
    expect(edsmSection).toContain('event.source.provenance.eventId');
  });
});

describe('the connection survives a restart', () => {
  it('reloads the journal connection once the commander is known', () => {
    /*
     * The bug this covers: the FID only arrives from the game, after startup.
     * `loadJournalSync` ran during bootstrap with no commander, read the
     * watermark and last-success under an "unknown" key, and was never run
     * again -- so a connected account came back looking unconfigured and
     * nothing was ever eligible to sync.
     */
    const swap = companionSrc.slice(
      companionSrc.indexOf('private async swapDiscoveryCommander'),
      companionSrc.indexOf('Commander changed; discovery state swapped'),
    );
    expect(swap.length).toBeGreaterThan(0);
    expect(swap).toContain('loadJournalSync()');
    // The other per-commander state is reloaded there too; this belongs with it.
    expect(swap).toContain('loadIntegrationState()');
    expect(swap).toContain('loadScreenshotSettings()');
  });

  it('does not read per-commander settings under a placeholder key', () => {
    // Reading under "unknown" returns nothing while looking like a real answer.
    const load = companionSrc.slice(
      companionSrc.indexOf('private async loadJournalSync'),
      companionSrc.indexOf('private async checkJournalStatus'),
    );
    expect(load).toMatch(/if \(this\.discoveryFid !== null\)/);
  });

  it('keeps the credential check independent of the commander', () => {
    /*
     * The token is stored once per machine, not per commander, so whether one
     * exists is answerable before the game has said who is playing.
     */
    const load = companionSrc.slice(
      companionSrc.indexOf('private async loadJournalSync'),
      companionSrc.indexOf('private async checkJournalStatus'),
    );
    const guard = load.indexOf('if (this.discoveryFid !== null)');
    const check = load.indexOf("credentialPresent('edfm-journal')");
    expect(check).toBeGreaterThan(guard);
    // Outside the guard: the closing brace of the if-block comes first.
    expect(load.slice(guard, check)).toContain('}');
  });
});

describe('no build artefacts leaked into the source', () => {
  it('has no template placeholders left in comments', () => {
    /*
     * Several files were generated through a templating script, and three ended
     * up with a literal `""" + DASH + """` in a doc comment. It compiles, being inside a
     * comment, which is exactly why it survived unnoticed.
     */
    for (const src of [companionSrc, uiSrc, rustSrc, rustEdsmSrc]) {
      expect(src).not.toContain('+ DASH +');
      expect(src).not.toMatch(/"""\s*\+/);
    }
  });
});
