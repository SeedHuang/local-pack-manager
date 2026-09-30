import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  // 与 tsup 同源：版本唯一事实源 = package.json
  define: { __LPM_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: 'node',
    coverage: {
      include: ['src/**'],
      exclude: [
        // 纯类型文件不产生运行时语句，天然 0%，排除免拉低整体
        'src/**/*.d.ts',
        'src/state/types.ts',
        // CLI 入口：action 回调仅经命令行触发，单测天然覆盖不到（靠 e2e），排除免拉低单测门槛
        'src/cli.ts',
      ],
      // 门槛（实测基线 2026-09-30：语句 94.5 / 分支 88.3 / 函数 99.4 / 行 96.8，留 3-4 点余量）
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 95,
        lines: 92,
      },
    },
  },
})
