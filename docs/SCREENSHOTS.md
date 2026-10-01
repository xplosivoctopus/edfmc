# Screenshot capture and cataloguing

A screenshot tool that saves a numbered file is a solved problem. What is
missing is knowing, six months later, what the picture was *of*.

So the hotkey means **"catalogue this"**, not merely "capture this". EDFM
Companion fills in what it can see, and the commander says what it actually
shows.

**The core rule:** the app knows where you are and what you were doing. It
cannot see your screen. A Stratum sample in progress is good evidence the
screenshot is of a Stratum — and no evidence at all if you turned the camera to
photograph the sunset. Nothing here decides on your behalf.

---

## The hotkey

**There is no default.** Nothing is bound until you choose a combination.

Elite setups are crowded — keyboard, HOTAS, head tracking, voice — and silently
claiming a key combination could break something you rely on in flight. So the
feature ships inert.

*Settings → Screenshots → Capture hotkey → Set*, then press the combination you
want. It is stored and re-bound on every launch. **Clear** removes it, and the
feature goes back to doing nothing.

A binding needs **a modifier and one key**. A bare key would fire while you were
typing a system name into a search box.

If Windows refuses the combination — usually because another application already
owns it globally — the old binding is put back and you are told, rather than
being left with a setting that reads as active and does nothing.

---

## How capture works, and what it will not do

Captured through **GDI `BitBlt` from the screen device context**: a read of what
the desktop compositor is already showing.

Elite Dangerous is not touched. **No DLL injection, no process memory access, no
DirectX hooking, no input automation, and no modification of the game's own
screenshot system.** The same discipline the overlay follows, for the same
reason: an anti-cheat-visible technique is not worth a convenience feature.

Three approaches can capture a screen without touching the target process:

| Approach | Verdict |
|---|---|
| **GDI `BitBlt`** | Chosen. Pure read, public API, no new system dependencies. |
| Windows.Graphics.Capture | Better with exclusive fullscreen; pulls in WinRT interop for one feature. |
| DXGI Desktop Duplication | Also capable; also a Direct3D device to own. |

`BitBlt` is the smallest thing that does the job and the one whose failures are
easiest to explain. The others remain a reasonable upgrade later.

### What is captured

The **Elite window's rectangle** when the game is running — so a second monitor,
the taskbar and anything overlapping are excluded. In Borderless the rectangle
already covers the whole monitor. If Elite is not running or is minimised, the
primary monitor is captured instead.

### The exclusive-fullscreen limitation

**Exclusive Fullscreen is expected to produce a black or flat image.**

A Direct3D application in true exclusive fullscreen owns the display's swapchain
and bypasses the desktop compositor, so a GDI read of the screen has nothing to
copy. This is the same limitation the overlay has, for the same underlying
reason.

This is stated as an expectation, not a measurement: it follows from how
exclusive fullscreen works, and this project does not claim verified behaviour it
has not verified.

What it *does* do is **notice**. If the captured image is a single flat colour,
the dialog says so and suggests Borderless, instead of filing a black rectangle
and letting you discover it next month.

**Borderless and Windowed are the supported configurations.**

---

## The capture workflow

1. Press your hotkey.
2. The image is written immediately to a **staging file**.
3. A small form opens **over the game**, centred on the monitor Elite is on.
4. You confirm or correct what it is.
5. The file is renamed into your screenshot folder and catalogued.

The image is on disk from step 2 onwards. A cancelled form, a rejected filename
or an unavailable folder **cannot lose the screenshot** — the worst case is a
file left under a temporary name.

### The overlay is not in the picture

EDFM Companion's own overlay is **hidden for the moment of capture** and restored
immediately. The capture reads the composited screen, so anything drawn over the
game would otherwise land in the image — and a vista with a sample counter
stamped across it is not the screenshot you wanted.

The restore is tied to a `Drop` guard rather than a line after the capture, so it
happens even if the capture fails. An overlay left hidden because a screenshot
errored would look like the overlay had broken.

An overlay that was already hidden — switched off, or auto-hidden because the
game is not focused — is left alone, so capturing never becomes a way of
summoning it.

**Only this app's overlay can be hidden.** Discord, Steam, GeForce Experience and
screen recorders draw their own, and those are outside this app's control.

There is a brief settle wait (80 ms) after hiding, because `hide()` returns
before the desktop compositor has redrawn. It is a heuristic, not a signal:
Windows offers no event meaning "the compositor has finished".

### Where the form appears

In **Borderless**, the form draws over Elite and the game keeps rendering behind
it. You answer one question without leaving the cockpit view. `Esc` cancels.

It takes keyboard focus while it is open, because you type into it — so Elite
stops receiving input for those few seconds. That is unavoidable for any form.
When it closes, Windows returns focus to what had it before.

In **Fullscreen**, nothing can draw over an exclusive-fullscreen swapchain — the
same limitation as the overlay, and capture does not work there either.

**The overlay is not used for this and is never made interactive.** It stays
click-through throughout. Making it interactive for a form and restoring it
afterwards is exactly the state that gets left switched on when an error path is
taken; a separate window cannot leave the overlay in a bad state. A test asserts
that nothing in the screenshot path touches the overlay's click-through.

