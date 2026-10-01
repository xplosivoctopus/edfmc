/**
 * Screenshots: the confirmation dialog and the catalog browser.
 *
 * The dialog is the whole point of the feature. A screenshot tool that saves a
 * numbered file is a solved problem; what is missing is knowing, six months
 * later, what the picture was *of*. So the hotkey means "catalogue this", and
 * this is where the commander says what it is.
 *
 * Everything prefilled is labelled with why. The app can see where the
 * commander is and what they were doing; it cannot see what is on screen, and
 * presenting a guess as a fact would make the catalog untrustworthy exactly
 * where it is supposed to be useful.
 */

import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { useEffect, useMemo, useState } from 'react';

import {
  SCREENSHOT_CATEGORIES,
  categoryLabel,
  describeHotkey,
  placeName,
  proposeFilename,
  type ScreenshotRecord,
} from './lib/screenshots.js';
import { logger } from './lib/logger.js';
import type {
  CompanionSnapshot,
  ScreenshotDraft,
  ScreenshotSaveRequest,
} from './lib/companion.js';

/* --------------------------------------------------------------- dialog */

/**
 * The in-window fallback.
 *
 * Normally the form opens in its own always-on-top window over the game. This
 * renders the same form in the main window for the case where that window could
 * not be shown -- a capture is never left unanswerable.
 */
export function ScreenshotDialog({ snap }: { snap: CompanionSnapshot }) {
  const draft = snap.screenshots.draft;
  if (!draft || !snap.screenshots.draftInMainWindow) return null;
  return (
    <div className="shot-backdrop" role="dialog" aria-modal="true" aria-label="Screenshot captured">
      <div className="shot-dialog">
        <ScreenshotForm
          key={draft.stagingPath}
          draft={draft}
          folder={snap.screenshots.folder}
          error={snap.screenshots.lastError}
          onSave={(request) => void snap.saveScreenshot(request)}
          onCancel={snap.discardScreenshotDraft}
        />
      </div>
    </div>
  );
}

/**
 * The form itself, with no idea which window it is in.
 *
 * Shared so there is exactly one implementation of the question this feature
 * exists to ask. A second copy in the capture window would drift, and the two
 * would disagree about what was prefilled.
 */
export function ScreenshotForm({
  draft,
  folder,
  error,
  onSave,
  onCancel,
}: {
  draft: ScreenshotDraft;
  folder: string | null;
  error: string | null;
  onSave: (request: ScreenshotSaveRequest) => void;
  onCancel: () => void;
}) {
  const s = draft.suggestion;

  const [category, setCategory] = useState(s.category.value);
  const [subject, setSubject] = useState(s.subject?.value ?? '');
  const [systemName, setSystemName] = useState(s.systemName ?? '');
  const [bodyName, setBodyName] = useState(s.bodyName ?? '');
  const [stationName, setStationName] = useState(s.stationName ?? '');
  const [tagText, setTagText] = useState(s.tags.join(', '));
  const [note, setNote] = useState('');
  // Off by default. §15: no automatic link when the context is ambiguous, and
  // from here it always is.
  const [link, setLink] = useState(false);
  const [editedName, setEditedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /* The proposed name follows the fields until the commander edits it. */
  const proposed = useMemo(
    () =>
      proposeFilename({
        subject: subject.trim() || null,
        systemName: systemName.trim() || null,
        bodyName: bodyName.trim() || null,
        capturedAt: draft.capturedAt,
        extension: '.png',
      }),
    [subject, systemName, bodyName, draft.capturedAt],
  );
  const filename = editedName ?? proposed;

  const tags = tagText
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  function save(keepOriginalName: boolean) {
    setSaving(true);
    onSave({
      filename,
      keepOriginalName,
      category,
      subject,
      systemName,
      bodyName,
      stationName,
      tags,
      note,
      activityEntryId: link ? (s.suggestedLink?.id ?? null) : null,
    });
  }

  /* Escape cancels, which is what a dialog over a game should do. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <>
        <header className="shot-head">
          <h2>Screenshot captured</h2>
          <span className="muted-inline">
            {draft.width} × {draft.height}
          </span>
        </header>

        {/*
          Exclusive fullscreen reads as a flat frame through a screen capture.
          Said plainly here rather than discovered later in the folder.
        */}
        {draft.looksBlank && (
          <p className="note">
            The captured image is a single flat colour. Elite is most likely running in
            exclusive Fullscreen, which cannot be captured without injecting code into the
            game. Switch Elite to Borderless and capture again.
          </p>
        )}

        <label className="field">
          <span>What is this?</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {SCREENSHOT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.hint}
              </option>
            ))}
          </select>
          {/* Why it was prefilled, so an override is an informed one. */}
          <span className="field-hint">{s.category.because}</span>
        </label>

        <label className="field">
          <span>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What the screenshot shows"
          />
          <span className="field-hint">
            {s.subject ? s.subject.because : 'Nothing here says what is in frame — your words.'}
          </span>
        </label>

        <div className="shot-grid">
          <label className="field">
            <span>System</span>
            <input value={systemName} onChange={(e) => setSystemName(e.target.value)} />
          </label>
          <label className="field">
            <span>Body</span>
            <input value={bodyName} onChange={(e) => setBodyName(e.target.value)} />
          </label>
          <label className="field">
            <span>Station</span>
            <input value={stationName} onChange={(e) => setStationName(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Tags</span>
          <input
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            placeholder="Comma separated"
          />
        </label>

        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </label>

        {s.suggestedLink && (
          <label className="check">
            <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
            <span>
              Attach to Journal entry <strong>{s.suggestedLink.title}</strong>
            </span>
          </label>
        )}

        <label className="field">
          <span>Filename</span>
          <input
            value={filename}
            onChange={(e) => setEditedName(e.target.value)}
            spellCheck={false}
          />
          <span className="field-hint">
            Saved in {folder ?? 'your screenshot folder'}
          </span>
        </label>

        {error && <p className="note">{error}</p>}

        <div className="shot-actions">
          <button type="button" className="primary" onClick={() => save(false)} disabled={saving}>
            Save
          </button>
          {/*
            Catalogue it where it landed, without renaming. The image is never
            lost just because the commander does not want to name it now.
          */}
          <button type="button" className="secondary" onClick={() => save(true)} disabled={saving}>
            Keep original name
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
    </>
  );
}

