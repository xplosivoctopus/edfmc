/**
 * The form, in its own window over the game.
 *
 * Holds no data of its own. The draft arrives by event, the answer leaves by
 * event, and the main window does the saving — the same split the overlay uses,
 * because a second window with database access would be a second place for the
 * catalog to go wrong.
 */

import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

import { ScreenshotForm } from '../Screenshots';
import type { ScreenshotDraft, ScreenshotSaveRequest } from '../lib/companion.js';

import '../App.css';

/** What the main window sends when a capture needs answering. */
interface CapturePayload {
  readonly draft: ScreenshotDraft;
  readonly folder: string | null;
  readonly error: string | null;
}

export default function CaptureWindow() {
  const [payload, setPayload] = useState<CapturePayload | null>(null);

  useEffect(() => {
    const draft = listen<CapturePayload>('capture-draft', (e) => setPayload(e.payload));
    // The main window reports a failure that happened after the form closed --
    // a rename that could not complete, say -- by reopening with the reason.
    const problem = listen<string>('capture-error', (e) =>
      setPayload((p) => (p ? { ...p, error: e.payload } : p)),
    );
    // Sent once the save actually succeeded, which is when the window may close.
    const done = listen<void>('capture-done', () => {
      setPayload(null);
      void getCurrentWindow().hide();
    });

    return () => {
      void draft.then((un) => un());
      void problem.then((un) => un());
      void done.then((un) => un());
    };
  }, []);

  function send(request: ScreenshotSaveRequest) {
    void emit('capture-save', request);
  }

  function cancel() {
    // Closing immediately is honest here: the main window discards the draft on
    // the same event, and the staged image is left on disk either way.
    setPayload(null);
    void emit('capture-cancel');
    void getCurrentWindow().hide();
  }

  if (!payload) return null;

  return (
    <div className="capture-window">
      <ScreenshotForm
        key={payload.draft.stagingPath}
        draft={payload.draft}
        folder={payload.folder}
        error={payload.error}
        onSave={send}
        onCancel={cancel}
      />
    </div>
  );
}
