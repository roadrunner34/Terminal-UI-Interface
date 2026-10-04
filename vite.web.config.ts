// Serves the renderer in a plain browser with the scripted demo agent
// (src/renderer/src/lib/demo.ts). Handy for UI work without Electron.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [svelte()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  server: { port: 5199, strictPort: true }
})
