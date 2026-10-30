// DSH native island v8: invisible protocol tests, compact production panel.
import AppKit
import SwiftUI

let isTestProtocol = CommandLine.arguments.contains("--test-protocol")

struct IslandPending {
    var requestId: String
    var kind: String
    var toolName: String
    var reason: String
    var displayReason: String
    var questions: [[String: Any]]
}
struct IslandSession {
    var id: String
    var title: String
    var running: Bool
    var pending: IslandPending?
}
struct IslandApproval: Identifiable {
    var session: IslandSession
    var pending: IslandPending
    var id: String { pending.requestId }
}
enum IslandMode: String { case compact, expanded }
enum IslandLayout {
    static let width: CGFloat = 392
    static let maxHeight: CGFloat = 178
    static let rowHeight: CGFloat = 28
    static let headerHeight: CGFloat = 22
    static let footerHeight: CGFloat = 34
    static let padding: CGFloat = 14
}

func islandScreen() -> NSScreen? {
    NSScreen.screens.first(where: { $0.auxiliaryTopLeftArea != nil }) ?? NSScreen.main
}
func islandContentTopInset() -> CGFloat {
    let screen = islandScreen()
    let menuHeight = screen.map { $0.frame.maxY - $0.visibleFrame.maxY } ?? 33
    return max(menuHeight, 33) + 5
}
func islandNotchWidth() -> CGFloat {
    guard let screen = islandScreen(), let left = screen.auxiliaryTopLeftArea,
          let right = screen.auxiliaryTopRightArea else { return 185 }
    return screen.frame.width - left.width - right.width
}
func stripEscalationPrefix(_ text: String) -> String {
    text.replacingOccurrences(of: "^escalate sandbox to [^:]*:\\s*", with: "", options: .regularExpression)
}
func approvalText(_ pending: IslandPending) -> String {
    if pending.kind == "ask_user_question" {
        return pending.questions.map { question in
            var parts: [String] = []
            if let title = question["header"] as? String, !title.isEmpty { parts.append(title) }
            if let body = question["question"] as? String, !body.isEmpty { parts.append(body) }
            for option in question["options"] as? [[String: Any]] ?? [] {
                let title = option["label"] as? String ?? option["title"] as? String ?? ""
                let detail = option["description"] as? String ?? ""
                parts.append([title, detail].filter { !$0.isEmpty }.joined(separator: "："))
            }
            if parts.isEmpty, let data = try? JSONSerialization.data(withJSONObject: question, options: [.prettyPrinted, .sortedKeys]),
               let text = String(data: data, encoding: .utf8) { parts.append(text) }
            return parts.joined(separator: "\n")
        }.joined(separator: "\n\n")
    }
    let display = pending.displayReason.trimmingCharacters(in: .whitespacesAndNewlines)
    let reason = pending.reason.trimmingCharacters(in: .whitespacesAndNewlines)
    if display.isEmpty { return reason.isEmpty ? "此审批未提供操作说明，请在 DSH 查看原始请求。" : reason }
    if reason.isEmpty || display == reason { return display }
    return display + "\n\n" + reason
}

final class IslandModel: ObservableObject {
    @Published var mode: IslandMode = .compact
    @Published var sessions: [IslandSession] = []
    @Published var completedFlash: [IslandSession] = []
    @Published var selectedRequestID: String?
    @Published var submitting: Set<String> = []
    @Published var feedback: [String: String] = [:]
    var manualExpanded = false
    private var knownPendingIDs: Set<String> = []
    var onModeChange: (() -> Void)?
    var eventSink: ([String: Any]) -> Void
    init(eventSink: @escaping ([String: Any]) -> Void) { self.eventSink = eventSink }

