import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // webview-ui 源码以 '@shared/protocol' 引用扩展侧共享协议——node 测试（test/webview-store.test.ts）同解析
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
