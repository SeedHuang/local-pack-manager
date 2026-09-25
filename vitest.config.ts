import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  // 与 tsup 同源：版本唯一事实源 = package.json
  define: { __LPM_VERSION__: JSON.stringify(pkg.version) },
  test: { environment: 'node' },
})
