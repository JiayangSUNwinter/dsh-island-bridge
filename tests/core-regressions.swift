var checked = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
    checked += 1
}
func row(_ requestID: String? = nil, id: String = "s1", text: String = "审批") -> IslandSession {
    IslandSession(id: id, title: "任务 \(id)", running: true, pending: requestID.map {
        IslandPending(requestId: $0, kind: "permission", toolName: "bash", reason: text, displayReason: "", questions: [])
    })
}
func size(_ m: IslandModel) -> CGSize {
    islandSize(model: m, notchWidth: 185, contentTop: 38, maxHeight: 600)
}
let model = IslandModel(eventSink: { _ in })
var callbacks = 0
model.onModeChange = { callbacks += 1 }
model.sessions = [row()]
model.toggleMode()
check(model.mode == .expanded, "点击绿点展开")
check(size(model).width == 392, "紧凑宽度392pt")
model.dismiss()
check(model.mode == .compact && callbacks == 2, "岛外点击触发布局并收起")
model.autoExpandIfNeeded()
check(model.mode == .compact, "普通状态刷新不会重新展开")
model.sessions = [row("a1"), row(nil, id: "running")]
model.completedFlash = [row(nil, id: "completed")]
model.autoExpandIfNeeded()
check(model.mode == .expanded, "新审批自动展开")
check(model.visibleTasks.isEmpty, "有审批时隐藏所有运行任务行")
check(model.visibleCompletions.isEmpty, "有审批时隐藏完成提示")
check(model.runningCount == 0, "有审批时隐藏运行任务计数")
check(model.activeApproval?.id == "a1", "审批选择初始化")
model.dismiss()
for _ in 0..<5 { model.autoExpandIfNeeded() }
check(model.mode == .compact, "同一审批刷新不会推翻手动收起")
model.sessions.append(row("a2", id: "s2"))
model.autoExpandIfNeeded()
check(model.mode == .expanded, "下一条审批再次展开")
check(model.activeApproval?.id == "a1", "新审批不打断当前阅读")
model.selectApproval(offset: 1)
check(model.activeApproval?.id == "a2", "可以切换到下一条审批")
model.selectApproval(offset: 100)
check(model.activeApproval?.id == "a2", "审批队列上边界")
model.selectApproval(offset: -100)
check(model.activeApproval?.id == "a1", "审批队列下边界")
model.sessions = [row(nil, id: "running")]
model.autoExpandIfNeeded()
check(model.mode == .compact, "审批完成自动收起")
check(model.visibleTasks.count == 1 && model.runningCount == 1, "全部审批处理后恢复运行信息")
check(model.visibleCompletions.count == 1, "审批结束后允许显示完成信息")
model.toggleMode()
model.autoExpandIfNeeded()
check(model.mode == .expanded, "手动展开保持展开")
model.completedFlash = []
model.sessions = []
model.autoExpandIfNeeded()
check(model.mode == .compact, "任务结束时清理展开态")
let frame = CGRect(x: 100, y: 200, width: 392, height: 178)
check(islandContains(CGPoint(x: 110, y: 350), frame: frame), "顶部可点击")
check(!islandContains(CGPoint(x: 99, y: 350), frame: frame), "左侧透明画布视为外部")
check(!islandContains(CGPoint(x: 300, y: 199), frame: frame), "下方透明画布视为外部")
check(!islandContains(CGPoint(x: 100, y: 200), frame: frame), "圆角外侧穿透")
check(islandContains(CGPoint(x: 116, y: 201), frame: frame), "圆角内部可点击")
model.sessions = [row("a3")]
model.autoExpandIfNeeded()
check(size(model).height <= 178, "短审批不突破现有高度")
let long = String(repeating: "需要读取项目配置并校验差异。\n", count: 500) + "全文末尾验证标记"
model.sessions = [row("long", text: long)]
model.autoExpandIfNeeded()
check(size(model).height == 178, "极长审批保持178pt上限")
check(approvalText(model.activeApproval!.pending) == long, "长审批全文没有截断且末尾保留")
check(size(model).width == 392, "长审批不额外变宽")
model.sessions = (0..<100).map { row(nil, id: "task-\($0)") }
model.autoExpandIfNeeded()
model.toggleMode()
if model.mode == .compact { model.toggleMode() }
check(size(model).height == 178, "100项任务不突破现有高度")
check(model.visibleTasks.count == 100, "全部任务保留供内部滚动")
check(model.runningCount == 100, "任务计数准确")
model.sessions = [row()]
check(size(model).height == 96, "单任务收紧到96pt")
model.sessions.append(row(nil, id: "second"))
check(size(model).height == 124, "第二个任务只增加28pt")
let constrained = islandSize(model: model, notchWidth: 185, contentTop: 38, maxHeight: 120)
check(constrained.height == 120, "屏幕可用空间更小时仍不越界")
var pending = row("text").pending!
pending.displayReason = "显示正文"
pending.reason = "完整原始原因"
check(approvalText(pending) == "显示正文\n\n完整原始原因", "两种宿主审批文案均完整展示")
pending.reason = "显示正文"
check(approvalText(pending) == "显示正文", "完全相同的正文去重")
pending.reason = ""; pending.displayReason = ""
check(!approvalText(pending).isEmpty, "缺少说明时明确提示")
pending.kind = "ask_user_question"
pending.questions = [["question":"请选择方案", "options":[["label":"方案一", "description":"完整选项说明"]]]]
check(approvalText(pending).contains("完整选项说明"), "提问及选项说明完整展示")
check(stripEscalationPrefix("escalate sandbox to danger-full-access: 读取文件") == "读取文件", "仅移除协议前缀")
model.sessions = [row("submit")]
model.autoExpandIfNeeded()
var sent: [(String,String)] = []
model.submit("submit", outcome: "allowed-once", send: { sent.append(($0,$1)) })
model.submit("submit", outcome: "allowed-once", send: { sent.append(($0,$1)) })
check(sent.count == 1 && model.submitting.contains("submit"), "提交中禁止重复裁决")
model.submit("missing", outcome: "rejected", send: { sent.append(($0,$1)) })
check(sent.count == 1, "失效请求不发送裁决")
model.sessions = [row()]
model.autoExpandIfNeeded()
check(model.submitting.isEmpty && model.feedback.isEmpty, "审批消失后清理提交状态")
model.completedFlash = [row(nil, id: "finished")]
model.mode = .compact
check(model.completionToast?.id == "finished", "挂起时完成提示只有一个当前条目")
check(size(model).height == 62, "完成提示仅占安全区加24pt文字条")
check(size(model).width <= 392, "完成文字条不突破原有宽度")
model.completedFlash.append(row(nil, id: "latest"))
check(model.completionToast?.id == "latest", "连续完成合并为最新一句，不叠加界面")
model.sessions = [row("urgent")]
model.autoExpandIfNeeded()
check(model.completionToast == nil, "审批优先，隐藏完成提示")
model.sessions = [row()]
model.autoExpandIfNeeded()
model.mode = .expanded
check(model.completionToast == nil, "展开时不叠加单行完成条")
model.completedFlash = []
model.sessions = []
model.autoExpandIfNeeded()
check(!model.hasContent, "完成提示过期后空闲岛可以隐藏")
model.sessions = [IslandSession(id: "long-title", title: String(repeating: "完整任务标题", count: 20), running: true, pending: nil)]
model.mode = .expanded
check(size(model).width == 560, "长任务标题横向放宽到560pt")
check(size(model).height == 96, "横向扩展不增加单任务高度")
check(islandSize(model: model, notchWidth: 185, contentTop: 38, maxHeight: 178, availableWidth: 480).width == 480, "窄屏限制横向宽度")
model.sessions = [row()]
check(size(model).width == 392, "短标题仍使用紧凑宽度")
model.sessions = [row("approval-width")]
check(size(model).width == 392, "审批保持既有宽度")
print("PASS: \(checked) native interaction regressions")
