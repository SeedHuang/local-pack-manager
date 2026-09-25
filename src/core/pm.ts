export type PackageManagerId = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry'

// 推断优先级（lockfile > packageManager 字段 > workspace 清单）与 berry/classic 判定见 PRD §7，S3 实现
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId> {
  throw new Error('not implemented: detectPackageManager（计划 S3）')
}
