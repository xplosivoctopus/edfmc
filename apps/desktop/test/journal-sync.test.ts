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
const journalUiSrc = readFileSync(join(SRC, 'Journal.tsx'), 'utf8');
/**
 * The same source with runs of whitespace collapsed.
 *
 * Prose in JSX is wrapped by the formatter, so a sentence the commander reads as
 * one line is several in the file. Asserting on the rendered wording rather than
 * on where the line breaks fall means reformatting the file cannot fail a test
 * about what it says.
 */
const uiProse = uiSrc.replace(/\s+/g, ' ');
const journalProse = journalUiSrc.replace(/\s+/g, ' ');
const rustSrc = readFileSync(
  fileURLToPath(new URL('../src-tauri/src/edfm_journal.rs', import.meta.url)),
  'utf8',
);
const rustEdsmSrc = readFileSync(
  fileURLToPath(new URL('../src-tauri/src/edsm.rs', import.meta.url)),
  'utf8',
);

/**
 * One named section of `companion.ts`, bounded by the next section marker.
 *
 * The boundaries used to be written out by hand — from the EDDN marker to the
 * journal-sync one — which quietly broke the moment a new section was added
 * between two existing ones: the slice grew to swallow it, and a guard
 * asserting an ABSENCE over that slice then either failed for a reason that had
 * nothing to do with it or, worse, kept passing while covering code it was never
 * written to cover. Deriving the end from "wherever the next marker is" means a
 * section is exactly itself however the file is reorganised.
 */
const MARKER = /^ {2}\/\* -+ (.+?) \*\/$/gm;
const BOUNDS = (() => {
  const found: Array<{ name: string; at: number; bodyAt: number }> = [];
  for (const m of companionSrc.matchAll(MARKER)) {
    found.push({ name: m[1]!, at: m.index!, bodyAt: m.index! + m[0]!.length });
  }
  return found;
})();

function section(name: string): string {
  const i = BOUNDS.findIndex((b) => b.name === name);
  if (i === -1) throw new Error(`no section marker named ${name} in companion.ts`);
  const end = BOUNDS[i + 1]?.at ?? companionSrc.length;
  return companionSrc.slice(BOUNDS[i]!.bodyAt, end);
}

/*
 * The part that talks to EDFM. Several guards below assert that nothing in it
 * reaches for a credential or a raw journal event, so it matters that this is
 * the sync path and not its neighbours.
 *
 * `backfill` is included deliberately: uploading a history is sending, so it is
 * held to the same rules. Replaying journal files is NOT included, and is kept
 * in its own section outside this one for exactly that reason -- it is the one
 * path here that handles raw events, and folding it in would make the
 * raw-event guards vacuous.
 */
