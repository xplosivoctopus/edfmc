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

## The overlay as a workspace

Independently controlled widgets, not one panel. Each has its own visibility
setting, its own remembered position, and inherits the same appearance.

| Widget | Default | What it answers |
|---|---|---|
| Current Context | on | What is relevant right now |
| Missions | on | What is outstanding |
| Carrier Jump | on | When your carrier leaves |
| Live Journal | **off** | What was just recorded |

`EDFM notes` is deliberately absent from that table: it is a **sub-option of
Missions**, not a panel. It has no position, no frame and nothing to drag, and the
settings UI disables it when Missions is off rather than offering a toggle that
cannot act.

Live Journal is off by default because it is the only widget that does not answer
"what is true now" -- it is the newest thing recorded, which some commanders want
in view and others would immediately switch off.

### Appearance

Two settings, deliberately not one.

```
--overlay-bg-opacity     panel background alpha   0 .. 1     default 0.72
--overlay-text-opacity   text and icon alpha      0.35 .. 1  default 1
```

Set once on the overlay root, so every widget inherits them and a future widget is
styled correctly by doing nothing. One combined "overall opacity" control is the
thing that makes an overlay unreadable: a commander who wants a fainter panel
almost never wants fainter text.

Background may reach fully transparent -- text on bare scenery is a real
preference, and the text keeps its own shadow. **Text may not.** Below roughly a
third it stops being legible over bright scenery, and an overlay the commander
cannot read but has not noticed is worse than one they switched off deliberately.

Verified by measurement across the four extremes: the background changes while
text opacity stays at 1, text changes while the background stays at 0.72, and all
four render at **identical dimensions** -- these are colour properties only, so no
opacity change can move anything.

Settings shows a live preview using the same two variables, so opacity can be
judged without alt-tabbing into Elite.

### Live Journal lifecycle

The widget shows one of two things, and which one depends on whether the commander
is in the middle of something.

**Live activity, when there is any.** Currently exobiology sampling: the organism,
its variant colour, the sample count and the body.

```
◆ EXOBIOLOGY

Stratum Tectonicas
Emerald

Sample 2 / 3
Nervi 4 a
```

When the body has been surface-scanned, the panel also lists what else is on it,
so a genus the commander has not found yet is visible rather than implied:

```
◆ EXOBIOLOGY

Fonticulua Campestris
Amethyst

✓ Sample complete   3 / 3
 · Bacterium              Unscanned
Wregoe LS-N b51-0 A 7 g
```

The genus being sampled is left out of that list — it is already the headline.
A body with no surface scan shows no list at all, because without a scan there is
no list, and an empty one is not a claim that nothing else is there.

**Unfinished business keeps the panel up.** Once a specimen is done, the useful
thing on screen is no longer the completion but the genus still untouched a few
hundred metres away, so the five-minute collapse is suspended while anything on
this body is unscanned. When everything is collected, it ages out as before.

**The newest recorded entry, otherwise.** Titled *Field Journal*, with the same
lifecycle as before:

- **Recent** (under five minutes): system, body, the entry, and how many entries
  were recorded at that body.
- **Older**: collapses to `N activities recorded`.

It does not disappear, because an empty panel that used to have content reads as a
bug; and it does not keep asserting something from half an hour ago, which is the
stale-context problem this project has fixed once already.

#### Why live progress takes precedence

Before this, the widget only ever showed the newest *completed* entry — which
during an exobiology run meant "biological signals detected" or "landed". Current
Context already says both, so the panel was spending screen space over a game to
repeat its neighbour.

The sample counter is the thing nothing else on screen can say. So when a run is
open it wins, and the title follows the content: a panel headed *Field Journal*
showing a sample counter describes itself wrongly.

The precedence is a function — `liveJournalPanel` in `src/lib/overlay.ts` — rather
than a condition inside the markup, so the decision the widget's usefulness depends
on is asserted by tests directly.

#### What it will not claim

When the app is started midway through a run, the stage count cannot be
established: the reader resumes from a byte offset rather than replaying history,
so the first event seen may be the second or the third sample. The widget then
shows `Sampling` with the organism and **no number**, because a wrong `1 / 3` would
say two samples remain when one does.

`docs/ACTIVITY-JOURNAL.md` has the measurements behind the sequence and the reset
rules, including the one that rests on a single observation.

### Carrier jump: when a countdown ends

Three signals end a pending jump, because one was not enough.

| Signal | Meaning |
|---|---|
| `CarrierLocation` at the destination | Arrived |
| `CarrierLocation` anywhere, after the departure time | No longer pending |
| `CarrierJump` with a matching MarketID | The commander watched it happen |

The second exists because of a real bug: clearing required an exact match with the
destination, so a squadron carrier that arrived kept reading **DEPARTING**.
Measured over 138 real requests, five reported a *different* system next -- the
carrier had moved on again, or the report came from a later session. Past the
departure time, whatever the carrier says about where it is, it is not still
waiting to leave. Clearing then does not claim it arrived; it stops asserting a
departure that is over.

An unconfirmed departure stops displaying after **ten minutes**. 93% of real jumps
confirm within five minutes of the stated departure (median: zero); past that the
commander is almost certainly offline and confirmation may be hours away, so
continuing to say "Departing" tells them nothing true.

## Guidance in the overlay

New CMDR Mode adds one line of explanation to a context, drawn from the rule's own
`guidance.beginner`. Same facts, same resources -- one extra sentence saying what
the mechanic is. Never an article: EDFM is the reference, and the overlay is over
someone's game.
