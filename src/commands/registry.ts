export interface CommandMeta {
  name: string
  summary: string        // help 一句话中文描述
  plannedSpec: string    // stub 提示用
}

export const COMMANDS: CommandMeta[] = [
  { name: 'use',     summary: '设定或自动推断包管理器',     plannedSpec: 'S3' },
  { name: 'link',    summary: '把依赖切到本地目录联调',     plannedSpec: 'S6' },
  { name: 'unlink',  summary: '恢复 registry 版本',        plannedSpec: 'S7' },
  { name: 'status',  summary: '三方核对链接状态',           plannedSpec: 'S8' },
  { name: 'repair',  summary: '修复漂移与孤儿状态',         plannedSpec: 'S8' },
  { name: 'save',    summary: '当前链接集存为预设',         plannedSpec: 'S10' },
  { name: 'preset',  summary: '预设管理',                  plannedSpec: 'S10' },
  { name: 'forget',  summary: '移除 lib 注册',              plannedSpec: 'S11' },
  { name: 'dir',     summary: '用户级扫描目录管理',         plannedSpec: 'S11' },
  { name: 'init',    summary: '注入 web 自感知配置片段',     plannedSpec: 'S13' },
  { name: 'uninit',  summary: '摘除 web 自感知配置片段',     plannedSpec: 'S13' },
]
