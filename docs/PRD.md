# DSH 原生灵动岛（dsh-native-island）产品需求文档

| 项 | 值 |
|---|---|
| 文档版本 | v1.0（草案，待评审） |
| 日期 | 2026-10-29 |
| 目标平台 | macOS（Apple Silicon 优先） |
| 关联运行时 | DeepSeek Harness 桌面端 0.2.1-rc.2 |

---

## 1. 背景与问题

用户以 DSH 桌面端为主力工作台，并行多个 Agent 会话。三个痛点：

1. **审批不可见**：工具审批以瀑布事件出现在会话 UI 内；切到别的窗口/屏幕时审批积压、Agent 空转等待，用户无感知。
2. **任务找不回**：并行多个会话时，切走再回来要靠人肉回忆找对话——哪个在跑、跑到哪了、在哪个会话里。
3. **现有方案不满足**：
   - dsh-notify-me 系统通知：任何屏幕可见，但 macOS 通知中心不支持第三方 App 的交互按钮，**无法直接裁决**；
   - dsh-notify-me 浮层 / 自制网页浮层：渲染在 DSH 窗口内部，窗口被遮挡即不可见；
   - DSH 官方手机 App：仅 Android，iOS 缺位；
   - Cindy + dsh-cindy-host：审批可推手机，但内容经第三方云中继，且其灵动岛对 DSH 状态的呈现未经验证。

**结论：两条主线同级——审批不能漏（漏了 Agent 就停摆）、任务不能丢（丢了就要人肉找回）。需要一颗系统级的、原生的、数据不出本机的灵动岛同时覆盖两者。**

## 2. 目标与非目标

### 目标

- 一颗贴在 MacBook 刘海区的**全局悬浮面板**：实时列出正在运行的任务（会话），任何 App 在前台都可见；
- **审批不漏、岛上即决**：审批 / 方案确认 / 提问待交互时，岛自动展开审批卡（会话 + 操作摘要），直接「同意 / 拒绝」裁决，无需切窗；
- **点击即达**：点岛上任意一行 → 唤醒 DSH 窗口并跳转到那个任务的对话；
- **任务完成 / 出错即时提示**（自动收回）；
- 会话运行状态一览（并行会话数、当前活动摘要）；
- 数据**全程不出本机**（回环通信，无第三方云）。

### 非目标（本版不做）

- 手机端 / 远程推送（已有 dsh-notify-me + Bark 覆盖）；
- Windows / Linux；
- 岛上编辑会话内容、发送 prompt（v1 = 只读状态 + 审批裁决 + 点击跳转的导航行为，不含内容输入）；
- 监控 DSH 之外的 Agent CLI（该品类由 Vibe Island / AgentBro 覆盖）。

## 3. 竞品与参考实现调研

| 产品 | 形态 | 接入方式 | 对 DSH 适用性 |
|---|---|---|---|
| Vibe Island（商业） | macOS 刘海面板 | 监控 CLI 型 Agent 的 Hook | ✗ 面向 CLI 进程，DSH 桌面会话不在采集范围 |
| AgentBro（开源，Tauri） | 悬浮工作台 + 灵动岛 | Hook 接入 Claude Code / Codex 等 | ✗ 同上 |
| Cindy 灵动岛（开源，已拆解源码） | NSPanel 贴刘海，SwiftUI | Cindy 自家引擎（内嵌 claude-code / codex CLI） | ✓ 架构可整体借鉴，数据源需换成 DSH |
| dsh-notify-me（开源，已装） | 系统通知 + 页面浮层 | DSH 插件（sessionStatus 订阅） | ✓ 数据层参考，展示层不满足 |

**差异化定位**：Vibe Island 品类靠 Hook 监控 CLI 进程；DSH 是桌面 App，其审批与状态存在**官方进程内接缝**（审批瀑布 answerer、sessionStatus store、webServer 路由注册）——本项目的数据源是第一方的、结构化的、无猜测的。这是所有竞品都不具备的优势。

## 4. 用户与场景

单用户（DSH 桌面端使用者本人）。典型时刻：

