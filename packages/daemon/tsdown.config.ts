import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  fixedExtension: false,
  sourcemap: false,
  // Runtime npm dependencies stay external; the internal workspace package is bundled.
  deps: { alwaysBundle: ['@corsen-ai/shared'] },
  // The local dashboard is plain static files served by the daemon.
  copy: [{ from: 'src/web-dashboard/static/*', to: 'dist/web', flatten: true }],
})
