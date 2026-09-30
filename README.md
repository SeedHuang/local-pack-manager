# lpm —— 本地联调工具

## 这是干嘛的？

平时开发，你的项目（比如 BFM）用的是从网上（registry）下载的库版本。当你同时要改这个库本身（比如 ai_suit_tool）时，最笨的办法是：改一行 → 发布到网上 → 项目升级 → 重新下载安装，每次来回几分钟。

**lpm 就是解决这个的**：一条命令把"用网上的版本"临时切成"用你本地改的这个库"，改完一条命令切回去，网上的版本和你的改动互不干扰。

打个比方：你吃饭平时点外卖（网上的库）。今天你想自己下厨（本地库），lpm 帮你把外卖订单退掉、换上厨房做的；做完这顿饭，一条命令换回继续点外卖。

---

## 装之前要知道的

- 你的电脑要装 **Node.js 22.12 或更高**（一个跑 JavaScript 的运行时，装 lpm 必需）。
- 项目本身推荐用 **pnpm**（lpm 自己就是用 pnpm 管理的）。

---

## 怎么装

### 第一步：把代码拿到手

```bash
git clone <仓库地址> local-pack-manager
cd local-pack-manager
pnpm install
```

> 如果你已经在这个文件夹里，跳过 clone，直接 `pnpm install`。

### 第二步：一键装到全局

```bash
pnpm localG
```

这条命令做完两件事：

1. 先把 lpm 的代码"打包"成可以运行的样子（叫 build，打包好放在 `dist` 文件夹里）；
2. 再把 lpm 安装到你电脑的"全局"位置——装完以后，**在任何一个文件夹里都能直接敲 `lpm` 开头来用**，不用每次都跑到这个项目文件夹里。

> 为什么必须先打包？因为 `lpm` 这个命令真正跑的是打包后的文件（`dist/cli.js`），不打包的话命令会找不到东西、直接报错。所以 `localG` 里已经把打包这一步放进去了，你不用手动管。

### 第三步：确认装好了

```bash
lpm --version
```

能打印出版本号（比如 `0.1.0`）就成功了。

### 不想要了怎么卸

```bash
pnpm localG:rm
```

把你电脑上的全局 lpm 删掉。

### 改了代码想更新全局

改完源码后，**重新跑一次 `pnpm localG`** 就行。注意：lpm 是"拷贝"到全局的，不是"指向"你本地代码的，所以改完代码必须重跑才会生效。

---

## 怎么用（讲人话）

### 一个完整例子：联调 ai_suit_tool

假设你在 BFM 项目里，想一边改 `ai_suit_tool` 这个库、一边在 BFM 里实时看效果：

```bash
cd bilibili_favorite_manager        # 进到你的项目文件夹

# ① 把"用网上的 ai_suit_tool"切成"用本地的 D:\Seed\ai_suit_tool"
lpm link D:\Seed\ai_suit_tool

# ② 去库那边让它边改边自动重新构建
#    （lpm 只管"接线"，不管"供电"——库要自己开构建监听）
cd D:\Seed\ai_suit_tool
pnpm build:watch

# ③ 联调完，切回网上的版本（lpm 会把你原来的版本号原样恢复）
cd bilibili_favorite_manager
lpm unlink ai_suit_tool
```

### 一次操作多个库

```bash
lpm link --all            # 把"通讯录"里记着的所有本地库全部接上（见下面的"通讯录"）
lpm link --last           # 一键恢复你最近一次"一整批都接上"的那批
lpm save my-set           # 把当前接上的这批存起来，起个名叫 my-set
lpm link --preset my-set  # 以后想再来这批，直接按名字接上
lpm preset rm my-set      # 不要这批记录了，删掉
```

---

## 每个命令干什么

### `lpm use` —— 告诉 lpm 你用哪个包管理器

```bash
lpm use            # 看 lpm 自己猜你用的是哪个（pnpm？npm？yarn？）
lpm use pnpm       # 明确告诉它：用 pnpm
```

lpm 猜的依据：优先看你项目里有哪些锁文件（`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`），其次看 `package.json` 里的 `packageManager` 字段。

### `lpm link` —— 接上本地库

```bash
lpm link <名字或路径>
lpm link --all              # 接上全部
lpm link --last             # 恢复最近一批
lpm link --preset <名字>     # 按预设接上
lpm link --watch            # 接上后顺便帮库那边开构建监听（会占着终端，Ctrl+C 一起关掉）
lpm link --dry-run          # 只告诉你"准备做什么"，什么都不真的改
```

**它做了什么**：把你项目里写依赖的地方（`package.json`），从"某个版本号"改成"指向本地文件夹的写法"。改完还帮你自动装一次依赖，让改动生效。

### `lpm unlink` —— 断开，回到网上的版本

```bash
lpm unlink <名字或路径>
lpm unlink --all            # 全部断开
lpm unlink --dry-run        # 只预览
```

**它做了什么**：把你刚才改掉的依赖声明，按记录原样改回去（你原来写 `^1.0.0` 就还原成 `^1.0.0`），再自动装一次依赖。

> 有个安全保证：它一定是"先还原文件 → 装依赖成功 → 才删记录"。中途出岔子的话，你的原始版本号不会丢。

### `lpm status` —— 体检，看看现在什么状态

```bash
lpm status
lpm status --json    # 输出机器能读的格式（写脚本用）
```

只读，不改任何东西。它帮你核对三处：**你的代码里写的**、**lpm 记的档案**、**实际安装的**。不一致就告诉你是哪一类问题：

