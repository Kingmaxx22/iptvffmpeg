import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// The Rust media server (axum) binds 127.0.0.1:8787 in standalone dev mode.
// Inside the Tauri shell the backend picks a free port and the frontend reads it
// through the `media_base` command instead of relying on this proxy.
const MEDIA_SERVER = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri expects a fixed dev port and does not tolerate vite auto-shifting it.
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': { target: MEDIA_SERVER, changeOrigin: true },
      '/ws': { target: MEDIA_SERVER.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})