The capture window has **no database, filesystem or network access**. It receives
the draft by event and sends your answer back the same way; the main window does
the saving. If that window cannot be shown for any reason, the same form appears
in the main window instead — a capture is never left unanswerable.

---

## What gets prefilled, and why it says why

Every suggestion carries its reason, so overriding one is an informed choice
rather than a fight with the app.

| Situation | Category | Subject |
|---|---|---|
| Sampling biology | Exobiology | **The specimen** — species and variant |
| Docked | Station | The station |
| At a settlement | Settlement | The settlement |
| On or near a body | Exploration | **Nothing** |
| Anything else | Other | **Nothing** |

The last two rows are the point. Standing on a body says where you are and
nothing about what is in frame — you might be photographing your ship, the
rings, or a menu. **A subject is only ever proposed when something actively
identifies one.**

Location is prefilled where known and is **never mandatory**. A menu or a ship
portrait may have no meaningful place.

---

## Journal linking

If something was recorded in your Activity Journal within the last ten minutes,
the dialog **offers** to attach the screenshot to it. The box starts unticked.

An entry from two hours ago is not what the screenshot is of, and offering it
would train you to click past the link rather than read it. A screenshot is
perfectly valid with no link at all.

---

## Filenames

Proposed as **subject – place – timestamp**, most specific first, so a folder
sorted by name groups the same subject together:

```
Bacterium Vesicula — Gold - Wregoe XX-X d1-42 3 A - 2026-09-30 14-22-18.png
```

Empty parts are dropped rather than leaving ` -  - ` gaps. You can edit the name
before saving, or press **Keep original name** to catalogue the file where it
landed without renaming.

The rules:

- Characters Windows reserves (`< > : " / \ | ? *` and control characters) are
  **replaced with `-`**, not stripped, so `3/A` becomes `3-A` rather than `3A`.
- Trailing dots and spaces are removed — Windows accepts them through some APIs
  and then cannot delete the file through Explorer.
- Reserved device names (`CON`, `NUL`, `LPT1`…) are prefixed, because `CON.png`
  cannot be created at all.
- Names are capped at 120 characters, **and the timestamp is never truncated** —
  the tail is what keeps names distinct.
- Collisions become `(2)`, `(3)` and so on. **An existing screenshot is never
  overwritten.**

---

## Where the files live

Default: **`Pictures\EDFM Companion\Screenshots`**, resolved through the Windows
known-folder API rather than by appending "Pictures" to your user profile — the
folder is relocatable, and on a machine where it has been moved a string-built
path is simply wrong.

You can change it in Settings. The folder is tested by actually writing to it: a
disconnected network drive reads as plausible and fails on use.

**Images are never copied into this application's data.** Your screenshots stay
somewhere you can find them without knowing this app exists, and uninstalling it
leaves them untouched.

---

## What is stored locally

The catalog holds **metadata and a file path**. No image bytes are in the
database, and there is no column that could hold them.

| Stored | |
|---|---|
| File path, captured time, dimensions | Category, subject |
| System, body, station | Tags, note |
| Optional Journal link | What the app believed at capture time |

That last one is kept so a bad *suggestion* can later be told apart from a bad
*choice*.

**Commander-scoped.** A screenshot can show a ship, a carrier, your finances or
an entire HUD, so one commander's catalog is not visible to another on the same
machine.

---

## Privacy

Screenshots are the most sensitive thing this app touches. A single frame can
contain a real name on a second monitor, a location, finances, or anything else
that happened to be on screen.

- **Nothing is uploaded. Ever.** Not images, not notes, not metadata — not to
  EDFM, EDDN, EDSM, Inara, EDAstro, or any plugin. A test asserts that no
  network call exists anywhere in this feature's code, and that the names of
  those services do not appear in it.
- **Paths stay out of the logs.** A screenshot path names a folder under your
  account and usually your Windows username. Diagnostics say what failed, never
  where; anything path-shaped is replaced before a message is recorded.
- If image sync is ever built, it will be a **separate, explicit** privacy
  decision — never a side effect of cataloguing.

---

## The browser

*Screenshots* in the sidebar: recent captures, filterable by category and by
free text across subject, system, body and tags.

Two deletions, deliberately distinct:

- **Remove from catalog** — forgets the entry. The image is untouched.
- **Delete image** — removes the file from disk, after a confirmation.

One is reversible by re-cataloguing. The other is not.

---

## Limitations and what is deferred

- **Exclusive fullscreen** — see above. Detected and reported, not supported.
- **Thumbnails** — not generated. Deferred rather than shipping a cache that
  duplicates image data.
- **Importing existing screenshots** — designed for, not built. No folder is
  ever scanned without being asked.
- **Elite's own `Screenshot` journal event** — investigated and **not used**.
  The corpus contains exactly **one**, far too little to design against, and its
  `Filename` is a relative path to Elite's own `.bmp` capture, which is a
  different file from ours. It also would not establish what a picture shows,
  which is the question this feature exists to answer.
- **Quick-save mode** — the model allows it later; the first version always
  asks.
- Cloud upload, public galleries, image recognition, OCR and automatic intent
  detection are all out of scope.