- 并行 3 个会话跑任务，人在浏览器 / 微信 / 飞书处理别的事 → 岛上实时列出三个任务的会话名与状态；
- 点其中一行 → DSH 窗口唤醒并直接跳进那个对话；回到工作现场零检索；
- 某会话的工具调用需要批准 → 该行自动展开审批卡（操作摘要 + 同意 / 拒绝），一键裁决，Agent 立刻继续；
- 后台会话回复完成 → 「✅ 回复完成」6 秒后自动收回；
- 全部空闲 → 岛收起或隐藏，零干扰。

## 5. 功能需求

### P0（M1 必须交付）

- **F1 刘海面板**：NSPanel 贴 MacBook 刘海区，全局悬浮、全屏 App 之上可见、永不夺取键盘焦点（canBecomeKey / canBecomeMain = false）；多显示器时跟随含刘海的主屏。
- **F2 运行中会话列表**：岛实时列出每个 running 会话一行（会话标题 + 运行状态点）；标题来自宿主的会话标题查询（cindy-host 实证的 readTitleSnapshots 接缝）；列表变化（新会话 / 会话结束）实时反映。
- **F3 点击跳转**：点任意一行 → 唤醒 DSH 窗口并切换到那个会话的对话；M1 交付底线 = 「唤醒窗口」必达 + 「会话级切换」尽力（宿主 API 实测，缺位降级并记 OQ-3）。
- **F4 审批卡**：会话出现 approval / plan-review / question 待交互时，对应行展开为审批卡（操作摘要 + 同意 / 拒绝按钮）；裁决用与页面内审批卡相同的动词（answer 的 allowed-once / rejected）；裁决后行回到普通态。
- **F5 完成提示**：后台会话完成（completionUnread 边沿）→ 该行短暂变为「✅ 回复完成」后从运行列表移除。
- **F6 自动隐藏**：无运行会话且无待交互时，岛整体收起为小胶囊或隐藏（不拦截鼠标）。

### P1（M2）

- **F7 深浅色跟随系统**；浅色菜单栏配色适配；
- **F8 多显示器策略**：外接无刘海屏时可选落点；
- **F9 提示音**：审批 / 完成 / 出错三档，可关；
- **F10 审批超时二次提醒**（含可选 Bark 推送）；
- **F11 工具活动摘要**：行内显示当前工具名流式摘要（思考中 / 写文件 / 跑命令）。

### P2（远期）

- 岛上显示工具活动摘要（流式当前工具名）；吉祥物皮肤系统；设置 GUI；历史用量角标。

## 6. 非功能需求

- 常驻内存 ≤ 60MB；空闲 CPU ≈ 0%（事件驱动，禁止轮询渲染）；
- 面板出现 / 收起动画 ≤ 350ms；事件到岛更新的端到端延迟 ≤ 500ms；
- helper 崩溃自愈：由桥接端按指数退避重启（≤3 次，健康 30s 重置计数）；
- 隐私：所有数据仅在回环接口与本机进程间流动，无任何第三方端点、无遥测。

## 7. 技术方案

### 7.1 总体架构

```
DSH 桌面端（Electron）
└─ dsh-island-bridge（cordis 宿主插件，Node 子进程）
    ├─ 审批瀑布 answerer：pendingInteraction 出现 → 投影状态；接收裁决 → ctx.approval 应答
    ├─ sessionStatus 订阅：running / completionUnread 投影
    ├─ 回环 HTTP 路由（webServer.register）：GET /state（SSE 或轮询）、PUT /decision
    └─ spawn 并管理 Swift helper 子进程（stdin / stdout JSON 行协议）
        ↓
Swift 原生面板（dsh-island-helper，单文件 SwiftUI / AppKit）
    ├─ AgentIslandPanel: NSPanel（canBecomeKey / Main = false，贴刘海，多屏）
    ├─ 状态渲染：收起胶囊 / 审批卡 / 完成胶囊 / 运行细条
    └─ 裁决按钮 → stdout JSON → 桥接插件 → ctx.approval 应答
```

### 7.2 关键调研结论（均已在本机源码级验证）

