/**
 * @vitest-environment jsdom
 *
 * Startup smoke test: does the application actually mount?
 *
 * Every other test here exercises a function in isolation, which is why a crash
 * that only happens when React renders the real tree shipped to users. The
 * `carrierJumps` getter rebuilt its array on every call and was fed to
 * `useSyncExternalStore`, which compares snapshots by identity — so React saw a
 * state change on every render and aborted with "Maximum update depth exceeded"
 * (#185). The app failed to start, on an empty list, and every unit test passed.
 *
 * So this mounts `<App />` for real. The Tauri boundary is mocked to the minimum
 * that lets the component tree render; no journal folder, database or native
 * runtime is required, and the corpus tests are untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* ---------------------------------------------------------------- mocks */

// Native command surface. Rejecting is realistic — there is no journal folder
// here — and the app is supposed to survive that by showing an error, not by
// failing to render.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('no tauri runtime in tests');
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(async () => {
      throw new Error('no database in tests');
    }),
  },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));

// Must never be called: nothing in a cold start should reach the network.
const httpFetch = vi.fn(async () => new Response('{}', { status: 200 }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

/* ---------------------------------------------------------------- setup */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  // React logs act() and error-boundary noise that is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mountApp(): Promise<void> {
  const { default: App } = await import('../src/App');
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  // Let start()'s rejected promises and any follow-up state settle.
  await act(async () => {
    await Promise.resolve();
  });
}

/* ---------------------------------------------------------------- tests */

describe('application startup', () => {
  it('mounts without throwing', async () => {
    // A render loop surfaces here as "Maximum update depth exceeded", which is
    // exactly the failure that shipped.
    await expect(mountApp()).resolves.toBeUndefined();
  });

  it('renders actual UI rather than an empty root', async () => {
    // An empty #root is the failure mode that looks like a hang rather than an
    // error, which is why main.tsx has an error boundary at all.
    await mountApp();
    expect(container.children.length).toBeGreaterThan(0);
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('stays mounted after the store notifies', async () => {
    // An unstable snapshot does not always fail on first paint; it fails when
    // something re-reads it. This forces that path.
    await mountApp();
    const { companion } = await import('../src/lib/companion');

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        (companion as unknown as { notify(): void }).notify();
      });
    }

    expect(container.children.length).toBeGreaterThan(0);
  });

  it('exposes a referentially stable snapshot across reads', async () => {
    // The precise contract useSyncExternalStore requires. Asserted directly so a
    // violation is named rather than showing up as an opaque render loop.
    const { companion } = await import('../src/lib/companion');
    expect(companion.snapshot()).toBe(companion.snapshot());
    expect(companion.snapshot().carrierJumps).toBe(companion.snapshot().carrierJumps);
  });

  it('renders the Journal screen without a database', async () => {
    // The Activity Journal reads from SQLite, which is unavailable here. An empty
    // timeline must render as an empty timeline rather than throwing -- a screen
    // that only works once there is data is a screen nobody sees on day one.
    await mountApp();
    const { companion } = await import('../src/lib/companion');
    expect(companion.snapshot().activity).toEqual([]);

    const journal = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Journal',
    );
    expect(journal, 'the Journal section should be reachable').toBeDefined();

    await act(async () => {
      journal!.click();
    });
    expect(container.textContent).toContain('Journal');
    expect(container.textContent).toContain('never uploaded');
  });

  it('asks for a guidance level on first run', async () => {
    // Shown because nothing has ever been chosen -- which is distinct from
    // having chosen Standard.
    await mountApp();
    const { companion } = await import('../src/lib/companion');
    expect(companion.snapshot().guidanceChosen).toBe(false);
    expect(container.textContent).toContain('Welcome to EDFM Companion');
    expect(container.textContent).toContain('New CMDR Mode');
  });

  it('does not ask again once a level has been chosen', async () => {
    await mountApp();
    const { companion } = await import('../src/lib/companion');

    await act(async () => {
      await companion.setGuidanceMode('new-cmdr');
    });

    expect(companion.snapshot().guidanceChosen).toBe(true);
    expect(companion.snapshot().guidance).toBe('new-cmdr');
    expect(container.textContent).not.toContain('Welcome to EDFM Companion');
  });

  it('keeps every feature reachable in either guidance mode', async () => {
    // Guidance changes explanation, never availability. A mode that hid things
    // would make "am I seeing everything?" unanswerable.
    await mountApp();
    const { companion } = await import('../src/lib/companion');
    const sections = () =>
      [...container.querySelectorAll('nav button')].map((b) => b.textContent?.trim());

    const standard = sections();
    await act(async () => {
      await companion.setGuidanceMode('new-cmdr');
    });
    expect(sections()).toEqual(standard);
  });

  /*
   * The native layer rejects every command in this file, which is exactly what
   * a broken IPC boundary looks like on a real machine. That rejection used to
   * escape `start()` through the journal-directory probe: the run reported an
   * unhandled rejection, and the app was left on `connection: 'starting'` --
   * a window showing "Starting" forever, with no error anywhere to act on.
   */
  it('settles into a reportable state when the native layer is unavailable', async () => {
    await mountApp();
    const { companion } = await import('../src/lib/companion');
    const snap = companion.snapshot();

    expect(snap.connection, 'startup must not stall on "starting"').not.toBe('starting');
    // Whatever went wrong, the screen has to be able to say something about it.
    expect(`${snap.directoryDetail}${snap.lastError ?? ''}`.trim().length).toBeGreaterThan(0);
  });

  it('does not tell the commander a path is missing when it could not be checked', async () => {
    // "Set it in Settings" is the wrong instruction when the check never ran,
    // and the `no-directory` badge ("No journal folder") asserts something this
    // run did not establish.
    await mountApp();
    const { companion } = await import('../src/lib/companion');
    const snap = companion.snapshot();
    expect(snap.directoryDetail).not.toContain('Could not locate');
    expect(snap.connection).toBe('error');
    expect(container.textContent).not.toContain('No journal folder');
  });

  it('makes no network request during a cold start', async () => {
    // Verification is opt-in. A fresh install that has never consented must not
    // contact the API to find that out.
    await mountApp();
    expect(httpFetch).not.toHaveBeenCalled();
  });
});
