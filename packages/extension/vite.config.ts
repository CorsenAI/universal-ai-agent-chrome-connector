import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * Zod's JIT is disabled at runtime (`z.config({ jitless: true })`, src/zod-setup.ts), but its
 * eval-capable code (`new Function`) would still ship. Extension pages forbid eval and Chrome Web
 * Store review flags it, so the two dead code paths are removed at build time. The build fails loudly
 * if Zod changes this code, instead of silently shipping it.
 */
function stripZodJit(): Plugin {
  return {
    name: 'corsen:strip-zod-jit',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/')
      if (/\/zod\/v4\/core\/util\.js$/.test(normalized)) {
        const out = code.replace(/const F = Function;\s*new F\(""\);\s*return true;/, 'return false;')
        if (out === code) this.error('zod util.js changed: update the strip-zod-jit plugin')
        return { code: out, map: null }
      }
      if (/\/zod\/v4\/core\/doc\.js$/.test(normalized)) {
        const out = code.replace(
          /compile\(\) \{\s*const F = Function;[\s\S]*?return factory\(\.\.\.Object\.values\(this\.closed\)\);\s*\}/,
          'compile() {\n        throw new Error("Zod JIT compilation is disabled in this build");\n    }',
        )
        if (out === code) this.error('zod doc.js changed: update the strip-zod-jit plugin')
        return { code: out, map: null }
      }
      return null
    },
  }
}

// MV3 build: two HTML pages (side panel, popup) and the module service worker, all bundled into
// dist/ with static files from public/ (manifest, icons, _locales). No remote code, no CDN.
export default defineConfig(({ mode }) => ({
  plugins: [stripZodJit(), react(), tailwindcss()],
  base: '',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome125',
    sourcemap: mode === 'development',
    // Readable output: faster Chrome Web Store review, debuggable in-page functions (no obfuscation, ever).
    minify: false,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rolldownOptions: {
      input: {
        sidepanel: here('sidepanel.html'),
        popup: here('popup.html'),
        background: here('src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}))
