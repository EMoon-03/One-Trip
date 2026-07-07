import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Any request to /api/* is forwarded to FastAPI, so the frontend can use
    // relative URLs and the browser never sees a cross-origin request in dev.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  preview: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
