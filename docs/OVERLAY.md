# Overlay

**Built.** This began as a design note, recorded because the brief asked for
overlay technique research before implementation.

## Hard constraints

From §31, these are not negotiable and not subject to "but it would work better if":

- No DLL injection into `EliteDangerous64.exe`.
- No code injection of any kind.
- No process memory reading or writing.
- No input automation, no botting.

The Companion is a read-only observer with an external window. Every overlay decision
below follows from that.

## Approach

A separate Tauri window, distinct from the main window:

| Property | Value |
|---|---|
| `transparent` | true |
| `decorations` | false |
| `alwaysOnTop` | true |
| `skipTaskbar` | true |
| `focus` | false |
| Click-through | `set_ignore_cursor_events(true)` in normal mode, `false` in edit mode |

Position is tracked against the Elite Dangerous window via Win32, so the overlay
follows the game as it moves and resizes. DPI is handled per-monitor: a window
dragged between displays of different scaling must not shift or blur.

## Detecting the game window (verified against a live client)

Measured against a running Elite Dangerous 4.4.0.3 client:

| Property | Value |
|---|---|
| Window class | `FrontierDevelopmentsAppWinClass` |
| Window title | `Elite - Dangerous (CLIENT)` |
| Process | `EliteDangerous64.exe` |
| Style | `0x94020000` = `WS_POPUP \| WS_VISIBLE \| WS_CLIPSIBLINGS \| WS_MINIMIZEBOX` |
| ExStyle | `0x00000000` |
| Window rect | `0,0 → 3840,2160`, client rect identical |
| Reported DPI | 96 |

We match on the **class name**, not the title: the title is localised, the class is
not. `ExStyle` carries no `WS_EX_TOPMOST`, which is why an always-on-top overlay can
sit above the game at all.

Window rect and client rect being identical, with no caption or thick-frame style,
is the geometric signature of borderless. Positions are handled in **physical
pixels** throughout (Win32 rects and Tauri's `PhysicalPosition`/`PhysicalSize`),
which sidesteps DPI scaling arithmetic entirely rather than trying to get it right.

## Reading the display mode instead of guessing

Elite records its own display mode in
`%LOCALAPPDATA%\Frontier Developments\Elite Dangerous\Options\Graphics\DisplaySettings.xml`:

```xml
<FullScreen>2</FullScreen>
```

This matters because **window geometry cannot distinguish borderless from exclusive
fullscreen** — both cover the monitor exactly. Reading Frontier's own setting answers
the question directly, so the application can warn accurately instead of guessing.

- `2` = **Borderless — confirmed empirically.** Observed alongside the window
  properties in the table above.
- `0` = Windowed and `1` = Fullscreen follow the ordering of Frontier's settings UI
  and are **not yet directly confirmed here**. Unrecognised values degrade to
  "unknown" and say so, rather than being coerced into a guess.

Note that `<ScreenWidth>` in the same file read `4096` while the actual window was
`3840` wide. **Do not use it for positioning** — the window rect is authoritative.

## The exclusive-fullscreen limitation

**We expect this not to work, and we will not claim otherwise until it is
demonstrated on real hardware.**

A DirectX application in true exclusive fullscreen owns the display's swapchain. The
desktop compositor is bypassed, so a normal layered top-most window has nothing to
compose onto. The techniques that *do* draw over exclusive fullscreen all work by
hooking or injecting into the game's present path — precisely what §31 forbids.

Therefore:

- **Borderless / windowed:** expected to work. This is the supported configuration.
- **Exclusive fullscreen:** expected not to work.

The application will detect the situation and tell the user plainly, recommending
Borderless, rather than rendering an invisible overlay and leaving them to guess.
§7 asks for exactly this: communicate the limitation instead of overpromising.

This claim is stated as an expectation because it has not yet been empirically tested
against Elite Dangerous on this hardware. That test was done, and
this document gets updated with the measured result either way.

## Licensing

EDMCOverlay and EDMC Modern Overlay are GPL-licensed. We have not read or copied
their source. If we ever want to study their behaviour, that is an intentional
licensing decision to be made deliberately, not by accident during implementation.

## Edit mode

Two modes, one window:

- **Normal:** click-through. Mouse input passes to the game; the overlay cannot
  be interacted with and cannot steal focus.
- **Edit:** accepts mouse input. Widgets become draggable and resizable, with layouts
  persisted to `overlay_layouts` in local SQLite.

## Widgets

Phase 2 builds the overlay *engine* plus exactly one trivial widget (Current
Context), to prove positioning, DPI, click-through and edit mode. Building eight
widgets against an unproven engine would mean rewriting eight widgets.

Planned afterwards, in rough priority order: Current Context, Mission Next Stop,
Mission Summary, Settlement Info, Research Session, Colonisation Needs, Market
Destination, Notifications.

## Performance

The overlay redraws only when the underlying state actually changes, or when an
animation genuinely requires a frame. It must not run a render loop. This matters
more here than anywhere else in the application: the overlay is, by definition,
always running while a game is running (§30).
