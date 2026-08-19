import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const pkgDir = path.dirname(fileURLToPath(import.meta.url))
const req = createRequire(path.join(pkgDir, 'package.json'))
// npm workspaces 会把 react/react-dom 提升到根 node_modules——按实际解析位置固定，防 dual-React
const reactDir = path.dirname(req.resolve('react'))
const reactDomDir = path.dirname(req.resolve('react-dom'))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(pkgDir, '../src/shared'),
      react: reactDir,
      'react-dom': reactDomDir,
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome122',
    cssCodeSplit: false,
    rollupOptions: { output: { entryFileNames: 'index.js', assetFileNames: 'index.css' } },
  },
})
