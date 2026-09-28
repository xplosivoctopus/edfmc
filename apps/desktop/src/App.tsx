import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isKnown, type CommanderState, type Known } from '@edfm/elite-journal';

import { resourceUrl } from '@edfm/context';
import {
  explainMission,
  hasDeliveryProgress,
  missionCaveat,
  remainingCargo,
  type Mission,
} from '@edfm/missions';
import { openUrl } from '@tauri-apps/plugin-opener';

import { Logistics } from './Logistics';
import { Research } from './Research';
import { Contributions } from './Contributions';
import { Plugins as PluginsScreen } from './Plugins';
import { companion, relativeExpiry, travelLabel } from './lib/companion.js';
import { logger, type LogEntry } from './lib/logger.js';
import {
  onEditMode,
  onEliteWindow,
  countdownTo,
  overlayApi,
  type OverlayCarrierJump,
  type DisplayModeInfo,
  type EliteWindowInfo,
} from './lib/overlay.js';
import './App.css';

/**
 * Render a possibly-unknown value.
 *
 * "Unknown" is shown as its own word rather than an em dash or a blank, because §4
 * requires the difference between "the game did not tell us" and "there is none" to
 * stay visible to the user, not just inside the type system.
 */
function show(value: Known<unknown>, fallback = 'Unknown'): string {
  if (!isKnown(value)) return fallback;
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

const SECTIONS = [
  'Dashboard',
  'Context',
  'Missions',
  'Logistics',
  'Research',
  'Contributions',
  'Overlay',
  'Plugins',
  'Settings',
  'Diagnostics',
] as const;
type Section = (typeof SECTIONS)[number];

const IMPLEMENTED: ReadonlySet<Section> = new Set<Section>([
  'Context',
  'Missions',
  'Dashboard',
  'Overlay',
  'Logistics',
  'Research',
  'Contributions',
  'Plugins',
  'Settings',
  'Diagnostics',
]);

const PHASE: Partial<Record<Section, string>> = {};

export default function App() {
  const [section, setSection] = useState<Section>('Dashboard');

  const snap = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.snapshot(),
  );

  // The Companion is app-scoped, not component-scoped: it must keep ingesting for
  // the lifetime of the window. Deliberately no cleanup — tearing it down here
  // would stop the engine during StrictMode's dev remount, and the idempotent
  // start() would then decline to restart it.
  useEffect(() => {
    void companion.start();
  }, []);

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span>
            EDFM <strong>Companion</strong>
          </span>
        </div>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={s === section ? 'active' : ''}
                aria-current={s === section ? 'page' : undefined}
                onClick={() => setSection(s)}
              >
                <span>{s}</span>
                {!IMPLEMENTED.has(s) && <span className="pill">{PHASE[s]}</span>}
              </button>
            </li>
          ))}
        </ul>
        <ConnectionBadge snap={snap} />
      </nav>

      <main className="main">
        {section === 'Dashboard' && <Dashboard snap={snap} />}
        {section === 'Context' && <ContextPanel snap={snap} />}
        {section === 'Missions' && <MissionsPanel snap={snap} />}
        {section === 'Overlay' && <OverlayPanel />}
        {section === 'Logistics' && <Logistics snap={snap} />}
        {section === 'Research' && <Research snap={snap} />}
        {section === 'Contributions' && <Contributions snap={snap} />}
        {section === 'Plugins' && <PluginsScreen snap={snap} />}
        {section === 'Settings' && <Settings snap={snap} />}
        {section === 'Diagnostics' && <Diagnostics snap={snap} />}
        {!IMPLEMENTED.has(section) && <Placeholder section={section} />}
      </main>
    </div>
  );
}

type Snap = ReturnType<typeof companion.snapshot>;

