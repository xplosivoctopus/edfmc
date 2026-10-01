/**
 * The EDFM Commander Journal connection card.
 *
 * Two things this screen must never do, both of which it would be easy to do by
 * accident:
 *
 * 1. **Show the token again.** It is written once, into the OS credential store,
 *    and never read back into JavaScript. There is no state here that holds it
 *    after `Connect`.
 * 2. **Imply more than the server does.** Connecting does not publish anything:
 *    journal visibility is Private by default and is managed on the website.
 *    Disconnecting does not revoke the token, because only EDFM can.
 *
 * ## Uploading an existing history
 *
 * Connecting syncs new activity only. Sending a back catalogue is a separate,
 * explicit action, and this screen is where the weight of that decision is
 * carried rather than hidden behind a toggle:
 *
 * - The count and the span are **shown before** the upload is offered, so the
 *   choice is made against a real number.
 * - The local rebuild and the upload are **two different buttons**. One reads
 *   journal files and writes to this machine; the other sends. They are never
 *   combined, because "fix my local history" and "publish my history" are not
 *   the same decision and a commander may well want only the first.
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';

import { parseMediaWikiTimestamp } from '@edfm/integrations';

import type { CompanionSnapshot, JournalConnectionState } from './lib/companion.js';

/**
 * The token page, verified against the live wiki rather than guessed.
 *
 * An earlier version pointed at `Special:JournalSync`, which does not exist and
 * sent commanders to "No such special page". The real special pages the
 * extension registers are `Special:CommanderJournal`,
 * `Special:CommanderJournalSync` and `Special:CommanderJournalExport`.
 */
const TOKEN_PAGE = 'https://edfieldmanual.com/wiki/Special:CommanderJournalSync';

const STATE_LABEL: Record<JournalConnectionState, string> = {
  'not-connected': 'Not connected',
  connected: 'Connected',
  syncing: 'Syncing',
  'needs-attention': 'Needs attention',
  unavailable: 'EDFM unavailable',
};

