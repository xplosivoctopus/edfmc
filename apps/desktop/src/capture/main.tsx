/**
 * The capture window.
 *
 * A separate always-on-top window rather than a panel in the main window,
 * because the whole point is to answer "what is this?" **without leaving the
 * game**. In Borderless it draws over Elite, which stays rendered behind it.
 *
 * It is deliberately **not** the overlay. The overlay is click-through and must
 * stay that way; making it interactive for a form and then restoring it is the
 * kind of state that gets left switched on after an error path. A second window
 * cannot leave the first in a bad state.
 *
 * It owns no data. The draft arrives by event from the main window, and the
 * answer goes back the same way — the main window keeps the database, the
 * catalog and the staging file, exactly as the overlay keeps none of them.
 */

import ReactDOM from 'react-dom/client';

import CaptureWindow from './CaptureWindow';

import '../App.css';

const container = document.getElementById('capture-root');
if (container) {
  // No StrictMode: this window registers native event listeners on mount, and
  // the dev double-mount makes listener churn harder to reason about.
  ReactDOM.createRoot(container).render(<CaptureWindow />);
}
