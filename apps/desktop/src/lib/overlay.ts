/**
 * Overlay control surface for the main window.
 *
 * The overlay is driven from here: the main window owns the journal engine and
 * pushes state across, so there is exactly one ingest pipeline.
 */

import { invoke } from '@tauri-apps/api/core';
import type { GuidanceMode } from '@edfm/context';
import { listen } from '@tauri-apps/api/event';

export interface EliteWindowInfo {
  found: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
  is_foreground: boolean;
  is_minimised: boolean;
  monitor_width: number;
  monitor_height: number;
  covers_monitor: boolean;
}

export interface DisplayModeInfo {
  /** Raw `<FullScreen>` value from Elite's own settings; null when unreadable. */
  raw: number | null;
  mode: 'windowed' | 'fullscreen' | 'borderless' | 'unknown';
  /**
   * Whether a non-injecting overlay can be expected to draw over this mode.
   * `null` means we genuinely do not know — not "probably fine".
   */
  overlay_supported: boolean | null;
  detail: string;
}

export interface OverlayContext {
  title: string;
  subtitle: string | null;
  actions: readonly string[];
  note: string | null;
  /** Beginner explanation. Sent always; drawn only in New CMDR mode. */
  guidance: string | null;
  resources: ReadonlyArray<{ label: string; url: string }>;
}

/** Which widgets the overlay should render. Owned by the main window, pushed here. */
export interface OverlayWidgets {
  context: boolean;
  missions: boolean;
  /**
   * Whether mission rows carry EDFM's editorial guidance.
   *
   * A sub-option of Missions, not a panel of its own -- it has no position, no
   * frame and nothing to drag. The settings UI disables it when Missions is off,
   * because a toggle that cannot do anything is worse than no toggle.
   */
  edfmNotes: boolean;
  /** Countdown to a scheduled jump on one of the commander's own carriers. */
  carrierJump: boolean;
  /**
   * Recent activity from the field journal.
   *
   * Off by default. Every other widget answers "what is true now"; this one is
   * the newest thing recorded, which is useful to some commanders and clutter to
   * others -- so it is opt-in rather than something to discover and turn off.
   */
  liveJournal: boolean;
}

export const DEFAULT_WIDGETS: OverlayWidgets = {
  context: true,
  missions: true,
  edfmNotes: true,
  carrierJump: true,
  liveJournal: false,
};

/**
 * Overlay appearance, as fractions rather than percentages.
 *
 * Background and text are separate on purpose. One control that dims both is the
 * thing that makes an overlay unreadable: a commander who wants a fainter panel
 * almost never wants fainter text.
 */
export interface OverlayAppearance {
  /** Panel background alpha. */
  readonly backgroundOpacity: number;
  /** Text and icon alpha. */
  readonly textOpacity: number;
}

/**
 * Bounds.
 *
 * Background may go to fully transparent -- text on bare game imagery is a real
 * preference, and the text keeps its own shadow.
 *
 * Text may not. Below roughly a third it stops being legible over bright
 * scenery, and an overlay the commander cannot read but has not noticed is
 * worse than one they turned off deliberately.
 */
export const APPEARANCE_BOUNDS = {
  background: { min: 0, max: 1 },
  text: { min: 0.35, max: 1 },
} as const;

/** Matches the styling that shipped before this was configurable. */
export const DEFAULT_APPEARANCE: OverlayAppearance = {
  backgroundOpacity: 0.72,
  textOpacity: 1,
};

