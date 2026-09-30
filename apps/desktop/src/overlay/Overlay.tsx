import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  countdownTo,
  liveJournalPanel,
  liveJournalTitle,
  type OverlayCarrierJump,
  type OverlayLiveActivity,
  type OverlayLiveExobiology,
} from '../lib/overlay';

import './overlay.css';

/**
 * Overlay root.
 *
 * Phase 2 shipped one widget to prove positioning, DPI and click-through. Those
 * hold up, so this is now a small widget system: each widget is independently
 * positioned, independently toggled, and remembers where it was put (§7).
 *
 * State arrives by event from the main window, which owns the single journal
 * engine. Running a second engine here would double every event.
 */

interface OverlayContext {
  title: string;
  subtitle: string | null;
  actions: readonly string[];
  note: string | null;
  /** Beginner explanation. Sent always; drawn only in New CMDR mode. */
  guidance: string | null;
  resources: ReadonlyArray<{ label: string; url: string }>;
}

interface MissionRow {
  id: number;
  name: string;
  destination: string | null;
  expiry: string | null;
  cargo: string | null;
  note: string | null;
}

interface OverlayMissions {
  active: number;
  cargo: number;
  expiringSoon: number;
  withoutDestination: number;
  nextStop: {
    system: string;
    station: string | null;
    missions: number;
    cargo: number;
    cargoIncomplete: boolean;
    kills: number;
    expiry: string | null;
  } | null;
  rows: readonly MissionRow[];
  more: number;
}

interface OverlayWidgets {
  context: boolean;
  missions: boolean;
  edfmNotes: boolean;
  carrierJump: boolean;
  liveJournal: boolean;
}

interface OverlayAppearance {
  backgroundOpacity: number;
  textOpacity: number;
}

interface LiveJournalState {
  title: string;
  detail: string | null;
  systemName: string | null;
  bodyName: string | null;
  occurredAt: string;
  hereCount: number;
  sessionCount: number;
}

interface OverlayState {
  commander: string | null;
  starSystem: string | null;
  station: string | null;
  body: string | null;
  docking: string | null;
  vehicle: string | null;
  jumpTarget: string | null;
  remainingJumps: number | null;
  context: OverlayContext | null;
  /** Other contexts true right now, title and subtitle only. */
  alsoActive: { title: string; subtitle: string | null }[];
  carrierJumps: OverlayCarrierJump[];
  appearance: OverlayAppearance;
  guidance: 'standard' | 'new-cmdr';
  liveJournal: LiveJournalState | null;
  liveActivity: OverlayLiveActivity | null;
  missions: OverlayMissions;
  widgets: OverlayWidgets;
}

interface Point {
  x: number;
  y: number;
}

type WidgetId = 'context' | 'missions' | 'carrierJump' | 'liveJournal';

const STORAGE_KEY = 'edfm.overlay.layout.v2';

/** Sensible starting corners, so two widgets never open stacked on each other. */
const DEFAULT_LAYOUT: Record<WidgetId, Point> = {
  context: { x: 32, y: 32 },
  missions: { x: 32, y: 260 },
  carrierJump: { x: 32, y: 520 },
  liveJournal: { x: 360, y: 32 },
};

/** Leave edit mode. The backend restores click-through and tells both windows. */
function exitEditMode(): void {
  void invoke('overlay_set_edit_mode', { editing: false }).catch(() => undefined);
}

/**
 * Live countdown to a scheduled carrier jump.
 *
 * Ticks locally from the absolute departure instant. Mission expiry is
 * pre-formatted by the main window precisely so the overlay needs no clock, but a
 * countdown has to move every second and pushing a fresh string that often would be
 * absurd. The instant is the reported fact; counting down from it is presentation.
 */
