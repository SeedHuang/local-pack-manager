import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { sonarjs },
    rules: {
      ...sonarjs.configs.recommended.rules,

      // 下划线前缀参数 = 冻结签名占位（如 runDir 的 _cwd、buildForceInstallCommand 的 _pm），
      // 位置一致性 > 未用参数告警，按约定豁免
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // 循环体末尾的 continue（统一 if/continue 形态）与自然结束等价，属风格选择，豁免
      'sonarjs/no-redundant-jump': 'off',

      // /\/+$/ 尾部锚定无回溯风险，静态分析误报，豁免
      'sonarjs/super-linear-regex': 'off',

      // 单行 if { ...; continue } 内嵌语句的花括号闭合正确，静态分析误报，豁免
      'sonarjs/no-unenclosed-multiline-block': 'off',

      // 命令编排函数（link/repair/unlink/status 核心）复杂度高是 CLI 多分支编排的本质，
      // 拆分属 E 类立项；阈值 30 拦住「明显失控」的新函数，存量 >30 的逐个标注
      'sonarjs/cognitive-complexity': ['error', 30],
    },
  },
)
