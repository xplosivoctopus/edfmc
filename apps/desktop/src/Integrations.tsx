/**
 * Integrations: what leaves this machine, and where it goes.
 *
 * The screen is built around the privacy manifest rather than around a set of
 * switches. `Connected ✓` tells a commander that something is happening and
 * nothing about what — so both halves, what is shared and what never is, are
 * always on screen, for every service, whether or not it is switched on.
 *
 * Status is stated in words as well as by position and colour, because "is this
 * on?" should not depend on distinguishing two shades of grey.
 */

import { integrationsList, type IntegrationDescriptor } from '@edfm/integrations';
import { openUrl } from '@tauri-apps/plugin-opener';

import type { CompanionSnapshot } from './lib/companion.js';

const STATUS_LABEL: Record<string, string> = {
  disabled: 'Off',
  'needs-configuration': 'Needs your API key',
  ready: 'On',
  syncing: 'Sending',
  error: 'Error',
  'not-implemented': 'Not built yet',
};

export function Integrations({ snap }: { snap: CompanionSnapshot }) {
  const services = integrationsList();

  return (
    <>
      <header className="page-head">
        <h1>Integrations</h1>
      </header>

      <section className="card">
        <p className="muted">
          Everything here is off until you switch it on, and nothing is sent to these services
          through EDFM — your game talks to them directly. Your Activity Journal, notes and saved
          items are local and are never sent anywhere, by any of these.
        </p>
      </section>

      {services.map((service) => (
        <IntegrationCard key={service.id} service={service} snap={snap} />
      ))}
    </>
  );
}

function IntegrationCard({
  service,
  snap,
}: {
  service: IntegrationDescriptor;
  snap: CompanionSnapshot;
}) {
  const state = snap.integrations[service.id] ?? { enabled: false, hasCredential: false };
  const status = service.implemented
    ? state.enabled
      ? service.privacy.requiresCredential && !state.hasCredential
        ? 'needs-configuration'
        : 'ready'
      : 'disabled'
    : 'not-implemented';

  return (
    <section className="card">
      <div className="integration-head">
        <h2>{service.name}</h2>
        {/* Text, not a coloured dot. */}
        <span className={`integration-status status-${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      <p className="muted">{service.privacy.summary}</p>

      {service.implemented ? (
        <label className="check">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => void snap.setIntegrationEnabled(service.id, e.target.checked)}
          />
          <span>
            Enable {service.name}
            {service.privacy.requiresCredential && (
              <span className="muted-inline"> — needs an API key before anything is sent</span>
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

      <div className="privacy-grid">
        <div>
          <h3 className="subhead">Shares</h3>
          {service.privacy.shares.length === 0 ? (
            <p className="muted">Nothing yet.</p>
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
          <h3 className="subhead">Never shares</h3>
          <ul className="privacy-list">
            {service.privacy.neverShares.map((item) => (
              <li key={item}>
                <span className="privacy-no" aria-hidden="true">
                  ✗
                </span>
                <span className="sr-label">Never shares: </span>
                {item}
              </li>
            ))}
          </ul>
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
