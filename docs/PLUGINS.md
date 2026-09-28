# Plugins

Status: **built.** Plugins contribute context rules and research projects, load
at startup, can be switched on and off individually, and can be reloaded
without restarting. They have their own screen in the app.

## Installing one

A plugin is a folder containing a `plugin.json`. Installing it means putting
that folder in the plugins directory.

1. Open the **Plugins** tab and press **Open plugins folder**, or just go
   straight to it:

   ```
   Documents\EDFM Companion\plugins
   ```

   The folder is created the first time the app runs, so it is always there.
   If your Documents folder cannot be used, the app falls back to its own data
   directory, and Settings tells you where it went and why.
2. Drop the plugin's folder inside, so you have:

   ```
   plugins/
     deep-core-mining/
       plugin.json
   ```

3. Press **Reload plugins**.

The full path on a typical Windows machine:

```
C:\Users\<you>\Documents\EDFM Companion\plugins\deep-core-mining\plugin.json
```

The Plugins screen then shows a card for it: description, version, author, the
rules it contributed **by name**, whatever instructions the author wrote, and a
switch to turn it off. If it did not load, it is listed anyway with the reason —
a plugin that silently did nothing is indistinguishable from one that was never
installed.

### Turning one off

Every plugin has a switch on its card. Off means it contributes nothing, takes
effect immediately without a restart, and survives one — but the plugin stays
installed and keeps its instructions. Turning something off should not mean
deleting it and having to find it again.

That is the whole install flow. No archives, no build step, no restart, and
nothing is downloaded or executed.

## Why it is safe to install a stranger's plugin

**A plugin is data, not code.** There is no way to ship JavaScript through this
system and no code path that would run it if you did. A plugin contributes
declarative rules that the engines already evaluate.

That is not a limitation dodging effort — it is why the system can be safe.
`@edfm/context` conditions have a fixed operator set, no `eval`, and
deliberately no regular expressions (a supplied pattern is a denial-of-service
vector). Those defences exist because rules were always meant to arrive from a
server that should not be trusted. A third-party plugin is the same threat
model, so the same hardening applies unchanged.

Concretely, an installed plugin **cannot**:

- read your journal, or any file
- make a network request
- run code of any kind
- see anything the spoiler system hides from you
- replace or disable a built-in context rule

### Plugins may not collect chat, friends or identity

§21 forbids the application from persisting chat, friends, private-group
membership or commander identity. A plugin able to define its own research
observations could quietly undo that by recording `ReceiveText` into the local
database.

So there is a denylist, and a plugin that asks for one of those events is
**refused outright** rather than silently stripped:

```
Research project "chatlog" observes ReceiveText, which carries chat, friends
or commander identity. Plugins may not collect these.
```

Refusing rather than editing is deliberate. An author who asked for chat should
be told, not have their plugin quietly altered into something else.

## Writing one

```json
{
  "manifestVersion": 1,
  "id": "com.example.deep-core-mining",
  "name": "Deep Core Mining Helper",
  "version": "1.0.0",
  "author": "CMDR Example",
  "description": "Surfaces mining pages when you prospect a core asteroid.",
  "contributes": {
    "contextRules": [
      {
        "id": "core-asteroid",
        "title": "Deep core asteroid",
        "when": {
          "kind": "all",
          "of": [
            { "kind": "event", "name": "ProspectedAsteroid" },
            { "kind": "field", "path": "MotherlodeMaterial", "op": "exists" }
          ]
        },
        "priority": 80,
        "ttlSeconds": 240,
        "endsOn": ["Docked", "FSDJump", "SupercruiseEntry"],
        "resources": [{ "label": "Core Mining", "page": "Mining" }]
      }
    ]
  }
}
```

### Matching inside an array

A `field` path may contain `*`, meaning **any element**:

```json
{ "kind": "field", "path": "Signals.*.Type", "op": "eq", "value": "$PlanetaryMiningLocation_Name;" }
```

Reach for this rather than a fixed index, because position is usually not stable.
The bundled surface-mining rule is the cautionary tale: that signal appears at index
0, 1 and 2 in the corpus (19 / 69 / 16 times), so `Signals.0.Type` would have matched
18% of the bodies that actually have one.

An empty array is false for every operator, `exists` included — "the array had
nothing to offer" is not "there is something". At most two `*` per path, and at most
64 values are gathered, so a path cannot buy unbounded work.

### Say what ends your context, not just how long it lasts

`ttlSeconds` is a **fallback**, for when nothing tells us the activity finished.
`endsOn` is the real answer: a list of journal event names that end the context
outright, however much TTL is left.

Get this wrong and your rule outstays its welcome. A commander already knows what
they just did — a context that lingers is not informing them, it is occupying the
space where something currently true should be. This is not hypothetical: before
`endsOn` existed, the bundled "Engineering" rule had a fifteen-minute TTL and
followed commanders across three systems, hiding the station they were actually
docked at.

Pick the events that prove the commander moved on. For something done in a ring,
that is `Docked`, `FSDJump`, `SupercruiseEntry`. For something done docked, it is
`Undocked` and `Liftoff`. Then be careful not to over-list: trading materials at an
Engineer is *part of* engineering, so `MaterialTrade` does not belong in its
`endsOn`.

Names are matched exactly against raw journal event names, so check yours actually
exists — `scripts/profile-journal.ps1` will tell you. At most 8 are kept.