- 漂移：你的 `package.json` 被人（或工具）改了，和 lpm 记的对不上
- 装了没生效：声明改了但实际没装上
- 孤儿：声明里写了本地指向，但 lpm 没有记录
- 残留链接：实际装着本地链接，但声明里已经没有
- 失效记录 / 记录损坏：lpm 自己的档案有问题

### `lpm repair` —— 自动修

```bash
lpm repair --dry-run   # 先看它打算修什么
lpm repair             # 确认后执行
```

针对 `status` 发现的问题自动修复。它会先给你看计划、要你确认才动手（不让它随便改你的文件）。

### `lpm save` / `lpm preset` —— 记住一批，随时重来

```bash
lpm save <预设名>             # 把当前接上的这批库记下来
lpm preset                   # 打开列表，可以删预设
lpm preset rm <预设名>        # 删掉某个预设
```

### `lpm forget` —— 删掉"通讯录"里的记录

```bash
lpm forget <名字或路径>        # 直通删除
lpm forget                   # 交互界面删除
```

**注意**：它只删"记录了这个库在哪"的档案，**不会**同时帮你断开正在联调的库。如果这个库还接在项目上，得先 `lpm unlink` 再 forget。

### `lpm dir` —— 管理"去哪找本地库"

告诉 lpm 除了当前项目附近，还可以到哪些文件夹里找库。

```bash
lpm dir ls
lpm dir add D:\Seed\libs
lpm dir rm D:\Seed\libs
```

### `lpm init` / `lpm uninit` —— 给网页项目"打补丁"（umi 专用）

这是给用 **umi** 搭的网页项目用的，解决两个 link 后特有的怪毛病：

- **样式突然变了**：库里的组件不再跟随你项目的整体主题（比如深色变回默认亮色），因为库里用了自己那份 antd，不是你项目那份。
- **模块找不到**：`link:` 指向了项目文件夹外面的库，umi 默认不让读。

`lpm init` 会在你的 umi 配置文件里自动加上一小段设置，强制库去用你项目的组件、并允许读取外面的库。`lpm uninit` 是把这段设置摘掉。

```bash
lpm init --dry-run    # 先看要改哪里
lpm init              # 确认后写入
lpm uninit            # 摘掉
```

**一般不用手动跑** —— 这两条命令已经和 link/unlink 联动上了：

- **`lpm link` 成功后**：自动检测项目里有没有 umi 项目（`config/config.ts` / `.umirc.ts` 等），有且还没注入过 → 自动帮你 `init`（非交互）。
- **`lpm unlink` 全部断开后**：自动检测已注入的 umi 配置 → 自动帮你 `uninit` 还原。

非 umi 项目、或没有已注册 lib 时自动跳过，不打扰你。手动 `init` / `uninit` 仍然可用（带 diff 预览确认），需要精细控制时再用。

---

## 几个概念，用大白话讲

| 术语 | 大白话 |
|---|---|
| 引用方（host） | 你的项目（比如 BFM），就是"要使用这个库"的那一方 |
| lib | 你正在改的本地库（比如 ai_suit_tool） |
| 通讯录 | 一个文件 `lpm.config.json`，记录"每个本地库在哪个文件夹"。**会提交进 git**，所以同事/换电脑也能用 |
| 接线单 | 一个文件 `.lpm/state.json`，记录"当前哪些库被接上了、你原来写的是啥版本"。这是撤销的凭证，**不会提交 git** |
| 集合记忆 | 一个文件 `.lpm/last.json`，记录"最近一次整批接上的有哪些"。**不会提交 git** |
| 漂移 | 你的 `package.json` 被人改动过，跟 lpm 记的对不上 |
| 管辖范围 | lpm 只碰你的项目文件夹（workspace）里声明过的那些库，文件夹外的它一律不碰 |

---

## 项目里会多出哪些文件

| 文件 | 会提交 git 吗 | 干什么 |
|---|---|---|
| `lpm.config.json` | ✅ 会 | 通讯录（哪个库在哪）+ 预设 + 你选的包管理器 |
| `.lpm/state.json` | ❌ 不会 | 当前接上了谁、原版本是啥（撤销凭证） |
| `.lpm/last.json` | ❌ 不会 | 最近一批接上的是谁 |
| `.lpm/last-run.json` | ❌ 不会 | 每次操作的记录（出问题时排查用） |
| `~/.lpm/config.json` | — | 你个人电脑上的扫描目录设置 |

---

## 出问题了怎么排查

- **link 之后网页样式不对 / 双份组件打架**（umi 项目）：先跑 `lpm init` 打补丁。
- **怀疑文件被别人改过**：跑 `lpm status` 看漂移，再 `lpm repair --dry-run` 看看它打算怎么修。
- **装依赖失败**：别慌，lpm 的记录还在。直接重跑 `lpm link` 或 `lpm unlink`，它会跳过已经完成的部分。实在想完全重来：`git checkout -- <受影响的>/package.json`，删掉 `.lpm` 文件夹，重新装一次依赖——lpm 的记录都是可以删掉重建的。

---

## 补充：不同包管理器的写法

lpm 会把"本地指向"写成每种包管理器认识的写法，你不用管细节：

- pnpm / yarn 老版本：`link:`
- yarn 新版（berry）：`portal:`
- npm 7 以上：`file:`

lpm 写的是相对路径，不会写死绝对路径，所以项目整体搬家也不会坏。
