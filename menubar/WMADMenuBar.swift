// A menu bar item for whatsmyagentdoing: one icon with a status dot, and a
// click opens the same session list as the dashboard's side panel.
// Talks only to the local dashboard (127.0.0.1); sends nothing anywhere else.
import AppKit

// MARK: - Settings

let PORT = Int(ProcessInfo.processInfo.environment["WMAD_PORT"] ?? "") ?? 4545
let BASE = URL(string: "http://127.0.0.1:\(PORT)")!
let HOME = FileManager.default.homeDirectoryForCurrentUser.path
let REPO = ProcessInfo.processInfo.environment["WMAD_REPO"] ?? "\(HOME)/Documents/whatsmyagentdoing"
let FINISHED_LIMIT = 8   // finished rows shown before "… N more"
let ACTIVE: Set<String> = ["thinking", "tool", "typing"]

// MARK: - Data from /api/sessions and /events

struct Account: Decodable { let id: String?; let label: String?; let color: String? }
struct Outcome: Decodable { let kind: String?; let detail: String? }
struct Session: Decodable {
    let key: String
    let agent: String
    let subagent: Bool?
    let cwd: String?
    let project: String?
    let title: String?
    let account: Account?
    let outcome: Outcome?
    let status: String
    let stuck: Int?
    let activity: String?
    let error: String?
    let reply: String?
    let turnStartedAt: Double?
    let lastEventAt: Double?
    let startedAt: Double?
}
struct Snapshot: Decodable { let now: Double; let sessions: [Session] }

// The dashboard's rules (public/index.html): failed = error or outcome failed.
extension Session {
    var failed: Bool { status == "error" || outcome?.kind == "failed" }
    var needsYou: Bool { status == "waiting" || failed }
    var working: Bool { ACTIVE.contains(status) }
    var isSub: Bool { subagent ?? false }
    var folder: String { project ?? AGENT_NAME[agent] ?? agent }
    // By status a row is named after its session when it has one (titles are hidden under --private).
    var name: String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        return folder
    }
}

let AGENT_NAME = ["claude": "Claude", "codex": "Codex", "gemini": "Gemini", "copilot": "Copilot",
                  "omp": "OMP", "pi": "Pi", "antigravity": "Antigravity"]
let STATUS_KO = ["thinking": "생각 중", "tool": "실행 중", "typing": "답변 작성 중", "waiting": "응답 대기",
                 "done": "완료", "interrupted": "중단됨", "error": "오류", "idle": "대기"]

// MARK: - Colours (dashboard's footer-circle rule: green working, orange needs you, red failed)

// Blue: finished, and you haven't checked it here yet.
enum Tone { case quiet, working, unseen, waiting, failed }
func tone(_ s: Session) -> Tone {
    if s.failed { return .failed }
    if s.status == "waiting" { return .waiting }
    if s.working { return .working }
    if Seen.shared.isUnseen(s) { return .unseen }
    return .quiet
}
func color(_ t: Tone) -> NSColor {
    switch t {
    case .failed: return NSColor(srgbRed: 0.88, green: 0.30, blue: 0.27, alpha: 1)
    case .waiting: return NSColor(srgbRed: 0.93, green: 0.58, blue: 0.13, alpha: 1)
    case .unseen: return NSColor(srgbRed: 0.24, green: 0.52, blue: 0.93, alpha: 1)
    case .working: return NSColor(srgbRed: 0.20, green: 0.70, blue: 0.42, alpha: 1)
    case .quiet: return .tertiaryLabelColor
    }
}