    var approvals: [IslandApproval] {
        sessions.compactMap { row in row.pending.map { IslandApproval(session: row, pending: $0) } }
    }
    var hasPending: Bool { !approvals.isEmpty }
    var visibleTasks: [IslandSession] { hasPending ? [] : sessions }
    var visibleCompletions: [IslandSession] { hasPending ? [] : completedFlash }
    var activeApproval: IslandApproval? {
        approvals.first(where: { $0.id == selectedRequestID }) ?? approvals.first
    }
    var approvalIndex: Int { approvals.firstIndex(where: { $0.id == activeApproval?.id }) ?? 0 }
    var completionToast: IslandSession? {
        hasPending || mode == .expanded ? nil : completedFlash.last
    }
    var runningCount: Int { hasPending ? 0 : sessions.filter { $0.running }.count }
    var hasContent: Bool { !sessions.isEmpty || !completedFlash.isEmpty }

    func toggleMode() {
        manualExpanded = true
        mode = mode == .expanded ? .compact : .expanded
        onModeChange?()
    }
    func dismiss() {
        guard mode == .expanded else { return }
        manualExpanded = true
        mode = .compact
        onModeChange?()
    }
    func selectApproval(offset: Int) {
        let items = approvals
        guard !items.isEmpty else { return }
        selectedRequestID = items[min(max(approvalIndex + offset, 0), items.count - 1)].id
        onModeChange?()
    }
    func autoExpandIfNeeded() {
        let ids = Set(approvals.map { $0.id })
        let hasNew = !ids.subtracting(knownPendingIDs).isEmpty
        knownPendingIDs = ids
        if let selected = selectedRequestID, !ids.contains(selected) { selectedRequestID = nil }
        if selectedRequestID == nil { selectedRequestID = approvals.first?.id }
        submitting.formIntersection(ids)
        feedback = feedback.filter { ids.contains($0.key) }
        if hasNew {
            manualExpanded = false
            if mode != .expanded { mode = .expanded; onModeChange?() }
        } else if !hasContent || (ids.isEmpty && !manualExpanded) {
            if mode != .compact { mode = .compact; onModeChange?() }
        }
    }
    func submit(_ id: String, outcome: String, send: (String, String) -> Void) {
        guard approvals.contains(where: { $0.id == id && $0.pending.kind == "permission" }),
              !submitting.contains(id), ["allowed-once", "rejected"].contains(outcome) else { return }
        submitting.insert(id)
        feedback[id] = "提交中…"
        send(id, outcome)
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self = self, self.submitting.contains(id) else { return }
            self.submitting.remove(id)
            self.feedback[id] = "尚未确认，请重试"
        }
    }
}

func approvalBodyHeight(_ text: String) -> CGFloat {
    // Text wraps within the full content width; the viewport, never the text, is capped.
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 3
    let bounds = (text as NSString).boundingRect(
        with: CGSize(width: IslandLayout.width - IslandLayout.padding * 2 - 8, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        attributes: [.font: NSFont.systemFont(ofSize: 12), .paragraphStyle: paragraph]
    )
    return max(24, ceil(bounds.height) + 8)
}
func islandSize(model: IslandModel, notchWidth: CGFloat, contentTop: CGFloat, maxHeight: CGFloat) -> CGSize {
    if let toast = model.completionToast {
        let label = (toast.title.isEmpty ? "任务" : toast.title) + " 已完成"
        let textWidth = (label as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12)]).width
        return CGSize(width: min(IslandLayout.width, max(notchWidth + 40, ceil(textWidth) + 28)),
                      height: min(IslandLayout.maxHeight, maxHeight, contentTop + 24))
    }
    if model.mode == .compact {
        return CGSize(width: notchWidth + (model.hasContent ? 60 : 0), height: 32)
    }
    let height: CGFloat
    if let approval = model.activeApproval {
        height = contentTop + IslandLayout.headerHeight + approvalBodyHeight(approvalText(approval.pending)) + IslandLayout.footerHeight
    } else {
        let count = model.visibleTasks.count + model.visibleCompletions.count
        height = contentTop + IslandLayout.headerHeight + CGFloat(max(1, count)) * IslandLayout.rowHeight + 8
    }
    return CGSize(width: IslandLayout.width, height: min(IslandLayout.maxHeight, maxHeight, height))
}
func islandContains(_ point: CGPoint, frame: CGRect, radius: CGFloat = 16) -> Bool {
    guard frame.contains(point) else { return false }
    let r = min(radius, frame.height / 2, frame.width / 2)
    if point.y < frame.minY + r {
        if point.x < frame.minX + r {
            return hypot(point.x - frame.minX - r, point.y - frame.minY - r) <= r
        }
        if point.x > frame.maxX - r {
            return hypot(point.x - frame.maxX + r, point.y - frame.minY - r) <= r
        }
    }
    return true
}