/* -------------------------------------------------------------- browser */

export function Screenshots({ snap }: { snap: CompanionSnapshot }) {
  const shots = snap.screenshots.recent;
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const missingCount = snap.screenshots.missing.size;

  /* Re-check on opening the screen: files come and go while the app runs. */
  useEffect(() => {
    void snap.refreshScreenshots();
    // Once per visit, not on every snapshot change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return shots.filter((r) => {
      if (category && r.category !== category) return false;
      if (!needle) return true;
      return [r.subject, r.systemName, r.bodyName, r.stationName, ...r.tags]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(needle));
    });
  }, [shots, category, text]);

  return (
    <>
      <header className="page-head">
        <h1>Screenshots</h1>
      </header>

      <section className="card">
        <p className="muted">
          Your screenshots stay in your own folder — nothing is copied into this app, and
          nothing is ever uploaded. This is a catalog of where they are and what they show.
        </p>
        <p className="muted">
          {snap.screenshots.hotkey
            ? `Capture with ${describeHotkey(snap.screenshots.hotkey)}.`
            : 'No capture hotkey is set yet. Settings → Screenshots.'}
        </p>
        {snap.screenshots.lastError && <p className="note">{snap.screenshots.lastError}</p>}
      </section>

      {/*
        Images deleted outside this app. Marked rather than quietly pruned: from
        here "the file is gone" and "the drive is unplugged" are the same answer,
        and removing the row would destroy the subject, tags and notes that were
        typed by hand. The image could be retaken; that writing could not.
      */}
      {missingCount > 0 && (
        <section className="card">
          <p className="note">
            {missingCount} {missingCount === 1 ? 'entry points' : 'entries point'} at an image
            that is not in the folder any more. That may mean it was deleted — or that a drive
            or network folder is not connected right now, in which case the file will come back.
          </p>
          <p className="audit-actions">
            <button type="button" className="secondary" onClick={() => void snap.refreshScreenshots()}>
              Check again
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void snap.screenshots.removeMissingFromCatalog()}
            >
              Forget {missingCount} missing {missingCount === 1 ? 'entry' : 'entries'}
            </button>
          </p>
        </section>
      )}

      <section className="card">
        <div className="shot-filters">
          <label className="field">
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All</option>
              {SCREENSHOT_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Subject, system, body, tag"
            />
          </label>
        </div>

        {shots.length === 0 ? (
          <p className="muted">Nothing catalogued yet.</p>
        ) : filtered.length === 0 ? (
          <p className="muted">No screenshots match that filter.</p>
        ) : (
          <ul className="shot-list">
            {filtered.map((r) => (
              <ShotRow
                key={r.id}
                row={r}
                snap={snap}
                missing={snap.screenshots.missing.has(r.id)}
                confirming={confirming === r.id}
                onConfirm={() => setConfirming(r.id)}
                onCancel={() => setConfirming(null)}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Open a screenshot, or say why it could not be opened.
 *
 * An earlier version swallowed the rejection, so a denied permission looked
 * exactly like a working button that did nothing — which is how the opener's
 * missing path scope went unnoticed. A failure the commander can see is a
 * failure somebody can fix.
 */
async function open(action: 'open' | 'reveal', path: string): Promise<void> {
  try {
    if (action === 'open') await openPath(path);
    else await revealItemInDir(path);
  } catch (err) {
    // The path is deliberately not included: it names a folder under the
    // commander's account and usually their Windows username.
    logger.warn('screenshot', `Could not ${action} the image`, { error: String(err) });
    window.alert(
      action === 'open'
        ? 'Windows would not open that image. It may have been moved, or there may be no app associated with .png files.'
        : 'Windows would not open that folder.',
    );
  }
}

function ShotRow({
  row,
  snap,
  missing,
  confirming,
  onConfirm,
  onCancel,
}: {
  row: ScreenshotRecord;
  snap: CompanionSnapshot;
  missing: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const when = Date.parse(row.capturedAt);

  return (
    <li className={`shot-row${missing ? ' shot-missing' : ''}`}>
      <div className="shot-row-main">
        <div className="shot-subject">
          {row.subject ?? '(no subject)'}
          {/* Stated in words, not by dimming alone. */}
          {missing && <span className="shot-gone"> — image not found</span>}
        </div>
        <div className="shot-meta">
          <span className="shot-cat">{categoryLabel(row.category)}</span>
          {[placeName(row.systemName, row.bodyName), row.stationName]
            .filter(Boolean)
            .join(' · ')}
          {Number.isFinite(when) && <span className="shot-when">{new Date(when).toLocaleString()}</span>}
        </div>
        {row.tags.length > 0 && (
          <ul className="tags">
            {row.tags.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="shot-row-actions">
        {/*
          `openPath`, not a `file://` URL. A Windows path is `C:\\Users\\...`,
          which does not survive being pasted after `file://` -- the backslashes
          are not separators and the drive letter is read as a host. The opener
          plugin takes an OS path and does the right thing per platform.
        */}
        {/* Both would fail silently with nothing there to open. */}
        {!missing && (
          <>
            <button
              type="button"
              className="link"
              onClick={() => void open('open', row.filePath)}
            >
              Open
            </button>
            <button
              type="button"
              className="link"
              onClick={() => void open('reveal', row.filePath)}
            >
              Show in folder
            </button>
          </>
        )}
        {!confirming ? (
          <>
            {/* Removing the entry and deleting the image are separate actions:
                one is reversible by re-cataloguing, the other is not. */}
            <button
              type="button"
              className="link"
              onClick={() => void snap.removeScreenshotFromCatalog(row.id)}
            >
              Remove from catalog
            </button>
            {!missing && (
              <button type="button" className="link danger" onClick={onConfirm}>
                Delete image
              </button>
            )}
          </>
        ) : (
          <span className="shot-confirm">
            Delete the file from disk?
            <button
              type="button"
              className="link danger"
              onClick={() => {
                onCancel();
                void snap.deleteScreenshotImage(row.id);
              }}
            >
              Delete
            </button>
            <button type="button" className="link" onClick={onCancel}>
              Keep
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------- settings */

export function ScreenshotSettings({ snap }: { snap: CompanionSnapshot }) {
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [folder, setFolder] = useState(snap.screenshots.folder ?? '');

  useEffect(() => setFolder(snap.screenshots.folder ?? ''), [snap.screenshots.folder]);

  useEffect(() => {
    if (!capturing) return;
    async function onKey(e: KeyboardEvent) {
      e.preventDefault();
      const { bindingFromEvent } = await import('./lib/screenshots.js');
      const binding = bindingFromEvent(e);
      if (binding === null) return; // modifiers only so far
      setCapturing(false);
      setPending(binding);
      const reason = await snap.setScreenshotHotkey(binding);
      setProblem(reason);
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, snap]);

  return (
    <section className="card">
      <h2>Screenshots</h2>
      <p className="muted">
        A capture hotkey is <strong>not set by default</strong>. Elite setups are crowded, and
        claiming a combination without being asked could break something you rely on in flight.
      </p>

      <div className="field">
        <span>Capture hotkey</span>
        <div className="shot-hotkey">
          <code>{capturing ? 'Press a combination…' : describeHotkey(snap.screenshots.hotkey)}</code>
          <button type="button" className="primary" onClick={() => { setProblem(null); setCapturing(true); }}>
            {snap.screenshots.hotkey ? 'Change' : 'Set'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!snap.screenshots.hotkey}
            onClick={() => {
              setPending(null);
              setProblem(null);
              void snap.setScreenshotHotkey(null);
            }}
          >
            Clear
          </button>
        </div>
        <span className="field-hint">
          Needs a modifier and one key, so it cannot fire while you are typing.
        </span>
        {problem && <p className="note">{problem}</p>}
        {!problem && pending && snap.screenshots.hotkey === pending && (
          <p className="field-hint">Bound.</p>
        )}
      </div>

      <div className="field">
        <span>Screenshot folder</span>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
        <div className="shot-hotkey">
          <button type="button" className="primary" onClick={() => void snap.setScreenshotFolder(folder)}>
            Use this folder
          </button>
          <button
            type="button"
            className="secondary"
            /* Revealed rather than launched: a folder has no image extension,
               and `open-path` is deliberately restricted to image files. */
            onClick={() => void open('reveal', snap.screenshots.folder ?? '')}
            disabled={!snap.screenshots.folder}
          >
            Open folder
          </button>
        </div>
        <span className="field-hint">
          Images are saved here, never inside this app's data. {snap.screenshots.folderWritable
            ? 'This folder is writable.'
            : 'This folder cannot be written to yet.'}
        </span>
      </div>
    </section>
  );
}