// MARK: - "Checked" finished sessions
// The menu bar can't see whether you read a reply in the agent's own app, so a
// finished turn counts as checked once you click its row (or "mark all").
// A turn is told apart by when it started, so a new turn that finishes is blue again.
final class Seen {
    static let shared = Seen()
    private let key = "seenTurns"
    private var map: [String: Double]
    private(set) var hasBaseline: Bool
    init() {
        let d = UserDefaults.standard.dictionary(forKey: key) as? [String: Double]
        map = d ?? [:]
        hasBaseline = d != nil
    }
    static func turn(_ s: Session) -> Double { s.turnStartedAt ?? s.lastEventAt ?? 0 }
    func isUnseen(_ s: Session) -> Bool {
        !s.isSub && s.status == "done" && !s.failed && (map[s.key] ?? -1) < Seen.turn(s)
    }
    func mark(_ list: [Session]) {
        for s in list { map[s.key] = Seen.turn(s) }
        save()
    }
    // First run: what is already finished counts as checked, so the menu doesn't start all blue.
    func baseline(_ snap: Snapshot) {
        guard !hasBaseline else { return }
        hasBaseline = true
        mark(snap.sessions.filter { $0.status == "done" })
    }
    // Forget sessions the dashboard no longer lists.
    func prune(_ snap: Snapshot) {
        let keys = Set(snap.sessions.map(\.key))
        let kept = map.filter { keys.contains($0.key) }
        if kept.count != map.count { map = kept; save() }
    }
    private func save() { UserDefaults.standard.set(map, forKey: key) }
}

// MARK: - Numbers ①②③ (same as the dashboard's updateBadges)

let CIRCLED = Array("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")
final class Badges {
    private var map: [String: Int] = [:]
    func update(_ list: [Session]) {
        let active = list.filter { !$0.isSub && ($0.needsYou || $0.working) }
        let keys = Set(active.map(\.key))
        map = map.filter { keys.contains($0.key) }
        var used = Set(map.values)
        for s in active.sorted(by: { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }) where map[s.key] == nil {
            var n = 1
            while used.contains(n) { n += 1 }
            if n > CIRCLED.count { break }
            map[s.key] = n; used.insert(n)
        }
    }
    func char(_ s: Session) -> String { map[s.key].map { String(CIRCLED[$0 - 1]) } ?? "" }
}

// MARK: - Menu model (kept apart from AppKit so --dump can print it)

struct Row { let s: Session; let badge: String; let line1: String; let line2: String; let tip: String }
struct Group { let title: String; let rows: [Row]; let more: Int; var unseen = false }

func dur(_ ms: Double) -> String {
    let m = Int(ms / 60000)
    if m < 1 { return "\(max(0, Int(ms / 1000)))초" }
    if m < 60 { return "\(m)분" }
    return "\(m / 60)시간 \(m % 60)분"
}
func ago(_ t: Double, _ now: Double) -> String {
    let s = (now - t) / 1000
    if s < 45 { return "방금" }
    let m = Int((s / 60).rounded())
    if m < 60 { return "\(m)분 전" }
    let h = Int((Double(m) / 60).rounded())
    if h < 24 { return "\(h)시간 전" }
    return "\(Int((Double(h) / 24).rounded()))일 전"
}
func timeLabel(_ s: Session, _ now: Double) -> String {
    if (s.working || s.status == "waiting"), let t = s.turnStartedAt { return dur(now - t) }
    return s.lastEventAt.map { ago($0, now) } ?? ""
}
func oneLine(_ x: String?, _ max: Int = 48) -> String {
    let t = (x ?? "").split(whereSeparator: \.isNewline).first.map(String.init)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    return t.count > max ? String(t.prefix(max - 1)) + "…" : t
}