struct NotchShape: Shape {
    var topExtension: CGFloat
    var bottomRadius: CGFloat
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let top = rect.minY - topExtension
        let r = min(bottomRadius, rect.height / 2)
        p.move(to: CGPoint(x: rect.minX, y: top))
        p.addLine(to: CGPoint(x: rect.maxX, y: top))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.closeSubpath()
        return p
    }
}
let islandOrange = Color(red: 0.85, green: 0.47, blue: 0.34)
let islandGreen = Color(red: 0.30, green: 0.80, blue: 0.45)

struct IslandIconButton: View {
    let symbol: String
    let label: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                .foregroundColor(.white.opacity(disabled ? 0.2 : 0.6))
                .frame(width: 20, height: 22).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(disabled).help(label).accessibilityLabel(label)
    }
}
final class IslandViewInteraction: ObservableObject {
    @Published var hovered = false
    @Published var copied = false
}
struct SessionRowView: View {
    let row: IslandSession
    let completed: Bool
    let onOpen: (String) -> Void
    @ObservedObject private var interaction = IslandViewInteraction()
    var body: some View {
        Button { onOpen(row.id) } label: {
            HStack(spacing: 8) {
                if completed {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 9)).foregroundColor(islandGreen)
                } else {
                    Circle().fill(row.running ? islandGreen : Color.gray).frame(width: 6, height: 6)
                }
                Text(row.title.isEmpty ? "未命名任务" : row.title)
                    .font(.system(size: 13)).foregroundColor(.white.opacity(0.92)).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .medium)).foregroundColor(.white.opacity(0.35))
            }
            .padding(.horizontal, IslandLayout.padding).frame(height: IslandLayout.rowHeight)
            .background(interaction.hovered ? Color.white.opacity(0.06) : Color.clear).contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { interaction.hovered = $0 }.help(row.title)
    }
}
struct ApprovalContentView: View {
    @ObservedObject var model: IslandModel
    let item: IslandApproval
    let height: CGFloat
    let onOpen: (String) -> Void
    let onDecision: (String, String) -> Void
    @ObservedObject private var interaction = IslandViewInteraction()
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Circle().fill(islandOrange).frame(width: 6, height: 6)
                Button { onOpen(item.session.id) } label: {
                    Text(item.session.title.isEmpty ? "待审批" : item.session.title)
                        .font(.system(size: 13, weight: .medium)).foregroundColor(.white.opacity(0.92))
                        .lineLimit(1)
                }.buttonStyle(.plain).help(item.session.title + "：点击打开对应对话")
                    .accessibilityLabel("打开对话：" + (item.session.title.isEmpty ? "待审批任务" : item.session.title))
                Spacer(minLength: 0)
                if model.approvals.count > 1 {
                    IslandIconButton(symbol: "chevron.left", label: "上一条审批", disabled: model.approvalIndex == 0) { model.selectApproval(offset: -1) }
                    Text("\(model.approvalIndex + 1)/\(model.approvals.count)")
                        .font(.system(size: 10.5, design: .monospaced)).foregroundColor(.white.opacity(0.6))
                    IslandIconButton(symbol: "chevron.right", label: "下一条审批", disabled: model.approvalIndex == model.approvals.count - 1) { model.selectApproval(offset: 1) }
                }
                IslandIconButton(symbol: "chevron.up", label: "收起审批") { model.dismiss() }
            }.padding(.horizontal, IslandLayout.padding).frame(height: IslandLayout.headerHeight)
            ScrollView(.vertical) {
                Text(approvalText(item.pending))
                    .font(.system(size: 12)).foregroundColor(.white.opacity(0.8)).lineSpacing(3)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(.horizontal, IslandLayout.padding).padding(.vertical, 4)
            }
            .id(item.id)
            .frame(height: max(0, height - IslandLayout.headerHeight - IslandLayout.footerHeight))
            HStack(spacing: 8) {
                IslandIconButton(symbol: interaction.copied ? "checkmark" : "doc.on.doc", label: "复制审批全文") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(approvalText(item.pending), forType: .string)
                    interaction.copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { interaction.copied = false }
                }
                if let feedback = model.feedback[item.id] {
                    Text(feedback).font(.system(size: 10)).foregroundColor(.white.opacity(0.6)).lineLimit(1)
                }
                Spacer(minLength: 0)
                if item.pending.kind == "ask_user_question" {
                    Button("在 DSH 回答") { onOpen(item.session.id) }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white).padding(.horizontal, 12).frame(height: 26)
                        .background(Capsule().fill(islandOrange))
                } else {
                    Button("拒绝") { model.submit(item.id, outcome: "rejected", send: onDecision) }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundColor(.white.opacity(0.85))
                        .padding(.horizontal, 12).frame(height: 26).background(Capsule().fill(Color.white.opacity(0.12)))
                        .disabled(model.submitting.contains(item.id))
                    Button("同意一次") { model.submit(item.id, outcome: "allowed-once", send: onDecision) }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 12).frame(height: 26).background(Capsule().fill(islandOrange))
                        .disabled(model.submitting.contains(item.id))
                }
            }
            .padding(.horizontal, IslandLayout.padding).frame(height: IslandLayout.footerHeight)
            .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).padding(.horizontal, IslandLayout.padding) }
        }.frame(height: height, alignment: .top)
    }
}
struct TaskListView: View {
    @ObservedObject var model: IslandModel
    let height: CGFloat
    let onOpen: (String) -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(model.sessions.isEmpty ? "回复完成" : "运行中 \(model.runningCount)")
                    .font(.system(size: 11.5)).foregroundColor(.white.opacity(0.6))
                Spacer()
                IslandIconButton(symbol: "chevron.up", label: "收起任务") { model.dismiss() }
            }.padding(.horizontal, IslandLayout.padding).frame(height: IslandLayout.headerHeight)
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(model.visibleCompletions, id: \.id) { row in
                        SessionRowView(row: row, completed: true, onOpen: onOpen)
                    }
                    ForEach(model.visibleTasks, id: \.id) { row in
                        SessionRowView(row: row, completed: false, onOpen: onOpen)
                            .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5).padding(.horizontal, IslandLayout.padding) }
                    }
                }
            }.frame(height: max(0, height - IslandLayout.headerHeight - 8))
            Spacer(minLength: 0)
        }.frame(height: height, alignment: .top)
    }
}
struct NotchIslandView: View {
    @ObservedObject var model: IslandModel
    let onOpen: (String) -> Void
    let onDecision: (String, String) -> Void
    var body: some View {
        GeometryReader { proxy in
            let expanded = model.mode == .expanded
            let top = islandContentTopInset()
            let size = islandSize(model: model, notchWidth: islandNotchWidth(), contentTop: top, maxHeight: proxy.size.height)
            ZStack(alignment: .top) {
                NotchShape(topExtension: 6, bottomRadius: expanded ? 16 : 12).fill(.black).frame(width: size.width, height: size.height)
                if let toast = model.completionToast {
                    let label = (toast.title.isEmpty ? "任务" : toast.title) + " 已完成"
                    Text(label).font(.system(size: 12)).foregroundColor(.white.opacity(0.9))
                        .lineLimit(1).truncationMode(.middle).help(label)
                        .frame(width: max(0, size.width - 28), height: max(0, size.height - top))
                        .padding(.top, top).transition(.identity)
                } else if expanded {
                    Group {
                        if let approval = model.activeApproval {
                            ApprovalContentView(model: model, item: approval, height: max(0, size.height - top), onOpen: onOpen, onDecision: onDecision)
                        } else {
                            TaskListView(model: model, height: max(0, size.height - top), onOpen: onOpen)
                        }
                    }.frame(width: size.width).padding(.top, top).transition(.identity)
                } else if model.hasContent {
                    Button { model.toggleMode() } label: {
                        HStack(spacing: 5) {
                            Circle().fill(model.hasPending ? islandOrange : islandGreen).frame(width: 7, height: 7)
                            Text("\(model.hasPending ? model.approvals.count : model.runningCount)")
                                .font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundColor(.white.opacity(0.85))
                        }.frame(minWidth: 24, minHeight: 28).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    .accessibilityLabel(model.hasPending ? "展开待审批，\(model.approvals.count) 项" : "展开运行任务，\(model.runningCount) 个")
                    .position(x: proxy.size.width / 2 - size.width / 2 + 15, y: size.height / 2)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
            .animation(.spring(response: 0.26, dampingFraction: 0.9), value: model.mode)
            .animation(.spring(response: 0.26, dampingFraction: 0.9), value: size.height)
        }
    }
}

final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class IslandController {
    let panel: IslandPanel
    let model: IslandModel
    let hosting: NSHostingView<NotchIslandView>
    private var monitors: [Any] = []
    private var screenObserver: NSObjectProtocol?
    private var hideWork: DispatchWorkItem?
    private var completionWork: [String: DispatchWorkItem] = [:]

    init(model: IslandModel, onOpen: @escaping (String) -> Void, onDecision: @escaping (String, String) -> Void) {
        self.model = model
        panel = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: 432, height: IslandLayout.maxHeight),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.acceptsMouseMovedEvents = true
        let root = NotchIslandView(model: model, onOpen: { sessionId in
            onOpen(sessionId)
            model.dismiss()
        }, onDecision: onDecision)
        hosting = NSHostingView(rootView: root)
        panel.contentView = hosting

        // Install after initialization. Capturing the old global controller here
        // captured nil forever, so clicks changed SwiftUI but never window state.
        model.onModeChange = { [weak self] in
            self?.relayout()
            if CommandLine.arguments.contains("--demo"), let self = self {
                emitJson(["type": "demo-mode", "mode": self.model.mode.rawValue, "frame": NSStringFromRect(self.islandFrame)])
            }
        }
        if !isTestProtocol {
            installEventMonitors()
            screenObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.relayout() }
        }
    }

    deinit {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        if let observer = screenObserver { NotificationCenter.default.removeObserver(observer) }
        hideWork?.cancel()
        for work in completionWork.values { work.cancel() }
    }

    var mouseMonitorCount: Int { monitors.count }

    var islandFrame: CGRect {
        let screen = NSScreen.screens.first(where: { $0.auxiliaryTopLeftArea != nil }) ?? NSScreen.main
        let notchWidth: CGFloat
        if let screen = screen, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notchWidth = screen.frame.width - left.width - right.width
        } else {
            notchWidth = 185
        }
        let size = islandSize(model: model, notchWidth: notchWidth,
                              contentTop: islandContentTopInset(), maxHeight: panel.frame.height)
        return CGRect(x: panel.frame.midX - size.width / 2, y: panel.frame.maxY - size.height,
                      width: size.width, height: size.height)
    }