### Telling people how to use it

A context rule is invisible until something in the game matches it, so "install
it and see" is not a usable instruction. Two places to explain yourself, and
both are shown on the plugin's card:

- **`instructions`** in the manifest — short, for a couple of paragraphs.
- **`README.md`** beside `plugin.json` — longer, and far nicer to write than a
  JSON string full of escaped newlines.

Both are displayed as **plain text**. Nothing is rendered as Markdown or HTML:
the text comes from a stranger, and text that can style itself is text that can
misrepresent itself as part of the application. Write for a monospace block —
blank lines and indentation survive, `# headings` will not become headings.

A complete working example, with both, is in
[`examples/plugins/deep-core-mining`](../examples/plugins/deep-core-mining).

Check it before installing — this runs exactly the validation the app runs, so
"passes here" and "will load there" are the same statement:

```bash
npx tsx packages/plugins/tools/check.mts examples/plugins/deep-core-mining
```

```
OK: Deep Core Mining Helper 1.0.0 (com.example.deep-core-mining)
   context rules:     2
     - com.example.deep-core-mining/core-asteroid  "Deep core asteroid"  ttl 240s
```

### Conditions

| Kind | Meaning |
|---|---|
| `event` | The journal event name, e.g. `Docked`. Accepts a list. |
| `field` | A dotted path into the raw event, with `exists`, `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte` |
| `state` | The same, against current commander state |
| `service` | A case-folded station service id is present, e.g. `materialtrader` |
| `all` / `any` / `not` | Combine the above |

There is no regular-expression operator, and there will not be one.

A rule may also carry `actions` (a short list of imperative steps the
commander can act on right now, capped at 4) and `note` (one editorial
remark, shown with an "EDFM Note:" prefix). Both are optional and, like every
other rule field, clamped by `sanitise()` before they reach the UI.

### Ids are namespaced for you

Your rule `core-asteroid` becomes `com.example.deep-core-mining/core-asteroid`.
Two plugins can use the same short id without colliding, and no plugin can
shadow a built-in rule. If a namespacing bug ever let an id collide, built-ins
are merged first so the shipped rule wins.

### Limits

Enforced per plugin, because a plugin folder is user-supplied input:

| Limit | Value |
|---|---|
| Plugins considered | 50 |
| Context rules per plugin | 200 |
| Research projects per plugin | 10 |
| Manifest size | 512 KB |
| Rule TTL | clamped to 24 hours |

Exceeding a limit is a warning and a truncation, not a rejection — the plugin
still loads, and Settings says what was dropped.

## When the folder is not where you expect

Two situations move or hide plugins. Both are reported in Settings rather than
left to guess at, because "no plugins installed" and "your plugin could not be
read" must not look the same.

**OneDrive.** A redirected Documents folder can hold `plugin.json` as an
online-only placeholder. The file looks present, and reading it fails while you
are offline or signed out — so the plugin is installed, appears installed, and
does nothing. Settings names the folder and says:

> OneDrive is storing this plugin online-only, so it could not be read.
> Right-click the folder and choose "Always keep on this device", or reconnect
> and try again.

**Linux without a Documents folder.** `xdg-user-dirs` is not installed
everywhere, and a stale entry in `user-dirs.dirs` can point at a path that no
longer exists. The app checks the folder is genuinely usable by writing a probe
file, because creating a directory can succeed on a read-only home or a removed
drive and still be unusable. If it is not, plugins fall back to the application
data directory and Settings says so.

Opening the folder tries `xdg-open`, `gio`, `nautilus`, `dolphin`, `thunar` and
`nemo` in turn — `xdg-open` ships with xdg-utils, which the same minimal
installs that lack a Documents folder also tend to lack. If none is present,
the error names the path so it can be copied.

## What is deliberately not pluggable

**Confidence thresholds.** A plugin quietly loosening them would make the app
recommend a twenty-hour-old market as trustworthy, and that failure is
invisible to the commander at exactly the moment they are deciding to fly forty
light years. Thresholds stay application- and server-controlled.

**Anything requiring code.** Verification providers and overlay widgets are
real extension points in the codebase, but exposing them means executing
third-party code with the app's privileges — which would hand a plugin author
the whole journal and the ability to defeat spoiler protection. If that becomes
worth doing, it belongs in a capability-stripped window like the overlay
already uses, not in this system.

## For maintainers

- `@edfm/plugins` holds the manifest schema and validation. It is pure and
  tested; nothing in it touches the filesystem.
- `plugins.rs` reads one directory, one level deep, and returns text. Recursing
  would let a plugin hide manifests inside another plugin's folder, which makes
  "which plugin contributed this" unanswerable.
- The folder is `Documents/EDFM Companion/plugins`, not app data, and is named
  for people rather than by bundle identifier. Installing a plugin means someone
  putting a folder somewhere, and somewhere they can find unaided beats
  somewhere technically tidier — `Documents\EDFM Companion\plugins` can be
  described over voice chat; `%APPDATA%\com.edfieldmanual.companion\plugins`
  cannot. It falls back to app data on a platform with no Documents folder. The
  SQLite database stays in app data either way, since nobody should be
  hand-editing that.
- Loading happens before ingest starts, so a contributed rule is live for the
  first journal line rather than the second.
- The loader never throws. A plugin system that can stop the app from starting
  is worse than no plugin system.