func buildGroups(_ snap: Snapshot, _ badges: Badges) -> [Group] {
    // The side panel's defaults: no subagents, no idle sessions.
    let list = snap.sessions.filter { !$0.isSub && $0.status != "idle" }
    badges.update(list)
    let now = snap.now
    func row(_ s: Session) -> Row {
        let label = s.failed && s.status != "error" ? "요청 실패" : (STATUS_KO[s.status] ?? s.status)
        let act: String
        if s.failed { act = oneLine(s.outcome?.detail ?? s.error) }
        else if let m = s.stuck, m > 0 { act = "\(m)분째 진행 없음" }
        else if s.status == "done" { act = "" }
        else { act = oneLine(s.activity) }
        let name = oneLine(s.name, 40)
        let folder = name != s.folder ? "  · \(s.folder)" : ""
        let b = badges.char(s)
        let line1 = (b.isEmpty ? "" : "\(b) ") + name + folder
        let line2 = [label, act, timeLabel(s, now)].filter { !$0.isEmpty }.joined(separator: " · ")
        var tip = [s.title ?? s.folder, "폴더: \(s.cwd ?? s.folder)", "에이전트: \(AGENT_NAME[s.agent] ?? s.agent)"]
        if let a = s.account?.label { tip.append("계정: \(a)") }
        return Row(s: s, badge: b, line1: line1, line2: line2, tip: tip.joined(separator: "\n"))
    }
    let recent: (Session, Session) -> Bool = { ($0.lastEventAt ?? 0) > ($1.lastEventAt ?? 0) }
    let need = list.filter(\.needsYou).sorted(by: recent)
    let work = list.filter { $0.working && !$0.needsYou }.sorted(by: recent)
    let fresh = list.filter { Seen.shared.isUnseen($0) }.sorted(by: recent)
    let fin = list.filter { !$0.needsYou && !$0.working && !Seen.shared.isUnseen($0) }.sorted(by: recent)
    var out: [Group] = []
    if !need.isEmpty { out.append(Group(title: "확인 필요 · \(need.count)", rows: need.map(row), more: 0)) }
    if !fresh.isEmpty { out.append(Group(title: "새로 완료 · \(fresh.count)", rows: fresh.map(row), more: 0, unseen: true)) }
    if !work.isEmpty { out.append(Group(title: "작업 중 · \(work.count)", rows: work.map(row), more: 0)) }
    if !fin.isEmpty {
        out.append(Group(title: "완료 · \(fin.count)", rows: fin.prefix(FINISHED_LIMIT).map(row),
                         more: max(0, fin.count - FINISHED_LIMIT)))
    }
    return out
}

struct Counts { var working = 0, unseen = 0, waiting = 0, failed = 0 }
func counts(_ snap: Snapshot) -> Counts {
    var c = Counts()
    for s in snap.sessions where !s.isSub && s.status != "idle" {
        switch tone(s) {
        case .failed: c.failed += 1
        case .waiting: c.waiting += 1
        case .unseen: c.unseen += 1
        case .working: c.working += 1
        case .quiet: break
        }
    }
    return c
}

// MARK: - Live connection to /events (SSE), reconnecting with backoff

final class Feed: NSObject, URLSessionDataDelegate {
    var onSnapshot: (Snapshot) -> Void = { _ in }
    var onDown: () -> Void = {}
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var delay: Double = 1

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60     // server pings every 20s
        cfg.timeoutIntervalForResource = .infinity
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }
    func start() {
        task?.cancel()
        buffer.removeAll()
        var req = URLRequest(url: BASE.appendingPathComponent("events"))
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        task = session.dataTask(with: req)
        task?.resume()
    }
    func reconnectSoon() {
        task?.cancel(); task = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.start() }
        delay = min(delay * 2, 30)
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        completionHandler(ok ? .allow : .cancel)
        if ok { delay = 1 }
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let sep = Data("\n\n".utf8)
        while let r = buffer.range(of: sep) {
            let chunk = buffer.subdata(in: buffer.startIndex..<r.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            guard let text = String(data: chunk, encoding: .utf8) else { continue }
            let payload = text.split(separator: "\n").filter { $0.hasPrefix("data:") }
                .map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }.joined()
            if payload.isEmpty { continue }   // ": ping"
            if let snap = try? JSONDecoder().decode(Snapshot.self, from: Data(payload.utf8)) { onSnapshot(snap) }
        }
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if (error as NSError?)?.code == NSURLErrorCancelled && self.task !== task { return }
        onDown()
        reconnectSoon()
    }
}

// MARK: - Server on/off

func findNode() -> String? {
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: p) { return p }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v node"]
    let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
    let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return s.isEmpty ? nil : s
}

