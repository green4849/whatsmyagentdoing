// Entry point. The menu bar app is WMADMenuBar.swift; the wandering character is Pet.swift.
import AppKit

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
            for r in g.rows { print("  ● \(r.line1)\n      \(r.line2)" + (r.ctx.map { " · 컨텍스트 \($0.left)% 남음\($0.tone == .quiet ? "" : $0.tone == .failed ? " [빨강]" : " [주황]")" } ?? "")) }
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