const syncSection = section('EDFM journal sync') + section('backfill');
const rebuildSection = section('rebuilding activity history');

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
     *
     * Asserted as an absence over the sending path, which is why that path is
     * sliced by marker rather than by hand. The one place raw events ARE
     * handled -- replaying files to rebuild local history -- sends nothing and
     * lives outside this section, and the test below holds it to that.
     */
    expect(syncSection).not.toContain('event.source.raw');
    expect(syncSection).not.toContain('NormalizedEvent');
    expect(syncSection).not.toContain('replayFile');
  });

  it('resolves queued ids against the table, not the screen', () => {
    /*
     * This was a real loss of data, not a style point. Queued ids were looked
     * up in `activityEntries`, which is the most recent 500 rows held for the
     * timeline -- so anything older was "not found" and its queue row was
     * DELETED as unsendable. The queue is durable, so what it refers to has to
     * be read from somewhere equally durable.
     */
    expect(syncSection).toContain('loadActivityByIds');
    expect(syncSection).not.toContain('this.activityEntries.filter');
    // The lookup that replaced it is a query, bounded and commander-scoped.
    expect(companionSrc).toMatch(
      /private async loadActivityByIds\([\s\S]{0,800}FROM activity_entries[\s\S]{0,80}commander_fid = \$1/,
    );
  });

  it('uploads nothing from before the connection', () => {
    // §9, enforced at the point entries are queued.
    expect(syncSection).toContain('isWithinPhaseOne');
    expect(syncSection).toContain('this.journalWatermark');
  });

  it('never queues anything while disconnected', () => {
    expect(syncSection).toMatch(/if \(this\.journalState === 'not-connected'\) return;/);
  });

  it('queues a back catalogue only when explicitly asked', () => {
    /*
     * Automatic queueing is watermarked; the only path past it is
     * `backfillJournalSync`, which nothing calls on its own. So the absence
     * that matters is a caller: if ingest, startup or a timer could reach it,
     * connecting an account would quietly upload a commander's history.
     */
    expect(syncSection).toContain('backfillJournalSync');
    expect(companionSrc).not.toMatch(/void this\.backfillJournalSync/);
    expect(companionSrc).not.toMatch(/await this\.backfillJournalSync/);
    // Reached from the UI, and only from a click.
    expect(uiSrc).toContain('snap.backfillJournalSync');
    expect(uiSrc).toMatch(/onClick=\{\(\) => void upload\(\)\}/);
  });

  it('never sends screenshots, notes or saved items', () => {
    for (const forbidden of ['screenshot', 'filePath', 'note']) {
      expect(syncSection.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('commander scoping', () => {
  it('scopes every queue statement that reads, sends or mutates', () => {
    /*
     * Commander A's activity must never upload under Commander B's token, so
     * the queue is read, written, retried and deleted by
     * `(integration, id, commander_fid)` throughout.
     *
     * This asserted it of EVERY statement mentioning the table, which was too
     * blunt by exactly one: the preview's `NOT EXISTS` probe matches on
     * `(integration, id)` ON PURPOSE, because that pair is the table's PRIMARY
     * KEY and the probe's job is to predict what an `INSERT OR IGNORE` will
     * collide on. Scoping it made the preview disagree with the insert and
     * overcount what would be sent.
     *
     * The exemption is narrow and named rather than general: a `SELECT 1`
     * existence probe decides a COUNT, transmits nothing, and returns nothing
     * about another commander. Anything that reads a payload, sends, deletes or
     * updates still has to be scoped, and still is.
     */
    /*
     * Each window starts BEFORE the table name, so the verb in front of it is
     * visible. Slicing from the table name onwards hid the `SELECT 1 FROM`
     * that identifies the probe, and the exemption below silently never
     * applied -- the test failed on the statement it was written to permit.
     */
    const statements: string[] = [];
    for (const m of syncSection.matchAll(/integration_queue/g)) {
      const from = Math.max(0, m.index! - 32);
      statements.push(syncSection.slice(from, syncSection.indexOf('`', m.index!)));
    }
    expect(statements.length).toBeGreaterThan(0);

    let exempt = 0;
    for (const sql of statements) {
      if (/SELECT 1 FROM integration_queue/.test(sql)) {
        exempt += 1;
        continue;
      }
      expect(sql, sql.slice(0, 120)).toContain('commander_fid');
    }
    // Pinned, so a new unscoped statement cannot hide behind the exemption.
    expect(exempt, 'exactly one existence probe is exempt').toBe(1);
  });

  it('only sends entries belonging to the active commander', () => {
    /*
     * Both halves are scoped, not just the queue. The queue read selects on
     * `commander_fid`, and the lookup that turns those ids into entries is
     * itself scoped -- so an id that somehow named another commander's entry
     * would resolve to nothing rather than being sent under this token.
     */
    expect(syncSection).toMatch(/SELECT id FROM integration_queue[\s\S]{0,200}commander_fid = \$1/);
    expect(syncSection).toMatch(/loadActivityByIds\(fid,/);
  });

  it('keys the watermark and last-success per commander', () => {
    // Two people share a machine, not an account.
    expect(syncSection).toContain('this.discoveryFid ?? ');
    expect(syncSection).toMatch(/edfm-journal\.\$\{suffix\}\.\$\{/);
  });

  it('attributes replayed history to whoever played it', () => {
    /*
     * A rebuild reads months of files that may span two commanders on one
     * machine. The engine is told who was playing from the event's own
     * provenance as it goes, and only the signed-in commander's entries are
     * kept -- so a rebuild can neither misattribute history nor write somebody
     * else's into the table on their behalf.
     */
    expect(rebuildSection).toContain('event.source.provenance.fid');
    expect(rebuildSection).toContain('engine.setCommander(seen)');
    expect(rebuildSection).toContain('e.commanderFid === fid');
  });
});

describe('rebuilding local history', () => {
  it('produces nothing without a commander, rather than nothing silently', () => {
    /*
     * The bug this replaced: the engine was constructed with
     * `commanderFid: null`, and `observe` returns `[]` in that state. So the
     * rebuild read every journal file on disk, recorded not one entry, and
     * reported success. The FID is now required before any file is opened.
     */
    expect(rebuildSection).toMatch(/const fid = this\.discoveryFid;/);
    expect(rebuildSection).toMatch(/if \(fid === null \|\| dir === null\) return empty;/);
    const openAt = rebuildSection.indexOf('listJournalFiles');
    const guardAt = rebuildSection.indexOf('fid === null');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, 'the guard must come before any file is read').toBeLessThan(openAt);
  });

  it('sends nothing at all', () => {
    // Local only. Not a claim about intent: there is no transport in it.
    expect(rebuildSection).not.toContain('invoke<');
    expect(rebuildSection).not.toMatch(/edfm_journal_(batch|status)/);
    expect(rebuildSection).not.toContain('integration_queue');
    expect(rebuildSection).not.toContain('fetch');
  });

  it('leaves the live checkpoint and the live engine alone', () => {
    /*
     * Two separate ways this could wreck a running session. Moving the
     * checkpoint backwards would replay months of state transitions over the
     * live app; pushing historical events through the live engine would leave
     * it believing the commander is wherever they were in June.
     */
    expect(rebuildSection).not.toContain('saveCheckpoint');
    expect(rebuildSection).not.toContain('this.engine');
    expect(rebuildSection).toContain('new ActivityEngine(');
  });

  it('survives a file it cannot read', () => {
    // One corrupt or vanished journal must not abandon the rest of the history.
    expect(rebuildSection).toMatch(/catch \(err\)[\s\S]{0,200}failed \+= 1/);
  });

  it('is offered on the Journal screen, not behind an EDFM connection', () => {
    /*
     * It sends nothing, so requiring an account to reach it would deny a
     * commander who wants their own complete field journal and nothing on any
     * website. The control sits with the thing it rebuilds.
     */
    expect(journalUiSrc).toContain('snap.rebuildActivityHistory');
    expect(journalUiSrc).toContain('snap.cancelActivityRebuild');
    // Not gated on the connection state.
    expect(journalUiSrc).not.toMatch(/journalSync\.state/);
    expect(journalUiSrc).not.toMatch(/hasCredential/);
  });

  it('states on that screen what it cannot recover', () => {
    /*
     * The journals are the only source and the player deletes them. A rebuild
     * that silently returns less than expected reads as a bug in the app rather
     * than a gap in the source.
     */
    expect(journalProse).toMatch(/can only recover what your journal files still contain/i);
    expect(journalProse).toMatch(/Nothing is uploaded by rebuilding/i);
  });

  it('no longer claims the journal is never uploaded', () => {
    /*
     * It said "never uploaded", which stopped being true the moment EDFM
     * Commander Journal existed. A false line on a privacy-adjacent screen
     * discredits the true ones beside it.
     */
    expect(journalProse).not.toMatch(/never uploaded/i);
    expect(journalProse).toMatch(/unless you connect EDFM Commander Journal/i);
  });

  it('keeps journal paths out of the log', () => {
    /*
     * A journal path names a folder under the commander's account and usually
     * their Windows username. The file NAME is enough to identify which file
     * failed.
     */
    const logLines = rebuildSection.split('\n').filter((l) => l.includes('logger.'));
    expect(logLines.length).toBeGreaterThan(0);
    expect(rebuildSection).not.toContain('file.fullPath,');
    expect(rebuildSection).toContain('file: file.fileName');
  });
});

describe('a history upload is not repeated', () => {
  it('records that EDFM acknowledged an entry, because the queue cannot', () => {
    /*
     * An acknowledged row is deleted from the queue -- correct, the queue is
     * not an archive -- which left nothing remembering the entry had gone up.
     * A second upload therefore re-queued the whole history and sent it again,
     * and the preview counted entries the server already held.
     */
    expect(syncSection).toMatch(
      /UPDATE activity_entries SET synced_at[\s\S]{0,200}DELETE FROM integration_queue/,
    );
  });

  it('marks it sent only where it is not already marked', () => {
    // The first acknowledgement is the one that counts; a later `unchanged`
    // must not rewrite the date EDFM first took it.
    expect(syncSection).toContain('AND synced_at IS NULL');
  });

  it('skips acknowledged entries in both the preview and the upload', () => {
    /*
     * Otherwise the count misleads and the work is done twice. Checked over two
     * windows bounded at BOTH ends: the first version of this test sliced each
     * one to the end of the section, so the predicate belonging to the other
     * statement satisfied it and removing either one still passed.
     */
    const between = (from: string, to: string): string => {
      const a = syncSection.indexOf(from);
      const b = syncSection.indexOf(to, a + from.length);
      expect(a, `${from} not found`).toBeGreaterThan(-1);
      expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
      return syncSection.slice(a, b);
    };

    // The preview, up to where the upload begins.
    expect(between('journalBackfillPreview', 'backfillJournalSync')).toContain(
      'a.synced_at IS NULL',
    );
    // The upload, up to the point its queueing statement is done.
    const upload = between('backfillJournalSync', 'const total =');
    expect(upload).toContain('INSERT OR IGNORE INTO integration_queue');
    expect(upload).toContain('a.synced_at IS NULL');
  });

  it('uploads only the categories EDFM accepts, named explicitly', () => {
    /*
     * `landed` is the reason this is a list rather than "everything stored":
     * an entry per touchdown used to be recorded, it was dropped as noise, and
     * those rows are still on disk. A backfill driven by the table would
     * upload hundreds of them.
     */
    expect(companionSrc).toMatch(/const SYNCABLE_SUBTYPES = \[[\s\S]{0,200}\] as const;/);
    expect(companionSrc).not.toMatch(/SYNCABLE_SUBTYPES[\s\S]{0,80}'landed'/);
    expect(syncSection).toContain('a.subtype IN (${holes})');
  });

  it('paces itself and stops when it stops making progress', () => {
    /*
     * A backfill is the only sustained traffic this client produces. It also
     * must not spin: everything left may be waiting on a stored backoff, and
     * the queue is durable so the next attempt resumes from there.
     */
    expect(syncSection).toContain('BACKFILL_PAUSE_MS');
    expect(syncSection).toMatch(/if \(this\.journalPending >= before\)/);
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

  it('says plainly that history is not uploaded on its own', () => {
    expect(uiProse).toMatch(/Only activity recorded after you connected/i);
    expect(uiProse).toMatch(/stays on this machine until you choose to send it/i);
    expect(uiProse).toMatch(/Nothing from before you connected has been uploaded/i);
  });

  it('does not claim more will go up than the server accepts', () => {
    // Which categories travel is not guessable from the app, so it is stated.
    expect(uiProse).toMatch(/those are the categories EDFM accepts/i);
    expect(uiProse).not.toMatch(/complete history|all of your history|every entry/i);
  });

  it('offers no rebuild of its own, because that one is local', () => {
    /*
     * Rebuilding sends nothing, so it belongs on the Journal screen and is
     * available whether or not an EDFM account is connected. Offering it here
     * as well would put a local action behind a connection, and duplicate the
     * control that owns it.
     */
    expect(uiSrc).not.toContain('rebuildActivityHistory');
    expect(uiSrc).not.toContain('cancelActivityRebuild');
    // It points at the screen that does own it.
    expect(uiProse).toMatch(/Journal screen can rebuild your earlier activity/i);
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

const eddnSection = section('EDDN');

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

const edsmSection = section('EDSM');

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
