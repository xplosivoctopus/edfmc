import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const host = process.env['TAURI_DEV_HOST'];

export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      // The overlay is a genuinely separate window with its own document, not a
      // route in the main app: it must be transparent, click-through and sized to
      // the game window, none of which can be toggled per-route.
      input: {
        main: resolve(__dirname, 'index.html'),
        overlay: resolve(__dirname, 'overlay.html'),
        // Likewise its own document: it must sit over the game, take focus, and
        // be sized to a form rather than to the main window.
        capture: resolve(__dirname, 'capture.html'),
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}));