// Same as the `office` alias, without opening a browser; detached so it outlives this app.
func startServer() {
    guard let node = findNode() else { return alert("node를 찾지 못했습니다.") }
    let cli = "\(REPO)/bin/cli.js"
    guard FileManager.default.fileExists(atPath: cli) else { return alert("\(cli)가 없습니다.") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", "nohup \"$0\" \"$1\" --port \"$2\" --no-open >/dev/null 2>&1 &", node, cli, String(PORT)]
    var env = ProcessInfo.processInfo.environment
    env["WMAD_NO_UPDATE_CHECK"] = "1"
    env["WMAD_ACCOUNT_LABELS"] = "\(HOME)/.whatsmyagentdoing/accounts.json"
    p.environment = env
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try? p.run()
}

// The server only honours this with its custom header (web pages can't send it).
func stopServer() {
    var req = URLRequest(url: BASE.appendingPathComponent("api/shutdown"))
    req.httpMethod = "POST"
    req.setValue("stop", forHTTPHeaderField: "x-whatsmyagentdoing")
    URLSession.shared.dataTask(with: req).resume()
}

func alert(_ text: String) {
    let a = NSAlert(); a.messageText = text; a.runModal()
}

// The Safari "Add to Dock" app for this dashboard, if there is one; else the default browser.
func openDashboard() {
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "\(HOME)/Applications")) ?? []
    for name in apps where name.hasSuffix(".app") {
        let path = "\(HOME)/Applications/\(name)"
        guard let info = NSDictionary(contentsOfFile: "\(path)/Contents/Info.plist"),
              (info["CFBundleIdentifier"] as? String)?.hasPrefix("com.apple.Safari.WebApp") == true,
              "\(info)".contains("localhost:\(PORT)") || "\(info)".contains("127.0.0.1:\(PORT)") else { continue }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init())
        return
    }
    NSWorkspace.shared.open(URL(string: "http://localhost:\(PORT)/")!)
}