    func containsMouse(_ point: CGPoint) -> Bool {
        panel.isVisible && islandContains(point, frame: islandFrame, radius: model.mode == .expanded ? 16 : 12)
    }

    func syncMousePassthrough() {
        // The animation canvas is larger than the island. Its transparent area
        // must pass clicks through to the original app, including the first click.
        panel.ignoresMouseEvents = !containsMouse(NSEvent.mouseLocation)
    }

    private func installEventMonitors() {
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: clicks.union(moves), handler: { [weak self] event in
            guard let self = self else { return }
            if CommandLine.arguments.contains("--demo") && clicks.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue)) {
                emitJson(["type": "demo-click", "point": NSStringFromPoint(NSEvent.mouseLocation), "frame": NSStringFromRect(self.islandFrame), "mode": self.model.mode.rawValue])
            }
            if clicks.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue)),
               !self.containsMouse(NSEvent.mouseLocation) {
                self.model.dismiss()
            }
            self.syncMousePassthrough()
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: clicks.union(moves), handler: { [weak self] event in
            guard let self = self else { return event }
            let point = NSEvent.mouseLocation
            let isClick = clicks.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue))
            if isClick {
                if !self.containsMouse(point) {
                    self.model.dismiss()
                } else if event.window === self.panel && event.type == .leftMouseDown {
                    // Window coordinates start at the bottom; screen maxY is the top.
                    let inHeader = point.y >= self.islandFrame.maxY - islandContentTopInset()
                    if self.model.mode == .compact || inHeader {
                        self.model.toggleMode()
                        self.syncMousePassthrough()
                        return nil
                    }
                }
            }
            self.syncMousePassthrough()
            return event
        }) { monitors.append(monitor) }
    }

    func applyUpdate(_ payload: [String: Any]) {
        var rows: [IslandSession] = []
        for item in payload["sessions"] as? [[String: Any]] ?? [] {
            guard let id = item["id"] as? String else { continue }
            var pending: IslandPending? = nil
            if let pd = item["pending"] as? [String: Any] {
                pending = IslandPending(
                    requestId: (pd["requestId"] as? String) ?? "",
                    kind: (pd["kind"] as? String) ?? "permission",
                    toolName: (pd["toolName"] as? String) ?? "",
                    reason: stripEscalationPrefix((pd["reason"] as? String) ?? ""),
                    displayReason: (pd["displayReason"] as? String) ?? "",
                    questions: (pd["questions"] as? [[String: Any]]) ?? []
                )
            }
            rows.append(IslandSession(id: id, title: (item["title"] as? String) ?? "",
                                      running: (item["running"] as? Bool) ?? true, pending: pending))
        }
        model.sessions = rows
        let activeIDs = Set(rows.map { $0.id })
        model.completedFlash.removeAll { activeIDs.contains($0.id) }
        for item in payload["completed"] as? [[String: Any]] ?? [] {
            guard let id = item["id"] as? String, !activeIDs.contains(id) else { continue }
            model.completedFlash.removeAll { $0.id == id }
            model.completedFlash.append(IslandSession(id: id, title: item["title"] as? String ?? "", running: false, pending: nil))
            completionWork[id]?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.model.completedFlash.removeAll { $0.id == id }
                self.completionWork.removeValue(forKey: id)
                self.model.autoExpandIfNeeded()
                self.relayout()
            }
            completionWork[id] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
        }
        model.autoExpandIfNeeded()
        relayout()
    }

    func relayout() {
        let screen = NSScreen.screens.first(where: { $0.auxiliaryTopLeftArea != nil || $0.auxiliaryTopRightArea != nil }) ?? NSScreen.main
        guard let screen = screen else { return }
        let frame = screen.frame
        let notchCenter: CGFloat
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notchCenter = (left.maxX + right.minX) / 2
        } else {
            notchCenter = frame.midX
        }
        let panelW: CGFloat = max(IslandLayout.width + 40, islandNotchWidth() + 76)
        let panelH = min(IslandLayout.maxHeight, frame.height - 60)
        let target = NSRect(x: notchCenter - panelW / 2, y: frame.maxY - panelH, width: panelW, height: panelH)
        if panel.frame != target { panel.setFrame(target, display: true) }
        hideWork?.cancel()
        // Exercise the actual model and panel geometry without putting fixture
        // tasks over a user's running island or installing mouse monitors.
        if isTestProtocol {
            panel.orderOut(nil)
            panel.ignoresMouseEvents = true
            return
        }
        if !model.sessions.isEmpty || !model.completedFlash.isEmpty {
            panel.orderFrontRegardless()
        } else {
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                if self.model.sessions.isEmpty && self.model.completedFlash.isEmpty { self.panel.orderOut(nil) }
                self.syncMousePassthrough()
            }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        }
        syncMousePassthrough()
    }
}

