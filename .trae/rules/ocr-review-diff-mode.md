---
description: OCR 评审轮一律用 diff 模式调用，并落盘命令行
alwaysApply: true
---

# OCR 评审一律用 diff 模式调用

> 来源：L-2026-09-27-001｜证据：S7 复盘 §5-2、§2-7、§2-12（S6 基线④未落地，仍 workspace 全文件模式，单轮 4m50s，token 未取得）｜落地：2026-09-28

SDD 的 OCR 评审轮**禁止**用 workspace 全文件模式；一律以 diff 模式调用：

```
ocr review --audience agent --background "<业务上下文>" --from <BASE> --to <HEAD>
```

- `<BASE>` / `<HEAD>` 取本阶段的评审基线（S6 基线：workspace 模式单次约 3,388,389 tokens / 4m58s）。
- 每次调用后把**完整命令行**（含 `--from/--to` 取值）落盘到 `.superpowers/sdd/<slug>.md/ocr-cmd.txt`，供复盘核对；并把 `[ocr] Summary:` 原始行（含 token 与耗时）落盘到同目录，供 token 降幅对照。

**反例**：`ocr review --audience agent -b "context"`（无 `--from/--to`）→ 退化为 workspace 模式，对整份文件内容发起评审，token 成本高一个量级，耗时与 S6 基线持平（4m50s vs 4m58s）——即本规则要拦的形态。
