# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-10-30

### 修复

- `npm test` 的原生面板测试改为不可见模式，不再把“配置检查 已完成”等测试内容弹到桌面，也不再与正式岛重叠或监听鼠标。
- 在 DSH 回答提问后立即清理岛上的镜像卡片，避免因答案是对象而无法通过权限裁决字符串校验，造成旧问题残留和再次出现。
- 提问答案、超时和取消直接沿用 DSH 原有结果；不再与岛上的空答案竞速，也不会在下游出错后重复调用回答链。
- 本地审批返回 `cancelled` / `unavailable` 或出错时也清理提示；已取消的请求不再留在注册表，权限裁决不会误处理提问。

### 验证

- 增加提问完成、刷新不复活、后续新提问、超时、取消及审批终态的回归测试；原生测试检查面板不可见且鼠标监听数量为零。

## [0.1.2] - 2026-10-30

首个公开版本（仓库发布版）。相对内部部署版 0.1.1：

### 修复

- 移除写死在源码里的调试日志绝对路径；诊断日志改为 `DSH_ISLAND_DEBUG=1` 显式开启，并落在 `$DSH_HOME/dsh-island-bridge/bridge-debug.log`。
- helper 编译改为「临时文件 + 原子重命名」，避免覆盖正在运行的旧二进制或在只读挂载下失败。
- 原生面板构建失败（缺少 `swiftc` 等）不再让整个插件 apply 抛错：记录原因后跳过面板，审批仍在 DSH 本地 UI 正常工作。

### 变更

- 仓库根目录即插件包（`lib/`、`helper/`、`cordis.patch.yml` 在根），补齐 README、MIT 许可证、`.gitignore`、CI 与贡献指南。
- 新增 `npm test` / `npm run check` / `npm run build:helper` 脚本。

## [0.1.1] - 2026-10-29

内部部署版本，未公开发布。

- 审批独占、全文滚动、队列稳定、处理后恢复任务。
- 完成态窄提示复用同一 NSPanel，3 秒自动收回。
- 桌面端精确导航（`/api/island-navigation/wait` 与 `/ack`），单实例 helper 监督。
- 修复展开后点岛外无法收起、手动收起被状态刷新弹开等问题。

[0.1.3]: https://github.com/JiayangSUNwinter/dsh-island-bridge/compare/v0.1.2...codex/fix-stale-questions-and-test-windows
[0.1.2]: https://github.com/JiayangSUNwinter/dsh-island-bridge/releases/tag/v0.1.2
[0.1.1]: https://github.com/JiayangSUNwinter/dsh-island-bridge/commits/main