function CarrierJumpWidget({ jumps }: { jumps: OverlayCarrierJump[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      {jumps.map((j) => {
        const remaining = countdownTo(j.departureTime, now);
        return (
          <div key={j.carrierId} className="cj">
            <div className="cj-name">{j.name}</div>
            <div className="cj-line">
              {remaining === null ? (
                // The clock has run out and no arrival has been confirmed yet. It is
                // leaving, or has left -- saying "arrived" would be inventing the
                // one thing we have not been told.
                <span className="cj-departing">Departing</span>
              ) : (
                <span className="cj-time">{remaining}</span>
              )}
              <span className="cj-dest">
                {' → '}
                {j.system}
                {j.body && <span className="cj-body"> {j.body}</span>}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * The newest thing recorded, and how much happened here.
 *
 * ## Lifecycle, chosen and documented
 *
 * Recent activity shows in full. After five minutes it collapses to a single
 * summary line rather than disappearing or lingering: an overlay panel asserting
 * something from half an hour ago is the stale-context problem this project has
 * already fixed once, and an empty panel that used to have content reads as a
 * bug.
 *
 * One behaviour, no setting. The state needed for "most recent entry" and
 * "session summary" is already pushed, so offering a choice later is a settings
 * change rather than a new payload.
 */
const LIVE_JOURNAL_FRESH_MS = 5 * 60 * 1000;

/**
 * Live exobiology progress.
 *
 * This is the reason the widget exists. The Current Context panel already says
 * "biological signals detected" and "landed"; repeating that here earned the
 * space back for nothing. What it could not say is how far through a specimen the
 * commander is, which is the one number they want while walking between plants.
 *
 * The stage line is **omitted** when the count is not established rather than
 * guessed. See `LiveExobiology.samplesTaken`: a wrong "1 / 3" would say two
 * samples remain when one does.
 */
function LiveExobiologyWidget({ live }: { live: OverlayLiveExobiology }) {
  const stage = live.completed
    ? `${live.samplesRequired} / ${live.samplesRequired}`
    : live.samplesTaken === null
      ? null
      : `${live.samplesTaken} / ${live.samplesRequired}`;

  return (
    <>
      <div className="lj-title">{live.species ?? live.genus ?? 'Unknown organism'}</div>
      {live.colour && <div className="lj-detail">{live.colour}</div>}

      {live.completed ? (
        <div className="lx-complete">
          <span className="lx-tick" aria-hidden="true">
            ✓
          </span>
          Sample complete
          {stage && <span className="lx-stage-small">{stage}</span>}
        </div>
      ) : stage ? (
        <div className="lx-stage">Sample {stage}</div>
      ) : (
        /* Honest about the gap: it knows a run is open, not how far in. */
        <div className="lx-stage lx-stage-unknown">Sampling</div>
      )}

      {/*
        What else is on this body. The reason it is here: the panel used to go
        quiet after a specimen was finished, saying nothing about the genus still
        untouched a few hundred metres away.

        Only shown when the body has actually been surface-scanned, and the
        sampled genus is left out of the list because it is already the headline.
      */}
      {live.genera.length > 1 && (
        <ul className="lx-roster">
          {live.genera
            .filter((g) => g.status !== 'sampling')
            .map((g) => (
              <li key={g.genus} className={`lx-genus lx-${g.status}`}>
                <span className="lx-genus-mark" aria-hidden="true">
                  {g.status === 'complete' ? '✓' : '·'}
                </span>
                <span className="lx-genus-name">{g.genus}</span>
                <span className="lx-genus-state">
                  {g.status === 'complete' ? 'Collected' : 'Unscanned'}
                </span>
              </li>
            ))}
        </ul>
      )}

      {live.bodyName && <div className="lj-body">{live.bodyName}</div>}
    </>
  );
}

function LiveJournalWidget({ journal }: { journal: LiveJournalState }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // A minute is enough: the only decision is fresh versus collapsed.
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const at = Date.parse(journal.occurredAt);
  const fresh = Number.isFinite(at) && now - at < LIVE_JOURNAL_FRESH_MS;

  if (!fresh) {
    return (
      <div className="lj-collapsed">
        {journal.sessionCount} {journal.sessionCount === 1 ? 'activity' : 'activities'} recorded
      </div>
    );
  }

  return (
    <>
      {journal.systemName && <div className="lj-place">{journal.systemName}</div>}
      {journal.bodyName && <div className="lj-body">{journal.bodyName}</div>}
      <div className="lj-title">{journal.title}</div>
      {journal.detail && <div className="lj-detail">{journal.detail}</div>}
      {journal.hereCount > 1 && (
        <div className="lj-here">{journal.hereCount} recorded here</div>
      )}
    </>
  );
}

function loadLayout(): Record<WidgetId, Point> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<WidgetId, Point>>;
      return {
        context: valid(parsed.context) ?? DEFAULT_LAYOUT.context,
        missions: valid(parsed.missions) ?? DEFAULT_LAYOUT.missions,
        carrierJump: valid(parsed.carrierJump) ?? DEFAULT_LAYOUT.carrierJump,
        liveJournal: valid(parsed.liveJournal) ?? DEFAULT_LAYOUT.liveJournal,
      };
    }
  } catch {
    // Corrupt or unavailable storage must not stop the overlay rendering.
  }
  return { ...DEFAULT_LAYOUT };
}

function valid(p: Point | undefined): Point | null {
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
}

export default function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<Record<WidgetId, Point>>(loadLayout);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const subs = [
      listen<OverlayState>('overlay://state', (e) => setState(e.payload)),
      listen<boolean>('overlay://edit-mode', (e) => setEditing(e.payload)),
    ];
    return () => {
      void Promise.all(subs).then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout persistence is a convenience, not a requirement.
    }
  }, [layout]);

  /*
   * Escape hatches from edit mode.
   *
   * Edit mode makes a fullscreen, always-on-top window interactive, which puts it
   * in front of the main window's own control. Without a way out from inside the
   * overlay the commander is locked out of the desktop, so there are two: Escape,
   * and the Done button in the banner.
   *
   * A blur handler was tried here and removed: entering edit mode calls set_focus
   * on the overlay, and the focus churn around that fired blur immediately, which
   * exited edit mode before the banner was ever usable.
   */
  useEffect(() => {
    if (!editing) return;
    rootRef.current?.focus(); // keydown needs the document to hold focus

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitEditMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  const move = useCallback((id: WidgetId, point: Point) => {
    setLayout((prev) => ({ ...prev, [id]: point }));
  }, []);

  /*
   * A minute tick, so the completion lifecycle advances while the game is quiet.
   * Overlay state is pushed on journal events; during an idle stretch there is no
   * push and therefore no re-render, which would leave a finished specimen on
   * screen indefinitely.
   */
  const [minuteTick, setMinuteTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setMinuteTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const widgets = state?.widgets;
  const panel = liveJournalPanel({
    liveActivity: state?.liveActivity ?? null,
    liveJournal: state?.liveJournal ?? null,
    now: minuteTick,
  });

  return (
    <div
      ref={rootRef}
      className={`overlay-root${editing ? ' editing' : ''}`}
      /*
       * Appearance as two custom properties, set once here.
       *
       * Every widget inherits them, so a future widget is styled correctly by
       * doing nothing, and a change is one assignment rather than a sweep
       * through every panel. They affect colour only -- nothing here is a size,
       * so changing them cannot move anything.
       */
      style={
        {
          '--overlay-bg-opacity': String(state?.appearance?.backgroundOpacity ?? 0.72),
          '--overlay-text-opacity': String(state?.appearance?.textOpacity ?? 1),
        } as React.CSSProperties
      }
      // Focusable so Escape reaches the document while editing. -1 keeps it out of
      // the tab order, since the overlay is not a normal navigable surface.
      tabIndex={-1}
    >
      {editing && (
        <div className="edit-banner">
          <span>Edit mode — drag widgets to reposition them.</span>
          <button type="button" className="edit-done" onClick={exitEditMode}>
            Done
          </button>
          <span className="edit-hint">or press Esc</span>
        </div>
      )}

      {(widgets?.context ?? true) && (
        <Widget id="context" title="Current Context" pos={layout.context} editing={editing} onMove={move}>
          {state === null ? (
            <div className="row muted">Waiting for journal state…</div>
          ) : (
            <>
              <Row label="CMDR" value={state.commander} />
              <Row label="System" value={state.starSystem} />
              {/* Body is sent as null when it merely repeats the station. */}
              {state.body && <Row label="Body" value={state.body} />}
              <Row label="Station" value={state.station} />
              {state.jumpTarget && (
                <Row
                  label="Next jump"
                  value={state.jumpTarget}
                  nav
                  meta={state.remainingJumps !== null ? `${state.remainingJumps} left` : null}
                />
              )}

              {state.context && (
                <div className="context">
                  <div className="context-title">{state.context.title}</div>
                  {state.context.subtitle && <div className="context-sub">{state.context.subtitle}</div>}
                  {/*
                    Beginner explanation. Same facts as Standard mode, with a
                    sentence saying what the mechanic is -- never an article; the
                    depth stays on EDFM.
                  */}
                  {state.guidance === 'new-cmdr' && state.context.guidance && (
                    <div className="context-guidance">{state.context.guidance}</div>
                  )}
                  {state.context.actions.length > 0 && (
                    <ul className="context-actions">
                      {state.context.actions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  )}
                  {state.context.resources.length > 0 && (
                    <div className="context-links">
                      {/*
                        Labels only, not clickable. The overlay is click-through in
                        normal play, so a link here could never be followed — showing
                        one would promise an interaction that cannot happen.
                      */}
                      {state.context.resources.map((r) => (
                        <span key={r.url} className="context-link">
                          {r.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {(state.alsoActive?.length ?? 0) > 0 && (
                    <ul className="context-also">
                      {(state.alsoActive ?? []).map((c) => (
                        <li key={c.title}>
                          <span className="context-also-title">
                            <span className="context-also-mark" aria-hidden="true">
                              &#9670;
                            </span>
                            {c.title}
                          </span>
                          {c.subtitle && <span className="context-also-sub">{c.subtitle}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {state.context.note && (
                    <div className="context-note">
                      <span className="note-label">EDFM</span>
                      {state.context.note}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Widget>
      )}

      {(widgets?.missions ?? true) && state !== null && (
        <Widget id="missions" title="Missions" pos={layout.missions} editing={editing} onMove={move}>
          <MissionsWidget missions={state.missions} />
        </Widget>
      )}

      {/* Only rendered when a jump is actually scheduled: an empty countdown widget
          is pure clutter over a game window. */}
      {/* Opt-in, and only when something has actually been recorded. */}
      {/*
        Live progress wins over the newest recorded entry. They answer different
        questions -- "what am I in the middle of" versus "what did I last
        finish" -- and showing the second while the first exists is what made
        this widget read as a copy of Current Context.

        The title follows the content for the same reason: a panel headed "Field
        Journal" showing a sample counter describes itself wrongly.
      */}
      {widgets?.liveJournal === true && panel !== null && (
        <Widget
          id="liveJournal"
          title={liveJournalTitle(panel)}
          pos={layout.liveJournal}
          editing={editing}
          onMove={move}
        >
          {panel.kind === 'exobiology' ? (
            <LiveExobiologyWidget live={panel.live} />
          ) : (
            <LiveJournalWidget journal={panel.journal} />
          )}
        </Widget>
      )}

      {(widgets?.carrierJump ?? true) &&
        state !== null &&
        (state.carrierJumps?.length ?? 0) > 0 && (
          <Widget
            id="carrierJump"
            title="Carrier Jump"
            pos={layout.carrierJump}
            editing={editing}
            onMove={move}
          >
            <CarrierJumpWidget jumps={state.carrierJumps} />
          </Widget>
        )}
    </div>
  );
}

/* --------------------------------------------------------------- widgets */

function Widget({
  id,
  title,
  pos,
  editing,
  onMove,
  children,
}: {
  id: WidgetId;
  title: string;
  pos: Point;
  editing: boolean;
  onMove: (id: WidgetId, p: Point) => void;
  children: React.ReactNode;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (!editing) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    // Clamp so a widget cannot be dragged off the game window and lost.
    onMove(id, {
      x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)),
    });
  }

  function onPointerUp(e: React.PointerEvent) {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  return (
    <div
      className="widget"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="widget-title">
        <span className="dot" aria-hidden="true">
          ◆
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

function MissionsWidget({ missions }: { missions: OverlayMissions }) {
  if (missions.active === 0) {
    return <div className="row muted">No active missions</div>;
  }

  return (
    <>
      <div className="mission-summary">
        <span>
          <strong>{missions.active}</strong> active
        </span>
        {missions.cargo > 0 && (
          <span>
            <strong>{missions.cargo}</strong> t cargo
          </span>
        )}
        {missions.expiringSoon > 0 && (
          <span className="urgent">
            <strong>{missions.expiringSoon}</strong> expiring
          </span>
        )}
      </div>

      {missions.nextStop && (
        <div className="next-stop">
          <div className="next-stop-label">Most missions at</div>
          <div className="next-stop-where">
            {missions.nextStop.system}
            {missions.nextStop.station ? ` · ${missions.nextStop.station}` : ''}
          </div>
          <div className="next-stop-meta">
            {missions.nextStop.missions} missions
            {missions.nextStop.cargo > 0 &&
              ` · ${missions.nextStop.cargo} t${missions.nextStop.cargoIncomplete ? '+' : ''}`}
            {missions.nextStop.kills > 0 && ` · ${missions.nextStop.kills} kills`}
            {missions.nextStop.expiry && ` · ${missions.nextStop.expiry}`}
          </div>
        </div>
      )}

      <div className="mission-rows">
        {missions.rows.map((m) => (
          <div key={m.id} className="mission-row">
            <div className="mission-row-head">
              <span className="mission-row-name">{m.name}</span>
              <span className={m.expiry === 'Expired' ? 'mission-row-exp urgent' : 'mission-row-exp'}>
                {m.expiry ?? '—'}
              </span>
            </div>
            <div className="mission-row-meta">
              {m.destination ?? <span className="unknown">No destination given</span>}
              {m.cargo && ` · ${m.cargo}`}
            </div>
            {/* Labelled here for the same reason as in the main window: everything
                else on the row came from the journal, this did not. */}
            {m.note && (
              <div className="mission-row-note">
                <span className="note-label">EDFM</span>
                {m.note}
              </div>
            )}
          </div>
        ))}
      </div>

      {missions.more > 0 && <div className="mission-more">+{missions.more} more in the app</div>}
      {missions.withoutDestination > 0 && (
        <div className="mission-more">
          {missions.withoutDestination} with no destination given
        </div>
      )}
    </>
  );
}

function Row({
  label,
  value,
  meta,
  nav,
}: {
  label: string;
  value: string | null;
  /** Subordinate detail after the value, e.g. "3 left". */
  meta?: string | null;
  /** Marks a row that describes where the commander is *going*, not where they are. */
  nav?: boolean;
}) {
  return (
    <div className={nav ? 'row row-nav' : 'row'}>
      <span className="row-label">{label}</span>
      {/* Unknown stays visibly Unknown here too — the overlay must not imply
          knowledge the journal did not provide. */}
      <span className={value ? 'row-value' : 'row-value unknown'}>
        {/* A glyph as well as a colour: the distinction must survive a display
            where the accent is hard to pick out. */}
        {nav && value && (
          <span className="row-nav-glyph" aria-hidden="true">
            &#9656;
          </span>
        )}
        {value ?? 'Unknown'}
        {meta && <span className="row-meta">{meta}</span>}
      </span>
    </div>
  );
}
