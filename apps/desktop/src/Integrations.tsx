/**
 * Connections & Data Sharing: what leaves this machine, where it goes, and what
 * has actually gone.
 *
 * The screen is built around the privacy manifest and the queue rather than
 * around a set of switches. `Connected ✓` tells a commander that something is
 * happening and nothing about what — so both halves, what is shared and what
 * never is, are always on screen for every service, switched on or not, together
 * with the evidence: how much is waiting, when something was last accepted, and
 * why the last attempt failed.
 *
 * Two rules the markup follows:
 *
 * 1. **Nothing here describes activity that did not happen.** The transmission
 *    line comes from `sharingAudit`, which distinguishes "nothing to send" from
 *    "cannot send yet" and refuses to render the second as the first.
 * 2. **Status is stated in words**, not by colour or position alone, because "is
 *    this on?" should not depend on telling two shades of grey apart.
 */

import {
  universalNeverShares,
  type IntegrationDescriptor,
  type SharingRow,
} from '@edfm/integrations';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';

import { JournalSync } from './JournalSync';
import type { CompanionSnapshot } from './lib/companion.js';

const STATUS_LABEL: Record<string, string> = {
  disabled: 'Off',
  'needs-configuration': 'Needs your API key',
  ready: 'On',
  error: 'Error',
  'not-implemented': 'Not built yet',
};

/** Absolute time as well as relative: "2 hours ago" is useless in a bug report. */
function whenText(iso: string | null): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