// MARK: - The menu bar item

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let feed = Feed()
    let badges = Badges()
    var snap: Snapshot?
    var up = false
    var showCounts: Bool {
        get { UserDefaults.standard.bool(forKey: "showCounts") }
        set { UserDefaults.standard.set(newValue, forKey: "showCounts"); refreshIcon() }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        item.button?.imagePosition = .imageLeading
        refreshIcon()
        let debug = ProcessInfo.processInfo.environment["WMAD_DEBUG"] != nil
        feed.onSnapshot = { [weak self] s in
            Seen.shared.baseline(s); Seen.shared.prune(s)
            self?.snap = s; self?.up = true; self?.refreshIcon()
            if debug { let c = counts(s); print("snapshot: 작업 \(c.working) 새로완료 \(c.unseen) 확인 \(c.waiting) 실패 \(c.failed)"); fflush(stdout) }
        }
        feed.onDown = { [weak self] in
            self?.up = false; self?.refreshIcon()
            if debug { print("server down"); fflush(stdout) }
        }
        feed.start()
    }

    func refreshIcon() {
        guard let b = item.button else { return }
        let img = NSImage(systemSymbolName: "building.2", accessibilityDescription: "에이전트 사무실")
        img?.isTemplate = true
        b.image = img
        b.appearsDisabled = !up
        let title = NSMutableAttributedString()
        let font = NSFont.menuBarFont(ofSize: 0)
        if up, let s = snap {
            let c = counts(s)
            if showCounts {
                for (n, t) in [(c.working, Tone.working), (c.unseen, .unseen), (c.waiting, .waiting), (c.failed, .failed)] where n > 0 {
                    title.append(NSAttributedString(string: " \(n)", attributes: [.foregroundColor: color(t), .font: font]))
                }
            } else {
                let top: Tone? = c.failed > 0 ? .failed : c.waiting > 0 ? .waiting : c.unseen > 0 ? .unseen : c.working > 0 ? .working : nil
                if let t = top {
                    title.append(NSAttributedString(string: "●", attributes: [
                        .foregroundColor: color(t), .font: NSFont.systemFont(ofSize: 8), .baselineOffset: 3]))
                }
            }
            b.toolTip = "작업 중 \(c.working) · 새로 완료 \(c.unseen) · 확인 필요 \(c.waiting) · 요청 실패 \(c.failed)"
        } else {
            b.toolTip = "대시보드 서버 꺼짐"
        }
        b.attributedTitle = title
    }

    // Rebuilt each time it opens, from the latest snapshot.
    func menuNeedsUpdate(_ m: NSMenu) {
        m.removeAllItems()
        if up, let s = snap {
            let groups = buildGroups(s, badges)
            if groups.isEmpty { m.addItem(disabled("지금은 조용합니다")) }
            for g in groups {
                m.addItem(NSMenuItem.sectionHeader(title: g.title))
                for r in g.rows { m.addItem(sessionItem(r)) }
                if g.more > 0 { m.addItem(disabled("    … 외 \(g.more)개는 대시보드에서")) }
                if g.unseen { m.addItem(action("    모두 확인함으로 표시", #selector(markAll))) }
            }
        } else {
            m.addItem(disabled("대시보드 서버가 꺼져 있습니다"))
        }
        m.addItem(.separator())
        m.addItem(action("대시보드 열기", #selector(openDash), key: "o"))
        m.addItem(.separator())
        if up { m.addItem(action("서버 끄기", #selector(stop))) }
        else { m.addItem(action("서버 켜기", #selector(start))) }
        let counts = action("메뉴 막대에 숫자 표시", #selector(toggleCounts))
        counts.state = showCounts ? .on : .off
        m.addItem(counts)
        m.addItem(.separator())
        m.addItem(action("종료", #selector(quit), key: "q"))
    }

    func sessionItem(_ r: Row) -> NSMenuItem {
        let it = NSMenuItem(title: r.line1, action: #selector(openSession(_:)), keyEquivalent: "")
        it.target = self
        it.representedObject = r.s.key
        let t = NSMutableAttributedString()
        t.append(NSAttributedString(string: "● ", attributes: [.foregroundColor: color(tone(r.s)), .font: NSFont.systemFont(ofSize: 10)]))
        t.append(NSAttributedString(string: r.line1, attributes: [.font: NSFont.menuFont(ofSize: 13)]))
        t.append(NSAttributedString(string: "\n    " + r.line2, attributes: [
            .font: NSFont.menuFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
        it.attributedTitle = t
        it.toolTip = r.tip
        return it
    }
    func disabled(_ s: String) -> NSMenuItem { let i = NSMenuItem(title: s, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
    func action(_ s: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: s, action: sel, keyEquivalent: key); i.target = self; return i
    }

    @objc func openDash() { openDashboard() }
    // Clicking a row counts as checking it.
    @objc func openSession(_ sender: NSMenuItem) {
        if let k = sender.representedObject as? String, let s = snap?.sessions.first(where: { $0.key == k }) {
            Seen.shared.mark([s]); refreshIcon()
        }
        openDashboard()
    }
    @objc func markAll() {
        if let s = snap { Seen.shared.mark(s.sessions.filter { Seen.shared.isUnseen($0) }); refreshIcon() }
    }
    @objc func start() { startServer(); DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.feed.start() } }
    @objc func stop() { stopServer() }
    @objc func toggleCounts() { showCounts.toggle() }
    @objc func quit() { NSApp.terminate(nil) }
}

// MARK: - Entry

// `--dump`: print what the menu would show, once, and exit (for checking without clicking).
if CommandLine.arguments.contains("--dump") {
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: BASE.appendingPathComponent("api/sessions")) { data, _, err in
        defer { sem.signal() }
        guard let data, let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            print("서버 꺼짐 또는 응답 해석 실패: \(err?.localizedDescription ?? "decode")"); return
        }
        let c = counts(snap)
        print("[아이콘] 작업 \(c.working) · 새로 완료 \(c.unseen) · 확인 \(c.waiting) · 실패 \(c.failed)")
        for g in buildGroups(snap, Badges()) {
            print("== \(g.title)")
            for r in g.rows { print("  ● \(r.line1)\n      \(r.line2)") }
            if g.more > 0 { print("  … 외 \(g.more)개") }
        }
    }.resume()
    sem.wait()
    exit(0)
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
