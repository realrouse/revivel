import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Polyfill for Node 18 compatibility (some deps like undici expect newer globals)
if (typeof (globalThis as any).File === 'undefined') {
  (globalThis as any).File = class FilePolyfill {
    constructor(chunks: any[], name: string, options?: any) {}
  } as any
}
if (typeof (globalThis as any).Blob === 'undefined') {
  (globalThis as any).Blob = class BlobPolyfill {} as any
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load manifest synchronously (works reliably across Node versions)
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'src/manifest.json'), 'utf-8')
)

export default defineConfig({
  plugins: [
    crx({ manifest }),
  ],
  // For MV3 + crx
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // crx plugin handles popup, options etc from manifest
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
})