function ConnectionBadge({ snap }: { snap: Snap }) {
  // §29: never rely on colour alone. Each state carries a distinct glyph and word.
  const map = {
    starting: { icon: '◐', label: 'Starting', cls: 'warn' },
    watching: { icon: '●', label: 'Watching journal', cls: 'ok' },
    'no-directory': { icon: '▲', label: 'No journal folder', cls: 'warn' },
    stopped: { icon: '■', label: 'Stopped', cls: 'warn' },
    error: { icon: '✕', label: 'Error', cls: 'bad' },
  } as const;
  const s = map[snap.connection];

  return (
    <div className={`status ${s.cls}`} role="status">
      <span aria-hidden="true">{s.icon}</span>
      <div>
        <div className="status-label">{s.label}</div>
        <div className="status-sub">{snap.activeFile ?? 'No active journal'}</div>
      </div>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  const unknown = value === 'Unknown';
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <div className="field-label">{label}</div>
      <div className={`field-value${unknown ? ' unknown' : ''}`}>{value}</div>
    </div>
  );
}

/**
 * True when the journal's Body and StationName describe the same place.
 *
 * Orbital and station-type docks report BodyType "Station" with Body equal to the
 * station name, so showing both is pure repetition. Surface ports and fleet
 * carriers report Planet or Star, where the body is genuinely separate
 * information worth keeping while flying and landing.
 */
function bodyDuplicatesStation(s: CommanderState): boolean {
  return isKnown(s.bodyType) && s.bodyType === 'Station';
}

/**
 * How to label the station.
 *
 * A carrier gets "Name (CALLSIGN)" on one line: the name is what the commander
 * calls it, the callsign is what the game shows on the dock, and separating them
 * across two rows made the pair harder to read rather than easier.
 */
function stationDisplay(s: CommanderState): string {
  if (!isKnown(s.stationName)) return travelLabel(s.travel);
  if (isKnown(s.carrierName)) return `${s.carrierName} (${s.stationName})`;
  return s.stationName;
}

/**
 * Scheduled jumps for the commander's own carriers.
 *
 * Rendered only when one is pending. Ticks once a second off the departure instant
 * the game stated, rather than a duration computed once and then drifting.
 *
 * There is deliberately no equivalent for anyone else's carrier. `CarrierJumpRequest`
 * is only ever written for a carrier the commander commands -- all 136 in the corpus
 * belong to their own three, and none of the 45 other carriers they have docked at
 * produced one. A carrier you are visiting can leave without the journal ever
 * mentioning it, and inventing a countdown for that would be a guess.
 */
