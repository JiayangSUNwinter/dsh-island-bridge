# 贡献指南

## 开发环境

- macOS 14+、Xcode Command Line Tools（`swiftc`）、Node.js ≥ 22。
- 克隆后无需 `npm install`：本项目**没有运行时依赖**，测试直接用 Node 内置 test runner。

```bash
npm run check     # 语法检查
npm test          # 16 项 Node 测试 + 50 条原生断言（会现场编译 helper）
```

## 提 PR 之前

1. `npm test` 全绿。
2. 改了 `helper/island-helper.swift`：确认改动落到 `tests/core-regressions.swift` 覆盖的行为范围内，否则补断言。
3. 改了对外行为（尺寸、审批规则、交互）：同步更新 `docs/DESIGN.md` 与 `README.md` 的对应段落。
4. 提交信息用 `type(scope): 摘要` 形式，例如 `fix(helper): 点岛外收起失效`。

## 提交内容边界

- 不要提交 `build/`、helper 二进制、`*.log`、`*.sha256` 等产物（见 `.gitignore`）。
- 不要写入个人绝对路径；运行期数据一律走 `$DSH_HOME`。
- 新增网络请求、遥测、外部依赖前请先开 issue 讨论——本项目的核心卖点是「数据不出本机」。

## 报告问题

请附上：macOS 版本与芯片、DSH 版本、`DSH_ISLAND_DEBUG=1` 下的相关日志片段、复现步骤。日志在 `$DSH_HOME/dsh-island-bridge/bridge-debug.log`。