export function clampNumber(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.max;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Parse a stored setting, falling back rather than letting a bad row blank the overlay. */
export function clampOpacity(
  stored: string | null,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (stored === null) return fallback;
  const n = Number(stored);
  return Number.isFinite(n) ? clampNumber(n, bounds) : fallback;
}

/**
 * What the Live Journal widget shows.
 *
 * Deliberately one entry plus a count, not a history. The overlay answers "what
 * did I just record"; the Journal screen is where a commander reads back.
 */
export interface LiveJournalState {
  readonly title: string;
  readonly detail: string | null;
  readonly systemName: string | null;
  readonly bodyName: string | null;
  /** ISO 8601. The overlay decides for itself when this has gone stale. */
  readonly occurredAt: string;
  /** How many entries were recorded at this same body. */
  readonly hereCount: number;
  /** Total recorded since the app started, for the collapsed state. */
  readonly sessionCount: number;
}

/** A scheduled jump for one of the commander's own carriers. */
export interface OverlayCarrierJump {
  carrierId: number;
  /** Human-readable name when known; the callsign otherwise. */
  name: string;
  system: string;
  body: string | null;
  /**
   * ISO 8601, exactly as the game stated it.
   *
   * Sent as an absolute instant rather than a pre-formatted duration, unlike
   * mission expiry. A countdown has to tick, and pushing a new string every second
   * to keep it moving would be absurd -- so the instant is the data and the
   * countdown is presentation, computed where it is drawn.
   */
  departureTime: string;
}

/**
 * Render a countdown to an absolute instant.
 *
 * Returns null past the point where a countdown is meaningful. The caller decides
 * what to say instead, because "departing" and "we lost track" are different
 * statements and neither is a number.
 */
export function countdownTo(departureTime: string, now: number): string | null {
  const target = Date.parse(departureTime);
  if (!Number.isFinite(target)) return null;

  const remainingMs = target - now;
  if (remainingMs <= 0) return null;

  const total = Math.floor(remainingMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface OverlayMissionRow {
  id: number;
  name: string;
  destination: string | null;
  /** Relative expiry, pre-formatted: the overlay has no clock of its own. */
  expiry: string | null;
  cargo: string | null;
  /** EDFM's editorial note, already filtered by the edfmNotes setting. */
  note: string | null;
}

export interface OverlayMissions {
  active: number;
  cargo: number;
  expiringSoon: number;
  withoutDestination: number;
  /** The destination with the most missions bound for it, if any. */
  nextStop: {
    system: string;
    station: string | null;
    missions: number;
    cargo: number;
    cargoIncomplete: boolean;
    kills: number;
    expiry: string | null;
  } | null;
  /** Capped: an overlay that lists forty missions is not readable in flight. */
  rows: readonly OverlayMissionRow[];
  /** How many active missions are not in `rows`. */
  more: number;
}

export interface OverlayPushState {
  commander: string | null;
  starSystem: string | null;
  station: string | null;
  body: string | null;
  docking: string | null;
  vehicle: string | null;
  /** Destination system while travelling; null when not on a route. */
  jumpTarget: string | null;
  /** Jumps left in the plotted route; null when no route is plotted. */
  remainingJumps: number | null;
  /** Highest-ranked context only; null when nothing is currently relevant. */
  context: OverlayContext | null;
  /**
   * Other contexts that are also true right now, title and subtitle only.
   *
   * The primary context gets links, actions and a note; these do not. Space over a
   * game window is scarce, and the point of these lines is awareness -- "there is
   * also a Material Trader here" -- not a second set of things to read.
   */
  alsoActive: { title: string; subtitle: string | null }[];
  carrierJumps: OverlayCarrierJump[];
  appearance: OverlayAppearance;
  /** Explanation level. Never changes which facts the overlay shows. */
  guidance: GuidanceMode;
  /** Newest recorded activity, or null. See the Live Journal widget. */
  liveJournal: LiveJournalState | null;
  missions: OverlayMissions;
  widgets: OverlayWidgets;
}

export const overlayApi = {
  eliteWindow: () => invoke<EliteWindowInfo>('elite_window_info'),
  displayMode: () => invoke<DisplayModeInfo>('elite_display_mode'),
  start: (hideWhenInactive: boolean) =>
    invoke<void>('overlay_start', { hideWhenInactive }),
  stop: () => invoke<void>('overlay_stop'),
  setEditMode: (editing: boolean) => invoke<void>('overlay_set_edit_mode', { editing }),
  pushState: (payload: OverlayPushState) => invoke<void>('overlay_push_state', { payload }),
};

function subscribe<T>(event: string, fn: (payload: T) => void): () => void {
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<T>(event, (e) => fn(e.payload)).then((f) => {
    if (disposed) f();
    else stop = f;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}

/** Subscribe to game-window updates emitted by the tracking thread. */
export function onEliteWindow(fn: (info: EliteWindowInfo) => void): () => void {
  return subscribe<EliteWindowInfo>('overlay://elite-window', fn);
}

/**
 * Subscribe to edit-mode changes.
 *
 * Edit mode can be ended from inside the overlay, so any UI showing it must
 * follow this rather than tracking its own copy.
 */
export function onEditMode(fn: (editing: boolean) => void): () => void {
  return subscribe<boolean>('overlay://edit-mode', fn);
}
