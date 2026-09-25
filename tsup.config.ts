import { defineConfig } from 'tsup'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const pkg = nodeRequire('./package.json') as { version: string }

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  // Windows 全局安装由 npm/pnpm 生成 cmd shim（内部调 node），shebang 按惯例保留
  banner: { js: '#!/usr/bin/env node' },
  define: { __LPM_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  clean: true,
  // commander/@clack/prompts/execa 属 dependencies，tsup 自动 external，不打进产物
})
