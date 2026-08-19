import { build } from 'esbuild'

const watch = process.argv.includes('--watch')
const common = { bundle: true, format: 'cjs', platform: 'node', target: 'node22.13',
  external: ['vscode'], sourcemap: true, logLevel: 'info' }

await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  build({ ...common, entryPoints: ['src/runtime/worker.ts'], outfile: 'dist/worker.js' }),
])
if (watch) console.log('[esbuild] watching...')