function ago(iso: string | null): string {
  if (!iso) return 'Never';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const h = Math.round(seconds / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  return new Date(at).toLocaleString();
}

/** A span of activity, worded as a span rather than two bare timestamps. */
function span(oldest: string | null, newest: string | null): string | null {
  const from = oldest ? new Date(Date.parse(oldest)) : null;
  const to = newest ? new Date(Date.parse(newest)) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  const a = from.toLocaleDateString();
  const b = to.toLocaleDateString();
  return a === b ? a : `${a} to ${b}`;
}

export function JournalSync({ snap }: { snap: CompanionSnapshot }) {
  const sync = snap.journalSync;
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);

  /** What a backfill would send. Null until asked for; never assumed. */
  const [preview, setPreview] = useState<{
    entries: number;
    oldest: string | null;
    newest: string | null;
  } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setProblem(null);
    const reason = await snap.connectJournalSync(token);
    // Cleared either way: a token that failed is not worth keeping on screen,
    // and one that worked must not be shown again.
    setToken('');
    setBusy(false);
    if (reason === null) setEntering(false);
    else setProblem(reason);
  }

  async function checkHistory() {
    setUploadResult(null);
    setPreview(await snap.journalBackfillPreview());
  }

  async function upload() {
    setUploadResult(null);
    setUploadProgress({ sent: 0, total: preview?.entries ?? 0 });
    const reason = await snap.backfillJournalSync((sent, total) =>
      setUploadProgress({ sent, total }),
    );
    setUploadProgress(null);
    setUploadResult(reason);
    setPreview(await snap.journalBackfillPreview());
  }

  const connected = sync.state !== 'not-connected';
  const workingOnHistory = sync.rebuilding || sync.backfilling;

  return (
    <section className="card">
      <div className="integration-head">
        <h2>EDFM Commander Journal</h2>
        <span className={`integration-status status-${sync.state}`}>{STATE_LABEL[sync.state]}</span>
      </div>

      <p className="muted">
        Sync new Activity Journal entries with your own EDFM account. This sends what you
        <em> did</em> — never the game files it was derived from.
      </p>

      {!connected && !entering && (
        <>
          <p className="field-hint">
            You will need a journal sync token from the website. It is not your EDFM password,
            and it is shown only once.
          </p>
          <p className="audit-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void openUrl(TOKEN_PAGE).catch(() => undefined)}
            >
              Open EDFM token page
            </button>
            <button type="button" className="primary" onClick={() => setEntering(true)}>
              Connect
            </button>
          </p>
        </>
      )}

      {!connected && entering && (
        <>
          <label className="field">
            <span>EDFM journal sync token</span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="edfmj_v1_…"
              spellCheck={false}
              autoComplete="off"
              // Treated as a secret on screen as well as in storage: this field
              // is often filled while a stream or a screen share is running.
              type="password"
            />
            <span className="field-hint">
              Paste the token generated on edfieldmanual.com. It is stored in the Windows
              Credential Manager and is never shown again.
            </span>
          </label>
          {problem && <p className="note">{problem}</p>}
          <p className="audit-actions">
            <button type="button" className="primary" onClick={() => void connect()} disabled={busy}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setToken('');
                setProblem(null);
                setEntering(false);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </p>
        </>
      )}

      {connected && (
        <>
          {sync.state === 'needs-attention' && (
            <p className="note">
              {sync.message ?? 'The synchronization credential is no longer valid.'} Your entries
              are kept and nothing has been lost.
            </p>
          )}
          {sync.state === 'unavailable' && sync.message && <p className="note">{sync.message}</p>}

          <dl className="queue-grid">
            <div>
              <dt>Pending</dt>
              <dd>{sync.pending}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd>{sync.failed}</dd>
            </div>
            <div>
              <dt>On EDFM</dt>
              <dd>{sync.server?.entryCount ?? '—'}</dd>
            </div>
            <div className="queue-wide">
              <dt>Last successful sync</dt>
              <dd>{ago(sync.lastSuccessAt)}</dd>
            </div>
            {sync.syncingSince && (
              <div className="queue-wide">
                <dt>Syncing activity since</dt>
                <dd>{new Date(sync.syncingSince).toLocaleString()}</dd>
              </div>
            )}
          </dl>

          {/*
            Said plainly rather than left to be discovered: connecting an account
            did not upload the back catalogue, and visibility is not ours to set.
          */}
          <p className="field-hint">
            Only activity recorded after you connected is uploaded automatically. Your existing
            journal stays on this machine until you choose to send it. Who can see your EDFM
            journal — private, unlisted or public — is managed on the website, and connecting
            here changes nothing about it.
          </p>

          <p className="audit-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void snap.syncJournalNow()}
              disabled={
                sync.state === 'syncing' || sync.state === 'needs-attention' || workingOnHistory
              }
            >
              {sync.state === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
            {sync.state === 'needs-attention' && (
              <button type="button" className="primary" onClick={() => setEntering(true)}>
                Reconnect
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => void openUrl(TOKEN_PAGE).catch(() => undefined)}
            >
              Manage or revoke token on EDFM
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void snap.disconnectJournalSync()}
              disabled={workingOnHistory}
            >
              Disconnect
            </button>
          </p>

          <p className="field-hint">
            Disconnecting removes the token from this machine. It does not revoke it on EDFM —
            only the website can do that.
          </p>

          <h3>Your existing activity</h3>

          {/*
            Rebuilding is NOT offered here, and that is the point. It is local
            and sends nothing, so it lives on the Journal screen where it is
            available whether or not an EDFM account is connected. A commander
            who wants a complete field journal on their own machine and nothing
            on any website is a reasonable commander, and putting the rebuild on
            this card would put it behind a connection they do not want.
          */}
          <p className="field-hint">
            Nothing from before you connected has been uploaded. You can send it, and the count
            is shown before anything goes. If there is less here than you expect, the Journal
            screen can rebuild your earlier activity from the journal files still on this
            machine — that step is local and uploads nothing.
          </p>

          <p className="audit-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void checkHistory()}
              disabled={workingOnHistory}
            >
              Check what would be uploaded
            </button>
          </p>

          {preview !== null && preview.entries === 0 && (
            <p className="note">
              There is nothing waiting to upload. Everything EDFM can accept has either been sent
              already or is queued.
            </p>
          )}

          {preview !== null && preview.entries > 0 && (
            <>
              <p className="note">
                {preview.entries} {preview.entries === 1 ? 'entry' : 'entries'} on this machine
                have not been sent to EDFM
                {span(preview.oldest, preview.newest)
                  ? `, spanning ${span(preview.oldest, preview.newest)}`
                  : ''}
                . Uploading adds them to your EDFM journal, which stays private unless you have
                changed that on the website.
              </p>
              <p className="audit-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void upload()}
                  disabled={workingOnHistory || sync.state === 'needs-attention'}
                >
                  {sync.backfilling
                    ? 'Uploading…'
                    : `Upload ${preview.entries} ${preview.entries === 1 ? 'entry' : 'entries'}`}
                </button>
                {sync.backfilling && (
                  <button type="button" className="secondary" onClick={snap.cancelJournalBackfill}>
                    Stop
                  </button>
                )}
              </p>
            </>
          )}

          {uploadProgress && uploadProgress.total > 0 && (
            <p className="field-hint">
              Uploaded {uploadProgress.sent} of {uploadProgress.total}. Stopping is safe —
              everything still queued is sent later.
            </p>
          )}
          {uploadResult && <p className="note">{uploadResult}</p>}

          {/*
            Which categories go is not obvious and not guessable, so it is said
            rather than discovered by comparing the website against the app.
          */}
          <p className="field-hint">
            Only exobiology, exploration signals, data sales and first footfalls are sent, because
            those are the categories EDFM accepts.
          </p>

          {sync.server?.lastSync && (
            <p className="field-hint">
              EDFM last recorded a sync at{' '}
              {parseMediaWikiTimestamp(sync.server.lastSync)?.toLocaleString() ?? 'an unknown time'}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