var controller: IslandController?

func emitJson(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
    }
}

func applyUpdate(_ payload: [String: Any]) {
    controller?.applyUpdate(payload)
}

func pushDemo(_ withPending: Bool, _ completed: [[String: Any]]?) {
    var row2: [String: Any] = ["id": "demo-2", "title": "SILAS 数据同步", "running": true]
    if withPending {
        row2["pending"] = ["requestId": "demo-req-1", "kind": "permission", "toolName": "bash",
                            "reason": "演示审批：验证刘海生长动画与岛上裁决"]
    }
    var payload: [String: Any] = ["type": "update", "sessions": [
        ["id": "demo-1", "title": "灵动岛演示 · 长任务运行中", "running": true],
        row2
    ]]
    if let c = completed { payload["completed"] = c }
    applyUpdate(payload)
}

let app = NSApplication.shared
app.setActivationPolicy(isTestProtocol ? .prohibited : .accessory)

var demoMode = CommandLine.arguments.contains("--demo")
let sink: ([String: Any]) -> Void = { payload in
    emitJson(payload)
    if demoMode, (payload["type"] as? String) == "decision" {
        pushDemo(false, nil)   // 演示：裁决后收回常驻
    }
}
let islandModel = IslandModel(eventSink: sink)
controller = IslandController(
    model: islandModel,
    onOpen: { sessionId in emitJson(["type": "open", "sessionId": sessionId]) },
    onDecision: { requestId, outcome in sink(["type": "decision", "requestId": requestId, "outcome": outcome]) }
)