export function Integrations({ snap }: { snap: CompanionSnapshot }) {
  const audit = snap.sharing;
  const universal = universalNeverShares(audit.rows.map((r) => r.descriptor));

  return (
    <>
      <header className="page-head">
        <h1>Connections &amp; Data Sharing</h1>
      </header>

      <section className="card">
        <p className="muted">
          Everything here is off until you switch it on, and nothing reaches these services through
          EDFM — this app talks to them directly, and your API keys never leave your machine.
        </p>

        {/*
          The single fact most people open this screen to check, stated as a
          sentence instead of four rows of zeroes to add up.
        */}
        {audit.nothingEverSent ? (
          <p className="audit-headline">Nothing has ever been sent from this machine.</p>
        ) : (
          <p className="audit-headline">
            {audit.totalPending === 0
              ? 'Everything that was going to be sent has been sent.'
              : `${audit.totalPending} ${audit.totalPending === 1 ? 'item is' : 'items are'} waiting to be sent.`}
          </p>
        )}

        {/*
          Whose data this describes. On a shared machine the answer is not
          obvious, and sharing is per commander -- so the page says who it means
          rather than leaving it to be assumed.
        */}
        <p className="muted">
          {audit.commanderName
            ? `Shown for CMDR ${audit.commanderName}. Each commander's connections are separate; switching on a service here does not switch it on for anyone else who plays on this machine.`
            : 'No commander identified yet. Connections are per commander, so nothing can be sent until the game reports who is playing.'}
        </p>

        {audit.totalUnattributed > 0 && (
          /*
            Deliberately surfaced. These rows exist on disk and belong to nobody
            the app could identify, so they are never sent -- but "nothing is
            queued" would be a misleading way to say that.
          */
          <p className="note">
            {audit.totalUnattributed} queued{' '}
            {audit.totalUnattributed === 1 ? 'item could' : 'items could'} not be matched to a
            commander. They will never be sent — data is not guessed into someone&apos;s account.
          </p>
        )}
      </section>

      {universal.length > 0 && (
        <section className="card">
          <h2>Never sent, by any of these</h2>
          <p className="muted">
            These hold for every service below. Each service lists anything further of its own.
          </p>
          <ul className="privacy-list">
            {universal.map((item) => (
              <li key={item}>
                <span className="privacy-no" aria-hidden="true">
                  ✗
                </span>
                <span className="sr-label">Never shares: </span>
                {item}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* First-party and different in kind: your own account rather than a
          community database, so it leads. */}
      <JournalSync snap={snap} />

      {audit.rows
        .filter((row) => row.id !== 'edfm-journal')
        .map((row) => (
          <IntegrationCard key={row.id} row={row} snap={snap} />
        ))}
    </>
  );
}

/**
 * Where a key is entered, for the integrations that need one.
 *
 * The value goes straight to the OS credential store and is cleared from the
 * field immediately. Nothing reads it back: there is no command that returns a
 * secret, so the app can report that one exists and nothing more.
 */
function CredentialField({
  service,
  row,
  snap,
}: {
  service: IntegrationDescriptor;
  row: SharingRow;
  snap: CompanionSnapshot;
}) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setProblem(null);
    const reason = await snap.setIntegrationCredential(service.id, value);
    // Cleared either way: a key that failed is not worth keeping on screen, and
    // one that worked must not be shown again.
    setValue('');
    setBusy(false);
    setProblem(reason);
  }

  if (row.hasCredential) {
    return (
      <div className="field">
        <span>API key</span>
        <p className="field-hint">
          Stored in the Windows Credential Manager. It is never shown again, and this app
          cannot read it back — only whether one exists.
        </p>
        <p className="audit-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void snap.clearIntegrationCredential(service.id)}
          >
            Remove key
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="field">
      <span>API key</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste your key"
        spellCheck={false}
        autoComplete="off"
        // Masked while typing: this gets filled during streams and screen shares.
        type="password"
      />
      {service.privacy.credentialHelp && (
        <span className="field-hint">{service.privacy.credentialHelp}</span>
      )}
      {problem && <p className="note">{problem}</p>}
      <p className="audit-actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void openUrl(service.homepage).catch(() => undefined)}
        >
          Open {service.name}
        </button>
      </p>
    </div>
  );
}

function IntegrationCard({ row, snap }: { row: SharingRow; snap: CompanionSnapshot }) {
  const [showError, setShowError] = useState(false);
  const service = row.descriptor;
  const q = row.queue;
  /* Service-specific guarantees only; the shared ones are stated once above. */
  const universal = universalNeverShares(snap.sharing.rows.map((r) => r.descriptor));
  const specific = service.privacy.neverShares.filter((item) => !universal.includes(item));

  return (
    <section className="card">
      <div className="integration-head">
        <h2>{service.name}</h2>
        {/* Text, not a coloured dot. */}
        <span className={`integration-status status-${row.status}`}>
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
      </div>

      <p className="muted">{service.privacy.summary}</p>

      <p className={row.transmission === 'failing' ? 'note' : 'audit-line'}>{row.summary}</p>

      {service.implemented ? (
        <label className="check">
          <input
            type="checkbox"
            checked={row.enabled}
            // A service that needs a key and has none cannot send, so the
            // switch would promise something that does not happen.
            disabled={service.privacy.requiresCredential && !row.hasCredential}
            onChange={(e) => void snap.setIntegrationEnabled(row.id, e.target.checked)}
          />
          <span>
            Enable {service.name}
            {service.privacy.requiresCredential && !row.hasCredential && (
              <span className="muted-inline"> ''' + DASH + ''' add an API key below first</span>
            )}
          </span>
        </label>
      ) : (
        /*
          Stated plainly rather than shown as a switch that does nothing. An
          integration that appears available while sending nothing is worse than
          one that admits it is unfinished, because the commander assumes their
          data is going somewhere it is not.
        */
        <p className="note">{service.pendingReason}</p>
      )}

      {/*
        The audit proper. Shown for every service, including unbuilt ones, where
        every figure being zero is itself the answer.
      */}
      <h3 className="subhead">Record</h3>
      <dl className="queue-grid">
        <div>
          <dt>Waiting</dt>
          <dd>{q.queued + q.attempting}</dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>{q.accepted}</dd>
        </div>
        <div>
          <dt>Will retry</dt>
          <dd>{q.retryable}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{q.rejected}</dd>
        </div>
        <div className="queue-wide">
          <dt>Last accepted</dt>
          <dd>{whenText(row.lastSuccessAt)}</dd>
        </div>
        {q.nextAttemptAt && (
          <div className="queue-wide">
            <dt>Next retry</dt>
            <dd>{whenText(q.nextAttemptAt)}</dd>
          </div>
        )}
      </dl>

      {row.lastError && (
        <p>
          <button type="button" className="link" onClick={() => setShowError((v) => !v)}>
            {showError ? 'Hide reason' : 'Why did the last attempt fail?'}
          </button>
          {showError && (
            /*
              Sanitised twice: on the way into the database and again in
              `sharingRow`, because this is the last point before the text
              becomes a screenshot in a bug report.
            */
            <span className="error-detail"> {row.lastError}</span>
          )}
        </p>
      )}

      {(row.canRetryNow || row.canClearRejected) && (
        <p className="audit-actions">
          {row.canRetryNow && (
            <button type="button" onClick={() => void snap.retrySharingNow(row.id)}>
              Retry now
            </button>
          )}
          {row.canClearRejected && (
            <button type="button" onClick={() => void snap.clearSharingRejected(row.id)}>
              Discard {q.rejected} rejected
            </button>
          )}
        </p>
      )}

      {service.privacy.requiresCredential && service.implemented && (
        <CredentialField service={service} row={row} snap={snap} />
      )}

      <div className="privacy-grid">
        <div>
          <h3 className="subhead">Shares</h3>
          {service.privacy.shares.length === 0 ? (
            <p className="muted">Nothing.</p>
          ) : (
            <ul className="privacy-list">
              {service.privacy.shares.map((item) => (
                <li key={item}>
                  <span className="privacy-yes" aria-hidden="true">
                    ✓
                  </span>
                  <span className="sr-label">Shares: </span>
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="subhead">Never shares, beyond the list above</h3>
          {specific.length === 0 ? (
            <p className="muted">Nothing further specific to {service.name}.</p>
          ) : (
            <ul className="privacy-list">
              {specific.map((item) => (
                <li key={item}>
                  <span className="privacy-no" aria-hidden="true">
                    ✗
                  </span>
                  <span className="sr-label">Never shares: </span>
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {service.privacy.credentialHelp && (
        <p className="field-hint">{service.privacy.credentialHelp}</p>
      )}

      <p>
        <button
          type="button"
          className="link"
          onClick={() => void openUrl(service.homepage).catch(() => undefined)}
        >
          {service.homepage}
        </button>
      </p>
    </section>
  );
}