- **审批接入**：DSH 审批是瀑布事件（@deepseek-ai/dsh-user-approval），链上 answerer fail-closed；社区插件 dsh-cindy-host 已验证「以 answerer 身份加入瀑布、无人接时 next() 落回本地 UI」的模式可行（其 maker:resolve-interaction 即同一动词族）。
- **状态接入**：DSH ≥ 0.1.6 的 sessionStatus store（Map<会话, {running, pendingInteraction, completionUnread}>）可经 ctx.get("uiSession") 读取并 subscribe（dsh-notify-me 生产实现验证）。
- **本地路由**：宿主插件可用 ctx.inject(["webServer"]) 注册精确路由；回环围栏采用 notify-me 的 gateRequest 模式（回环对端 + 回环 Host + Origin 同源校验，防 DNS 重绑定）。
- **原生面板**：Cindy 的 AgentIslandPanel（NSPanel，canBecomeKey / Main = false）+ NSScreen.safeAreaInsets 刘海几何 + 逐屏 displayId 方案，源码级验证可行（240KB 单文件 Swift 已存档于 /tmp/cindy-review/）。
- **宿主进程形态**：DSH 宿主插件运行于 Electron 的子 Node 进程（非主进程），无法直接创建 BrowserWindow——原生 Swift helper 是系统级面板的必要路径（notify-me 在 Windows 用 PowerShell 抬窗亦同因）。

### 7.3 通信协议草案（桥接 ↔ 面板，stdio JSON 行）

| 方向 | 帧 | 内容 |
|---|---|---|
| 宿主 → 面板 | update | 全量显示状态：sessions[]（id / 标题（readTitleSnapshots）/ running / pending{kind, summary}）、completion 事件、displayPolicy |
| 面板 → 宿主 | decision | { sessionId, interactionKey, outcome: allowed-once 或 rejected } |
| 面板 → 宿主 | ready / log | 握手与诊断 |
| 宿主 → 面板 | shutdown | 优雅退出 |

裁决确认语义：桥接收到 decision 后调用审批 answerer；若该交互已被其他 answerer 处理（失效），返回 {stale: true}，面板提示后收回卡片。

### 7.4 构建与分发

- Swift helper 以**单文件源码**随插件分发，桥接端按源码哈希**懒编译**（swiftc -O，超时 120s——参考 Cindy 教训：短超时会杀死首建、使岛永久消失）；编译产物按哈希缓存；
- **前置条件**：Xcode Command Line Tools（swiftc）；缺失时桥接降级为仅状态记录，并在 DSH 设置卡片提示安装指引；
- 插件更新时 helper 源码与编译缓存按哈希自动重建。

## 8. 安全与隐私

- 面板与桥接仅经 stdio 通信，无网络端口；桥接如需 SSE 则仅绑回环并套回环围栏（回环对端 + 回环 Host + Origin 同源，防 DNS 重绑定——notify-me gateRequest 模式）；
- **裁决权 = 本机权**：能触到岛的人即能批准 Agent 操作。本方案无云端、无账号、无远程面，攻击面收敛为「本机本地进程」，与 DSH 桌面端自身威胁模型一致；
- 审批内容（路径、命令摘要）仅显示在本机屏幕，不落盘、不外发；
- 与 auto-review（Auto 预设的 LLM 审阅器）的关系：本桥接 answerer 追加在瀑布链上，不改变 auto-review 的先审语义；两链先后顺序见 OQ-2。

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 最小可见 | 桥接插件（审批 answerer + 会话状态与标题投影 + 回环路由 + 聚焦/跳转通道）+ Swift 面板（刘海面板 / 运行中会话列表 / 审批卡 / 点击跳转） | 运行中的会话实时出现在岛上；点一行 → DSH 唤醒并跳到该对话（会话切换按 OQ-3 实测，缺位则降级为仅唤醒）；审批卡岛上可裁决 |
| M2 状态完整 | F5 完成提示、F4 审批卡队列、F6 自动隐藏、F7 深浅色 | 并行 3 会话场景下列表准确、无串扰 |
| M3 体验打磨 | F8 多屏策略、F9 提示音、F10 超时二次提醒、F11 工具活动摘要、设置卡片、崩溃自愈指标 | 一周日常使用零手动干预 |

## 10. 风险与开放问题