function CarrierJumpCard({ jumps }: { jumps: readonly OverlayCarrierJump[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (jumps.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [jumps.length]);

  if (jumps.length === 0) return null;

  return (
    <section className="card">
      <h2>Carrier jump</h2>
      <div className="grid">
        {jumps.map((j) => {
          const remaining = countdownTo(j.departureTime, now);
          return (
            <Field
              key={j.carrierId}
              label={j.name}
              wide
              value={
                remaining === null
                  ? // The stated time has passed and no arrival has been confirmed.
                    // "Departing" is what we know; "arrived" would be invented.
                    `Departing → ${j.system}${j.body ? ` ${j.body}` : ''}`
                  : `${remaining} → ${j.system}${j.body ? ` ${j.body}` : ''}`
              }
            />
          );
        })}
      </div>
      <p className="muted">
        Your own carriers only. The game does not tell the Companion when someone
        else&apos;s carrier is about to jump, so none is shown rather than guessed.
      </p>
    </section>
  );
}

function Dashboard({ snap }: { snap: Snap }) {
  const s = snap.state;
  const pos = isKnown(s.starPos) ? s.starPos.map((n) => n.toFixed(2)).join(' / ') : 'Unknown';
  const services = isKnown(s.stationServices) ? String(s.stationServices.length) : 'Unknown';
  const bodyIsStation = bodyDuplicatesStation(s);
  const stationLabel = stationDisplay(s);

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <p className="muted">
          Live state built from journal events. Values the game did not report are shown as
          Unknown rather than guessed.
        </p>
      </header>

      <section className="card">
        <h2>Commander</h2>
        <div className="grid">
          <Field label="CMDR" value={show(s.commander)} />
          <Field label="Game version" value={show(s.gameVersion)} />
          <Field label="Build" value={show(s.build).trim() || 'Unknown'} />
          <Field label="Mode" value={show(s.gameMode)} />
        </div>
      </section>

      <section className="card">
        <h2>Location</h2>
        <div className="grid">
          <Field label="System" value={show(s.starSystem)} />
          <Field label="System address" value={show(s.systemAddress)} />
          {/* BodyType "Station" means Body IS the station — the journal reports
              Body='Elder Hub' next to StationName='Elder Hub'. Showing both would
              just repeat it. A carrier is always Planet or Star, so its body stays
              a separate, useful line. */}
          {!bodyIsStation && <Field label="Body" value={show(s.body)} />}
          <Field label="Coordinates" value={pos} wide />
          <Field label="Station" value={stationLabel} />
          <Field label="Market ID" value={show(s.marketId)} />
          <Field label="Status" value={travelLabel(s.travel)} />
          <Field label="Services reported" value={services} />
          {isKnown(s.jumpTarget) && <Field label="Next jump" value={s.jumpTarget} />}
          {isKnown(s.remainingJumps) && (
            <Field label="Jumps remaining" value={String(s.remainingJumps)} />
          )}
        </div>
      </section>

      <CarrierJumpCard jumps={snap.carrierJumps} />

      <section className="card">
        <h2>Ship &amp; cargo</h2>
        <div className="grid">
          <Field label="Ship" value={show(s.ship)} />
          <Field label="Ship name" value={show(s.shipName)} />
          <Field label="Vehicle" value={s.vehicle === 'unknown' ? 'Unknown' : s.vehicle} />
          <Field label="Cargo" value={show(s.cargoCount)} />
        </div>
      </section>

      <section className="card">
        <h2>Last event</h2>
        <div className="grid">
          <Field label="Event" value={s.lastEventName ?? 'Unknown'} />
          <Field label="Timestamp" value={s.lastEventAt ?? 'Unknown'} />
          <Field label="Event ID" value={s.lastEventId ?? 'Unknown'} wide />
        </div>
        {s.shutdown && (
          <p className="note">
            <span aria-hidden="true">■</span> A Shutdown event was seen — the game has exited.
          </p>
        )}
      </section>
    </>
  );
}

function ContextPanel({ snap }: { snap: Snap }) {
  const contexts = snap.contexts;

  return (
    <>
      <header className="page-head">
        <h1>Context</h1>
        <p className="muted">
          EDFM material relevant to what you are doing right now, matched from journal
          events by fixed rules. Nothing here is inferred by a model — a context appears
          only when a rule's conditions are literally satisfied.
        </p>
      </header>

      {contexts.length === 0 ? (
        <section className="card">
          <h2>Nothing active</h2>
          <p className="muted">
            No context rule currently matches. Contexts appear when you do something a
            rule recognises — prospecting an asteroid, docking at an Engineer, sampling
            biology, delivering to a construction site — and fade once they stop being
            relevant.
          </p>
        </section>
      ) : (
        contexts.map((ctx) => (
          <section className="card" key={ctx.rule.id}>
            <h2>{ctx.rule.title}</h2>
            {ctx.rule.subtitle && <p className="muted">{ctx.rule.subtitle}</p>}

            {ctx.rule.actions && ctx.rule.actions.length > 0 && (
              <ol className="context-actions">
                {ctx.rule.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
            )}

            <ul className="resources">
              {ctx.rule.resources.map((resource) => {
                const url = resourceUrl(resource);
                if (!url) return null;
                return (
                  <li key={url}>
                    <button type="button" className="resource" onClick={() => void openUrl(url)}>
                      <span className="resource-label">{resource.label}</span>
                      <span className="resource-go" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {ctx.rule.note && <p className="muted">EDFM Note: {ctx.rule.note}</p>}

            {/* Provenance: which event caused this, per §27. */}
            <p className="provenance">
              Triggered by <code>{ctx.triggerEvent}</code> · rule <code>{ctx.rule.id}</code>
            </p>
          </section>
        ))
      )}

      <section className="card">
        <h2>Rule set</h2>
        <div className="grid">
          <Field label="Version" value={String(snap.contextRuleVersion)} />
          <Field label="Source" value={snap.contextRuleSource} />
          <Field label="Active contexts" value={String(contexts.length)} />
        </div>
        <p className="muted">
          Rules are versioned and will be served by the EDFM backend, so recommendations
          can change without shipping a new build. This build uses the bundled set, which
          is also the offline fallback.
        </p>
      </section>
    </>
  );
}

type MissionViewMode = 'destination' | 'expiry' | 'type';

function MissionsPanel({ snap }: { snap: Snap }) {
  const [mode, setMode] = useState<MissionViewMode>('destination');
  const { summary, groups, withoutDestination, byExpiry } = snap.missions;

  return (
    <>
      <header className="page-head">
        <h1>Missions</h1>
        <p className="muted">
          Active missions from the journal. Fields the game did not report are shown as
          Unknown — around half of accepted missions carry no destination at all.
        </p>
      </header>

      <section className="card">
        <h2>Summary</h2>
        <div className="grid">
          <Field label="Active" value={String(summary.active)} />
          <Field label="Cargo required" value={`${summary.totalCargo} t`} />
          <Field label="Expiring within an hour" value={String(summary.expiringSoon)} />
          <Field label="No destination given" value={String(summary.withoutDestination)} />
        </div>
        {Object.keys(summary.categories).length > 0 && (
          <ul className="tags">
            {Object.entries(summary.categories)
              .sort((a, b) => b[1] - a[1])
              .map(([category, n]) => (
                <li key={category}>
                  {category} <span className="count">{n}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {summary.active === 0 ? (
        <section className="card">
          <h2>No active missions</h2>
          <p className="muted">
            Missions appear here as you accept them, and are remembered across restarts.
          </p>
        </section>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Mission grouping">
            {(['destination', 'expiry', 'type'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? 'tab active' : 'tab'}
                onClick={() => setMode(m)}
              >
                By {m}
              </button>
            ))}
          </div>

          {mode === 'destination' && (
            <>
              {groups.map((g) => (
                <section className="card" key={g.key}>
                  <h2>
                    {g.system}
                    {g.station ? ` · ${g.station}` : ''}
                  </h2>
                  <div className="grid">
                    <Field label="Missions" value={String(g.missionCount)} />
                    <Field
                      label="Cargo"
                      // A carrying mission that reported no count must not be
                      // silently averaged away into a confident total.
                      value={g.cargoIncomplete ? `${g.cargoRequired} t (incomplete)` : `${g.cargoRequired} t`}
                    />
                    <Field label="Kills" value={g.killsRequired > 0 ? String(g.killsRequired) : '—'} />
                    <Field label="Earliest expiry" value={g.earliestExpiry ?? 'Unknown'} />
                  </div>
                  {g.targetFactions.length > 0 && (
                    <p className="muted">Targets: {g.targetFactions.join(', ')}</p>
                  )}
                  <MissionList missions={g.missions} />
                </section>
              ))}

              {withoutDestination.length > 0 && (
                <section className="card">
                  <h2>No destination given</h2>
                  <p className="muted">
                    The journal recorded no destination for these. That is a gap in what
                    Elite reports, not a lookup failure — they are shown here rather than
                    guessed at.
                  </p>
                  <MissionList missions={withoutDestination} />
                </section>
              )}
            </>
          )}

          {mode === 'expiry' && (
            <section className="card">
              <h2>By expiry</h2>
              <MissionList missions={byExpiry} showDestination />
            </section>
          )}

          {mode === 'type' && <MissionsByType missions={byExpiry} />}
        </>
      )}
    </>
  );
}

function MissionsByType({ missions }: { missions: readonly Mission[] }) {
  const grouped = useMemo(() => {
    const out = new Map<string, Mission[]>();
    for (const m of missions) {
      const bucket = out.get(m.category);
      if (bucket) bucket.push(m);
      else out.set(m.category, [m]);
    }
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [missions]);

  return (
    <>
      {grouped.map(([category, list]) => (
        <section className="card" key={category}>
          <h2>
            {category} ({list.length})
          </h2>
          <MissionList missions={list} showDestination />
        </section>
      ))}
    </>
  );
}

function MissionList({
  missions,
  showDestination,
}: {
  missions: readonly Mission[];
  showDestination?: boolean;
}) {
  return (
    <ul className="missions">
      {missions.map((m) => {
        const explanation = explainMission(m);
        const caveat = missionCaveat(m);
        return (
        <li key={m.missionId} className="mission">
          <div className="mission-main">
            <span className="mission-name">
              {isKnown(m.localisedName) ? m.localisedName : m.name}
            </span>
            <span className="mission-meta">
              {isKnown(m.faction) ? m.faction : 'Unknown faction'}
              {m.redirected && <span className="badge">redirected</span>}
              {/* Kill counts are accepted/completed only — Elite does not journal
                  incremental progress, so no partial counter is shown (§8). */}
              {isKnown(m.killCount) && <span className="badge">{m.killCount} kills</span>}
              {/* Real progress, from CargoDepot — the one kind Elite journals.
                  Shows what is still owed, since that is the number the next run
                  is planned around. */}
              {hasDeliveryProgress(m) ? (
                <span className="badge progress">
                  {remainingCargo(m)} t left of {m.totalToDeliver as number}
                  {isKnown(m.commodityLocalised) ? ` ${m.commodityLocalised}` : ''}
                </span>
              ) : (
                isKnown(m.count) &&
                isKnown(m.commodity) && (
                  <span className="badge">
                    {m.count} t {isKnown(m.commodityLocalised) ? m.commodityLocalised : ''}
                  </span>
                )
              )}
            </span>
            {showDestination && (
              <span className="mission-meta">
                {isKnown(m.destinationSystem) ? (
                  <>
                    {m.destinationSystem}
                    {isKnown(m.destinationStation) ? ` · ${m.destinationStation}` : ''}
                  </>
                ) : (
                  <span className="unknown-inline">No destination given</span>
                )}
              </span>
            )}

            {/* Frontier's own mission titles assume the mechanic is already
                understood: "Source and return" never says you buy the cargo.
                Labelled, because this is EDFM's editorial guidance rather than
                something read out of the journal — everything else on this row
                came from the game, and the difference should be visible. */}
            {explanation && (
              <span className="mission-explain">
                <span className="mission-explain-label">EDFM note</span>
                {explanation}
              </span>
            )}
            {caveat && (
              <span className="mission-caveat">
                <span aria-hidden="true">▲ </span>
                {caveat}
              </span>
            )}
          </div>
          <div className="mission-side">
            {isKnown(m.expiry) ? (
              <span title={m.expiry}>{relativeExpiry(m.expiry)}</span>
            ) : (
              <span className="unknown-inline">No expiry</span>
            )}
          </div>
        </li>
        );
      })}
    </ul>
  );
}

function OverlayPanel() {
  const widgets = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayWidgets,
  );
  // Read from the companion rather than held locally: both are persisted, so the
  // toggle has to show the restored value on first paint instead of defaulting to
  // off and contradicting an overlay that is already on screen.
  const enabled = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayOn,
  );
  const hideInactive = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayHideWhenInactive,
  );
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<DisplayModeInfo | null>(null);
  const [win, setWin] = useState<EliteWindowInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void overlayApi.displayMode().then(setMode).catch(() => undefined);
    void overlayApi.eliteWindow().then(setWin).catch(() => undefined);
    const stopWin = onEliteWindow(setWin);
    // The overlay can leave edit mode on its own (Escape, Done, or losing focus),
    // so this control follows the real state rather than assuming it owns it.
    const stopEdit = onEditMode(setEditing);
    return () => {
      stopWin();
      stopEdit();
    };
  }, []);

  async function toggle(next: boolean) {
    setError(null);
    try {
      if (next) {
        await overlayApi.start(hideInactive);
        companion.setOverlayEnabled(true, hideInactive);
      } else {
        if (editing) {
          await overlayApi.setEditMode(false);
          setEditing(false);
        }
        await overlayApi.stop();
        companion.setOverlayEnabled(false, hideInactive);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleEdit(next: boolean) {
    setError(null);
    try {
      await overlayApi.setEditMode(next);
      setEditing(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // §29: the warning is carried by glyph and wording, not by colour alone.
  const unsupported = mode?.overlay_supported === false;
  const unknownSupport = mode?.overlay_supported === null;

  return (
    <>
      <header className="page-head">
        <h1>Overlay</h1>
        <p className="muted">
          An external, transparent window aligned to the Elite Dangerous window. It never
          injects code into the game, reads its memory, or sends it input.
        </p>
      </header>

      <section className="card">
        <h2>Elite Dangerous display mode</h2>
        {mode === null ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <div className="grid">
              <Field label="Mode" value={mode.mode === 'unknown' ? 'Unknown' : mode.mode} />
              <Field label="Raw setting" value={mode.raw === null ? 'Unknown' : String(mode.raw)} />
              <Field
                label="Overlay supported"
                value={
                  mode.overlay_supported === null
                    ? 'Unknown'
                    : mode.overlay_supported
                      ? 'Yes'
                      : 'No'
                }
              />
            </div>
            <p className={unsupported || unknownSupport ? 'note' : 'muted'}>
              {(unsupported || unknownSupport) && <span aria-hidden="true">▲ </span>}
              {mode.detail}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Game window</h2>
        {win?.found ? (
          <div className="grid">
            <Field label="Position" value={`${win.x}, ${win.y}`} />
            <Field label="Size" value={`${win.width} x ${win.height}`} />
            <Field label="Monitor" value={`${win.monitor_width} x ${win.monitor_height}`} />
            <Field label="Reported DPI" value={String(win.dpi)} />
            <Field label="Focused" value={win.is_foreground ? 'Yes' : 'No'} />
            <Field label="Covers monitor" value={win.covers_monitor ? 'Yes' : 'No'} />
          </div>
        ) : (
          <p className="muted">
            Elite Dangerous is not running, or its window has not been found. The overlay
            will appear automatically once the game window exists.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Controls</h2>
        <div className="controls">
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
            <span>Enable overlay</span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={editing}
              disabled={!enabled}
              onChange={(e) => void toggleEdit(e.target.checked)}
            />
            <span>
              Edit mode{' '}
              <span className="muted-inline">
                — widgets become draggable. Leave with the Done button or Esc.
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={(e) => {
                const next = e.target.checked;
                companion.setOverlayEnabled(enabled, next);
                if (enabled) void overlayApi.start(next);
              }}
            />
            <span>Hide while Elite is not the active window</span>
          </label>
        </div>

        <p className="muted">
          In normal mode the overlay is click-through: mouse input passes straight to the
          game. Edit mode makes it interactive so widgets can be positioned, and positions
          are remembered.
        </p>
        {error && (
          <p className="note">
            <span aria-hidden="true">✕ </span>
            {error}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Widgets</h2>
        <p className="muted">
          Each widget is positioned independently in edit mode and remembers where you
          put it.
        </p>
        <div className="controls">
          <label className="check">
            <input
              type="checkbox"
              checked={widgets.context}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, context: e.target.checked })}
            />
            <span>
              Current Context{' '}
              <span className="muted-inline">— commander, location, and relevant EDFM material</span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.missions}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, missions: e.target.checked })}
            />
            <span>
              Missions{' '}
              <span className="muted-inline">
                — so mission details are readable without leaving the game
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.edfmNotes}
              disabled={!widgets.missions}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, edfmNotes: e.target.checked })}
            />
            <span>
              Show EDFM notes on missions{' '}
              <span className="muted-inline">— explains what a mission type actually asks</span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.carrierJump}
              onChange={(e) =>
                void companion.setOverlayWidgets({ ...widgets, carrierJump: e.target.checked })
              }
            />
            <span>
              Carrier jump countdown{' '}
              <span className="muted-inline">
                — your own carriers only; the game never reveals anyone else&apos;s
              </span>
            </span>
          </label>
        </div>
        <p className="muted">
          The Missions widget shows the five soonest to expire. The full list, with
          links, stays in this window.
        </p>
      </section>
    </>
  );
}

function Settings({ snap }: { snap: Snap }) {
  const [path, setPath] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <>
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="card">
        <h2>Journal folder</h2>
        <div className="grid">
          <Field label="Resolved folder" value={snap.directory ?? 'Unknown'} wide />
        </div>
        <p className="muted">{snap.directoryDetail}</p>

        <label className="stack" htmlFor="journal-path">
          <span>Manual override</span>
          <input
            id="journal-path"
            type="text"
            value={path}
            placeholder="Leave blank to use the Saved Games folder"
            onChange={(e) => {
              setPath(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            await companion.setSetting('journalDirectory', path);
            setSaved(true);
          }}
        >
          Save
        </button>
        {saved && <p className="note">Saved. Restart the application to apply.</p>}
      </section>

      <section className="card">
        <h2>Verification</h2>
        <p className="muted">
          Compares what your game reports about stations against the community observation set,
          and reports disagreements so EDFM can be corrected.
        </p>
        <label className="stack" htmlFor="verification-enabled">
          <span>
            <input
              id="verification-enabled"
              type="checkbox"
              checked={snap.verificationEnabled}
              onChange={(e) => void companion.setVerificationEnabled(e.target.checked)}
            />{' '}
            Contribute station observations
          </span>
        </label>
        <p className="muted">
          Off by default. While it is on, EDFM Companion looks up the station you are docked at,
          which tells the server where you are. Observations are sent without your commander name
          or ID: the server stores a one-way hash instead, which lets it tell two reporters apart
          without knowing who either of them is. Turning this off clears what has been cached.
        </p>
        {snap.verificationEnabled && (
          <p className="note">
            Observations checked: {snap.verification.checked} · findings: {snap.verification.discrepancies}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <p className="muted">
          Everything else is local. Your journals are read on this machine and never uploaded,
          and there are no analytics. Chat, friends, private groups and travel history are never
          sent anywhere, whatever the settings above.
        </p>
      </section>
    </>
  );
}

function Diagnostics({ snap }: { snap: Snap }) {
  const [entries, setEntries] = useState<readonly LogEntry[]>(() => logger.entries().slice(-100));

  useEffect(() => logger.subscribe(() => setEntries(logger.entries().slice(-100))), []);

  const unknown = useMemo(
    () => Object.entries(snap.stats.unknownEventKinds).sort((a, b) => b[1] - a[1]).slice(0, 12),
    [snap.stats.unknownEventKinds],
  );

  return (
    <>
      <header className="page-head">
        <h1>Diagnostics</h1>
      </header>

      <section className="card">
        <h2>Ingest</h2>
        <div className="grid">
          <Field label="Lines read" value={String(snap.stats.linesRead)} />
          <Field label="Events emitted" value={String(snap.stats.eventsEmitted)} />
          <Field label="Malformed JSON" value={String(snap.stats.malformedJson)} />
          <Field label="Rotations" value={String(snap.stats.rotations)} />
          <Field label="Files opened" value={String(snap.stats.filesOpened)} />
          <Field label="Empty files skipped" value={String(snap.stats.emptyFilesSkipped)} />
        </div>
      </section>

      <section className="card">
        <h2>Events without a typed shape</h2>
        <p className="muted">
          These are delivered with full provenance and are not errors — they are the
          normalization backlog.
        </p>
        {unknown.length === 0 ? (
          <p className="muted">None seen yet.</p>
        ) : (
          <ul className="tags">
            {unknown.map(([name, n]) => (
              <li key={name}>
                {name} <span className="count">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Recent log</h2>
        <div className="log" role="log">
          {entries.length === 0 && <p className="muted">Nothing logged yet.</p>}
          {entries.map((e, i) => (
            <div key={`${e.at}-${i}`} className={`log-row ${e.level}`}>
              <span className="log-level">{e.level.toUpperCase()}</span>
              <span className="log-scope">{e.scope}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Placeholder({ section }: { section: Section }) {
  return (
    <>
      <header className="page-head">
        <h1>{section}</h1>
      </header>
      <section className="card">
        <p className="muted">
          Planned for {PHASE[section]}. The foundation this depends on is in place; the module
          itself is deliberately not built yet.
        </p>
      </section>
    </>
  );
}