if demoMode {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        pushDemo(true, nil)
        FileHandle.standardError.write("[island] demo: expanded with approval\n".data(using: .utf8)!)
    }
}

emitJson(["type": "ready"])
let stdinQueue = DispatchQueue(label: "island-stdin")
if !demoMode { stdinQueue.async {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdin.availableData   // 阻塞式读取（read(upToCount:) 在 stdin 上不阻塞，会静默退出）
        if chunk.isEmpty {
            DispatchQueue.main.async { NSApp.terminate(nil) }
            break
        }
        if buffer.count + chunk.count > 1_500_000 {
            DispatchQueue.main.async { NSApp.terminate(nil) }
            break
        }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: UInt8(10)) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let line = String(data: lineData, encoding: .utf8), !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let t = obj["type"] as? String
            if t == "update" {
                DispatchQueue.main.async { applyUpdate(obj) }
            } else if t == "shutdown" {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            } else if t == "inspect", CommandLine.arguments.contains("--test-protocol") {
                DispatchQueue.main.async {
                    guard let controller = controller else { return }
                    let model = controller.model
                    emitJson(["type": "inspection", "mode": model.mode.rawValue,
                              "width": controller.islandFrame.width, "height": controller.islandFrame.height,
                              "approvalIds": model.approvals.map { $0.id },
                              "selectedRequestId": model.activeApproval?.id ?? "",
                              "visibleTaskIds": model.visibleTasks.map { $0.id },
                              "visibleCompletionIds": model.visibleCompletions.map { $0.id },
                              "runningCount": model.runningCount,
                              "completionToast": model.completionToast.map { ($0.title.isEmpty ? "任务" : $0.title) + " 已完成" } ?? "",
                              "windowNumber": controller.panel.windowNumber,
                              "panelCount": NSApp.windows.filter { $0 is IslandPanel }.count,
                              "panelVisible": controller.panel.isVisible,
                              "mouseMonitorCount": controller.mouseMonitorCount,
                              "body": model.activeApproval.map { approvalText($0.pending) } ?? ""])
                }
            } else if t == "test-next-approval", CommandLine.arguments.contains("--test-protocol") {
                DispatchQueue.main.async { controller?.model.selectApproval(offset: 1) }
            } else if t == "toggle" {
                DispatchQueue.main.async { controller?.model.toggleMode() }
            }
        }
    }
} }

app.run()
