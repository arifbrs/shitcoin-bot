import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Multi-page build (3 entries: landing / login / app) — mirrors the 3 static pages the
// old Node server already routes by exact URL (/, /login, /app). Keeping one bundle per
// page (instead of a client-router SPA) means server.ts's existing per-route auth gate
// (isAuthed()) needs zero logic changes — it just serves a different built HTML file.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        landing: path.resolve(__dirname, 'index.html'),
        login: path.resolve(__dirname, 'login.html'),
        app: path.resolve(__dirname, 'app.html'),
      },
    },
  },
  // During `vite dev`, proxy every backend route straight through to the real Node server
  // (src/server.ts, port 4317) so the SAME fetch('/api/stats') / EventSource('/api/stream')
  // calls the built app will make in production also work against live data in dev mode,
  // with no separate mock layer to keep in sync.
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/login': 'http://127.0.0.1:4317',
      '/logout': 'http://127.0.0.1:4317',
      '/vendor': 'http://127.0.0.1:4317',
    },
  },
})
