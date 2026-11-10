import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * License notices of the bundled third-party code. The MIT and ISC licenses of the packages the
 * extension bundles require their copyright and permission notice in every copy, and their source
 * comments only point to a LICENSE file. The package therefore ships THIRD_PARTY_LICENSES.txt with
 * the LICENSE file of every package found in the final module graph (nothing to keep in sync by
 * hand). The build fails when a bundled package has no license file.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'corsen:third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Map<string, string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of output.moduleIds) {
          const path = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0] ?? ''
          const at = path.lastIndexOf('/node_modules/')
          if (at < 0) continue
          const parts = path.slice(at + '/node_modules/'.length).split('/')
          const name = parts[0]?.startsWith('@') === true ? `${parts[0]}/${parts[1] ?? ''}` : parts[0]
          if (name === undefined || name === '' || name.startsWith('.')) continue
          packages.set(`${path.slice(0, at)}/node_modules/${name}`, name)
        }
      }
      const sections: Array<{ key: string; text: string }> = []
      for (const [dir, name] of packages) {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: string }
        const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry))
        if (file === undefined) this.error(`${name} is bundled but has no LICENSE file to ship`)
        const title = `${manifest.name ?? name} ${manifest.version ?? ''} — ${manifest.license ?? 'see license text'}`
        sections.push({ key: `${manifest.name ?? name}@${manifest.version ?? ''}`, text: `${title}\n\n${readFileSync(join(dir, file), 'utf8').trim()}` })
      }
      sections.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const header = 'Universal AI Agent Connector bundles the following third-party packages. Each one is listed with its license notice.'
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: `${header}\n\n${sections.map((section) => section.text).join(`\n\n${'='.repeat(78)}\n\n`)}\n` })
    },
  }
}

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
  plugins: [stripZodJit(), react(), tailwindcss(), thirdPartyLicenses()],
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