| 编号 | 风险 / 问题 | 应对 |
|---|---|---|
| R1 | swiftc 依赖 Xcode CLT，未装则 M1 不可用 | 桥接降级为仅状态记录；设置卡片给出安装指引 |
| R2 | 审批瀑布上桥接 answerer 与 auto-review 的先后顺序未定 | OQ-2：实现时按 next() 链语义实测，确保两者不互吞 |
| R3 | DSH 0.2.x 迭代快，sessionStatus / 审批 API 可能变化 | 面板与桥接以适配层隔离（notify-me 的多代 shape 适配模式） |
| R4 | 刘海区被系统菜单占用 / 外接无刘海屏 | 几何模块已含 notched 判定，提供落点回退（主屏顶部居中） |
| OQ-1 | 岛上裁决是否需要二次确认（防误触） | M1 先不做（审批卡 18s 自收兜底），按使用反馈定 |
| OQ-2 | 审批链上桥接与 auto-review 的相对顺序 | 实现时以真实审批事件实测排序语义 |
| OQ-3 | 会话级切换的宿主 API（窗口唤醒已定：osascript activate；会话切换候选=session-controller 路由 / 深链） | M1 内实测；API 缺位则 M1 降级为仅唤醒窗口，M2 补会话切换 |

## 11. 验收标准（M1）

1. 会话开始运行后 **≤2 秒**，岛上出现对应行（标题 + 状态点）；结束时该行移除（或短暂显示完成态）；
2. 点岛上某行 → DSH 窗口唤醒至前台；会话级切换按 OQ-3 结论交付（M1 允许降级为仅唤醒，须明示）；
3. 审批出现时该行展开审批卡；岛上「同意」→ 审批链收到 allowed-once、Agent 继续执行；「拒绝」→ 收到 rejected；
4. 全程键盘焦点不离开用户当前 App；
5. 点击审批卡 → DSH 窗口被唤醒至前台（会话级切换按 OQ-3 结论交付）；
6. 活动监视器：helper 空闲 CPU < 1%，内存 ≤ 60MB；
7. 关闭 DSH → 岛 30 秒内显示离线态并安全退出。

## 12. 附录：本次调研的实证材料

- Cindy 灵动岛源码：apps/desktop/native/agent-island/macos-agent-island-helper.swift（240KB，SwiftUI 单文件）+ MacAgentIslandNativeHost.ts（33KB，spawn / JSON 协议 / 懒编译 / 崩溃自愈）+ 13 个测试文件——全文已存 /tmp/cindy-review/（临时目录，重启丢失）；
- dsh-notify-me 源码：~/.dsh/profiles/desktop/node_modules/dsh-notify-me/lib/client.js（195KB，sessionStatus 适配层 / 回环围栏 / 快捷裁决）；
- dsh-cindy-host 源码：审批瀑布 answerer 实证（maker:get-pending-interactions / maker:resolve-interaction），文档 148KB 含真机复测清单；
- 审批瀑布接缝：@deepseek-ai/dsh-user-approval 的 answerer 链与 fail-closed 语义（auto-review 的 UNSUPPORTED_REASONING_EFFORT fail-closed 案例同时验证了拒绝路径）。


## 13. 实现记录：精确打开对话（2026-10-29）

OQ-3 已在本机 DSH 0.2.1-rc.2 安装源码中确认可用接口：桌面 uiWorkspace.openSession(sessionId)。不依赖未实现的会话深链。

- 运行任务整行、审批来源标题、“在 DSH 回答”均发送该项自己的 sessionId，唤醒 DSH 并切换至对应对话，随后收起岛。
- 审批操作按钮保持独立；点击来源标题只导航，不同意或拒绝请求。
- 宿主与桌面客户端经 DSH 现有、鉴权 OWNER 的 Fetch carrier 传递导航命令及确认；无新增监听端口。桌面模块仅在 dsh-app: 环境消费命令。
- 连续点击保留最新目标；命令15秒过期，客户端选择成功后确认，重试同一命令不重复切换。
- 保留审批独占、178pt高度上限、动态收紧、单窗口完成窄提示以及岛外点击收起规则。

本文前述 M1 仅唤醒窗口的降级描述为历史方案。当前版本支持精确会话导航。已验证范围及限制见NAVIGATION-VERIFICATION.md。
