// A small character that wanders along the bottom of the screen and reacts to
// the agents: runs to the corner when one needs you, sits down crying after a
// failed request, hurries about while they work, dances while sound plays, and
// dozes when you're away. Click it to open the dashboard; drag to move it.
//
// The art is a sprite sheet made outside the repo (character art stays local):
// ~/.whatsmyagentdoing/pet/<name>-sheet.png + <name>-sheet.json
// with rows idle, walk (facing right), sleep, dance, waiting, failed, fall.
// Nothing here needs a permission prompt: sound is "is the output device in
// use", away is "seconds since the last input event".
import AppKit
import CoreAudio
import ImageIO

let PET_DIR = "\(HOME)/.whatsmyagentdoing/pet"
let PET_NAME = ProcessInfo.processInfo.environment["WMAD_PET"] ?? "usagi"

struct PetRow: Decodable { let name: String; let frames: Int; let fps: Double }
struct PetSheet: Decodable { let cell: [Int]; let displayPoints: [Double]; let rows: [PetRow] }

final class Sprite {
    let frames: [String: [CGImage]]
    let fps: [String: Double]
    let size: NSSize

    init?(name: String) {
        let png = URL(fileURLWithPath: "\(PET_DIR)/\(name)-sheet.png")
        guard let data = FileManager.default.contents(atPath: "\(PET_DIR)/\(name)-sheet.json"),
              let sheet = try? JSONDecoder().decode(PetSheet.self, from: data),
              sheet.cell.count == 2, sheet.displayPoints.count == 2,
              let src = CGImageSourceCreateWithURL(png as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let w = sheet.cell[0], h = sheet.cell[1]
        var f: [String: [CGImage]] = [:], r: [String: Double] = [:]
        for (i, row) in sheet.rows.enumerated() {
            f[row.name] = (0..<row.frames).compactMap { img.cropping(to: CGRect(x: $0 * w, y: i * h, width: w, height: h)) }
            r[row.name] = row.fps
        }
        guard f["idle"]?.isEmpty == false, f["walk"]?.isEmpty == false else { return nil }
        frames = f; fps = r
        size = NSSize(width: sheet.displayPoints[0], height: sheet.displayPoints[1])
    }
}

// Is anything playing through the default output device? No permission needed.
func soundPlaying() -> Bool {
    var dev = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                          mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev) == noErr else { return false }
    var running = UInt32(0)
    size = UInt32(MemoryLayout<UInt32>.size)
    addr.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
}

// Its voice: short clips in ~/.whatsmyagentdoing/pet/sounds/<name>/ (outside the repo),
// `ask.m4a` or variants `ask-1.m4a`, `ask-2.m4a` … picked at random. A missing
// clip is just skipped. Kept rare: 8 s between any two sounds, 2 min between the
// same one, one at a time (the order below is the priority), nothing while you're
// away or a full-screen app is in front, only ask and fail while music plays
// (plus dance, said as the music starts).
// Follows the Mac's volume and mute.
final class Voice {
    enum Kind: String, CaseIterable { case fail, ask, done, welcome, poke, dance
        case drop   // let go after a drag: said every time, right away (not rate-limited)
    }

    var on: Bool {
        get { UserDefaults.standard.object(forKey: "petSound") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "petSound") }
    }
    // Until when the output device being busy is (probably) our own clip: the device
    // stays "running" for a couple of seconds after a short sound ends.
    private(set) var selfUntil = 0.0
    private var pending: Set<Kind> = []
    private var lastAny = -1e9
    private var lastKind: [Kind: Double] = [:]
    private var player: NSSound?

    func want(_ k: Kind) { pending.insert(k) }

    // Said now, whatever the spacing rules say; it still counts as the last sound.
    func sayNow(_ k: Kind, now: Double) {
        guard on, let url = clip(k), let s = NSSound(contentsOf: url, byReference: true) else {
            NSLog("WMAD pet voice: %@ skipped (off or no clip)", k.rawValue); return
        }
        player?.stop(); player = s
        NSLog("WMAD pet voice: %@ %@ started=%d", k.rawValue, url.lastPathComponent, s.play() ? 1 : 0)
        lastAny = now; lastKind[k] = now
        selfUntil = now + s.duration + 3
        pending.removeAll()
    }

    func flush(now: Double, music: Bool, away: Bool, visible: Bool) {
        defer { pending.removeAll() }
        guard on, !away, visible, now - lastAny >= 8 else { return }
        for k in Kind.allCases where pending.contains(k) {
            // While music plays only ask and fail, and dance, which is said when the music starts.
            if music && k != .ask && k != .fail && k != .dance { continue }
            if now - (lastKind[k] ?? -1e9) < 120 { continue }
            guard let url = clip(k), let s = NSSound(contentsOf: url, byReference: true) else { continue }
            player?.stop()
            player = s
            NSLog("WMAD pet voice: %@ %@ started=%d", k.rawValue, url.lastPathComponent, s.play() ? 1 : 0)
            lastAny = now; lastKind[k] = now
            selfUntil = now + s.duration + 3
            return
        }
    }

    // Each character's clips are in sounds/<name>/ (the name of its sheet); clips left
    // directly in sounds/ are the fallback, so older setups keep working.
    private func clip(_ k: Kind) -> URL? {
        let root = "\(PET_DIR)/sounds"
        return clip(k, in: "\(root)/\(PET_NAME)") ?? clip(k, in: root)
    }

    private func clip(_ k: Kind, in dir: String) -> URL? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
        let exts: Set<String> = ["m4a", "wav", "mp3", "aiff", "caf"]
        let mine = names.filter { n in
            let u = URL(fileURLWithPath: n)
            guard exts.contains(u.pathExtension.lowercased()) else { return false }
            let base = u.deletingPathExtension().lastPathComponent
            if base == k.rawValue { return true }
            guard base.hasPrefix(k.rawValue + "-") else { return false }
            return Int(base.dropFirst(k.rawValue.count + 1)) != nil
        }
        return mine.randomElement().map { URL(fileURLWithPath: "\(dir)/\($0)") }
    }
}

// Seconds since the last keyboard or mouse input.
func secondsIdle() -> Double {
    let kinds: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged]
    return kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
}

// Something to stand on: the bottom of a screen (above the Dock on the main one),
// or the visible part of a Chrome window's top edge. Cocoa coordinates.
struct Floor {
    let window: Int?          // CGWindowNumber of the Chrome window, nil for the screen bottom
    let y: CGFloat
    let minX: CGFloat, maxX: CGFloat
    let originX: CGFloat      // the window's left edge, to carry the pet along when it moves
}

func screenFloor(_ s: NSScreen) -> Floor {
    let v = s.visibleFrame
    return Floor(window: nil, y: v.minY, minX: v.minX, maxX: v.maxX, originX: v.minX)
}

// What the window list says about Chrome: the top edges the pet can stand on, and
// the frontmost Chrome window (whose screen the pet lives on, even if that window
// leaves no room above it).
struct ChromeScan {
    var floors: [Floor] = []
    var front: Int? = nil
    var frontScreen: NSScreen? = nil
}

// Only window positions and the app's name are read (no titles, no screen
// recording). A window that reaches the top of its screen leaves no room above it,
// so it has no floor; parts covered by windows in front of it don't count either.
func scanChrome(pet: NSSize) -> ChromeScan {
    var out = ChromeScan()
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let primaryH = NSScreen.screens.first?.frame.height else { return out }
    let me = Int(getpid())
    var front: [CGRect] = []
    for w in info {   // front to back
        guard (w[kCGWindowLayer as String] as? Int) == 0, (w[kCGWindowOwnerPID as String] as? Int) != me,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: b) else { continue }
        let rect = CGRect(x: r.minX, y: primaryH - r.maxY, width: r.width, height: r.height)
        if (w[kCGWindowOwnerName as String] as? String) == "Google Chrome",
           r.height > 150, r.width > pet.width * 2,
           let num = w[kCGWindowNumber as String] as? Int,
           let scr = NSScreen.screens.first(where: { $0.frame.contains(CGPoint(x: rect.midX, y: rect.maxY - 1)) }) {
            if out.front == nil { out.front = num; out.frontScreen = scr }
            guard scr.visibleFrame.maxY - rect.maxY >= pet.height else { front.append(rect); continue }
            let band = CGRect(x: rect.minX, y: rect.maxY - 2, width: rect.width, height: pet.height + 2)
            // Only the part of the edge that is on its screen.
            var segs = [(max(rect.minX, scr.frame.minX), min(rect.maxX, scr.frame.maxX))]
            for o in front where o.intersects(band) {
                segs = segs.flatMap { s -> [(CGFloat, CGFloat)] in
                    if o.maxX <= s.0 || o.minX >= s.1 { return [s] }
                    return [(s.0, min(s.1, o.minX)), (max(s.0, o.maxX), s.1)].filter { $0.1 > $0.0 }
                }
            }
            for s in segs where s.1 - s.0 >= pet.width {
                out.floors.append(Floor(window: num, y: rect.maxY, minX: s.0, maxX: s.1, originX: rect.minX))
            }
        }
        front.append(rect)
    }
    return out
}

final class PetView: NSView {
    let sprite = CALayer()
    var onClick: () -> Void = {}
    var onDrag: (CGFloat, CGFloat) -> Void = { _, _ in }
    var onDrop: () -> Void = {}
    private var last: NSPoint?
    private var moved = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        sprite.frame = bounds
        sprite.contentsGravity = .resizeAspect
        sprite.contentsScale = 2
        layer?.addSublayer(sprite)
    }
    required init?(coder: NSCoder) { nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with e: NSEvent) { last = NSEvent.mouseLocation; moved = false }
    override func mouseDragged(with e: NSEvent) {
        guard let l = last else { return }
        let p = NSEvent.mouseLocation
        if !moved && hypot(p.x - l.x, p.y - l.y) < 4 { return }
        moved = true
        onDrag(p.x - l.x, p.y - l.y)
        last = p
    }
    override func mouseUp(with e: NSEvent) {
        if moved { onDrop() } else { onClick() }
        last = nil
    }

    func show(_ img: CGImage, mirrored: Bool) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        sprite.contents = img
        sprite.setAffineTransform(mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity)
        CATransaction.commit()
    }
}

final class Pet {
    enum Mood { case quiet, working, waiting, failed, music, away }

    private(set) var sprite = Sprite(name: PET_NAME)
    let voice = Voice()
    private var heard: Set<String> = []     // turns already called out (ask, fail, done)
    private var primed = false              // the first snapshot is only remembered, not announced
    private var askPending = false          // say "ask" once it reaches the corner
    private var window: NSPanel?
    private var view: PetView?
    private var timer: Timer?

    private var agents: Mood = .quiet
    // When each waiting turn was first seen: it runs to the corner for 15 s, then goes back
    // to what it was doing (the menu bar dot keeps showing it). A new wait shows again.
    private var askSeen: [String: Double] = [:]
    private let askShow = 15.0
    private var music = false
    private var soundSince: Double?
    private var silentSince: Double?
    private var away = false
    private var lastCheck = 0.0

    private var x: CGFloat = 200, y: CGFloat = 0, vy: CGFloat = 0
    private var dir: CGFloat = 1
    private var dragging = false, falling = false
    private var landing = 0.0
    private var home = NSScreen.screens.first          // whose bottom it falls to
    private var floor: Floor? = nil                     // what it stands on now
    private var floors: [Floor] = []                    // Chrome tops, refreshed a few times a second
    private var lastScan = 0.0
    private var target: Int? = nil, targetSince = 0.0  // the frontmost Chrome window, and since when
    private var targetScreen: NSScreen? = nil
    private var declined: Int? = nil                    // dragged off this window: leave it alone
    private var hop: (from: NSPoint, to: NSPoint, t: Double, dur: Double, floor: Floor)? = nil
    private var restUntil = 0.0, nextRest = CACurrentMediaTime() + 12
    private var row = "idle", frame = 0, phase = 0.0
    private var last = CACurrentMediaTime()

    var shown: Bool {
        get { UserDefaults.standard.object(forKey: "petShown") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "petShown"); newValue ? start() : stop() }
    }

    func start() {
        guard shown, let s = sprite, window == nil else { return }
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: s.size),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        // All desktops, but not over full-screen apps (videos, presentations): it just isn't shown there.
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        let v = PetView(frame: NSRect(origin: .zero, size: s.size))
        v.onClick = { [weak self] in self?.voice.want(.poke); openDashboard() }
        v.onDrag = { [weak self] dx, dy in
            guard let self else { return }
            self.dragging = true; self.falling = false; self.hop = nil
            self.x += dx; self.y += dy
        }
        v.onDrop = { [weak self] in
            guard let self, let size = self.sprite?.size else { return }
            let c = CGPoint(x: self.x + size.width / 2, y: self.y + size.height / 2)
            self.home = NSScreen.screens.first(where: { $0.frame.contains(c) }) ?? NSScreen.screens.first
            self.dragging = false; self.falling = true; self.vy = 0; self.floor = nil
            self.voice.sayNow(.drop, now: CACurrentMediaTime())
            // Put somewhere by hand: don't hop back onto the front Chrome window until another one comes to the front.
            self.declined = self.target
        }
        p.contentView = v
        if let vf = NSScreen.screens.first?.visibleFrame {
            x = vf.minX + vf.width * 0.3; y = vf.minY
        }
        window = p; view = v
        p.orderFrontRegardless()
        last = CACurrentMediaTime()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(self, selector: #selector(pause), name: NSWorkspace.screensDidSleepNotification, object: nil)
        ws.addObserver(self, selector: #selector(resume), name: NSWorkspace.screensDidWakeNotification, object: nil)
    }

    func stop() {
        timer?.invalidate(); timer = nil
        window?.orderOut(nil); window = nil; view = nil
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc private func pause() { timer?.invalidate(); timer = nil }
    @objc private func resume() {
        guard window != nil, timer == nil else { return }
        last = CACurrentMediaTime()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
    }

    // From the dashboard feed; nil when the server is down (then it just strolls).
    func update(_ snap: Snapshot?) {
        guard let snap else { agents = .quiet; askPending = false; askSeen = [:]; return }
        let list = snap.sessions.filter { !$0.isSub }
        // A failed request is cried over for ten minutes; after that the menu bar dot keeps it.
        let isFresh = { (s: Session) in s.failed && snap.now - (s.lastEventAt ?? 0) < 10 * 60 * 1000 }
        let freshFail = list.contains(where: isFresh)
        // Each turn is called out once: by the session and when its turn started.
        let turn = { (s: Session) in "\(s.key)@\(Seen.turn(s))" }
        let asks = Set(list.filter { $0.status == "waiting" && !$0.failed }.map { "a:" + turn($0) })
        let fails = Set(list.filter(isFresh).map { "f:" + turn($0) })
        let dones = Set(list.filter { $0.status == "done" && !$0.failed }.map { "d:" + turn($0) })
        if primed {
            if !asks.subtracting(heard).isEmpty { askPending = true }
            if !fails.subtracting(heard).isEmpty { voice.want(.fail) }
            if !dones.subtracting(heard).isEmpty { voice.want(.done) }
        }
        if asks.isEmpty { askPending = false }
        let t = CACurrentMediaTime()
        askSeen = askSeen.filter { asks.contains($0.key) }
        for k in asks where askSeen[k] == nil { askSeen[k] = t }
        if heard.count > 5000 { heard = [] }
        heard.formUnion(asks); heard.formUnion(fails); heard.formUnion(dones)
        primed = true
        if freshFail { agents = .failed }
        else if list.contains(where: \.working) { agents = .working }
        else { agents = .quiet }
    }

    private var mood: Mood {
        if askSeen.values.contains(where: { CACurrentMediaTime() - $0 < askShow }) { return .waiting }
        if agents == .failed { return .failed }
        if music { return .music }
        if agents == .working { return .working }
        if away { return .away }
        return .quiet
    }

    private func senses(_ now: Double) {
        guard now - lastCheck >= 1 else { return }
        lastCheck = now
        let wasAway = away
        away = secondsIdle() > 5 * 60
        if wasAway && !away { voice.want(.welcome) }
        // Its own clip (and the device winding down after it) isn't music.
        guard now >= voice.selfUntil else { soundSince = nil; return }
        let wasMusic = music
        defer { if music && !wasMusic { voice.want(.dance) } }
        if soundPlaying() {
            silentSince = nil
            soundSince = soundSince ?? now
            if now - (soundSince ?? now) >= 3 { music = true }     // not for a notification blip
        } else {
            soundSince = nil
            silentSince = silentSince ?? now
            if now - (silentSince ?? now) >= 2 { music = false }
        }
    }

    private func tick() {
        guard let s = sprite, let w = window, let v = view else { return }
        let now = CACurrentMediaTime()
        let dt = min(0.1, now - last); last = now
        senses(now)
        if mood != .waiting { askPending = false }      // its 15 s ran out before it got there

        if home == nil || !NSScreen.screens.contains(where: { $0 == home }) { home = NSScreen.screens.first }
        guard let screen = home else { return }
        let mid = { self.x + s.size.width / 2 }

        // Look more often while standing on a window, so it keeps up when the window is dragged.
        if now - lastScan >= (floor?.window != nil ? 0.1 : 0.3) {
            lastScan = now
            let scan = scanChrome(pet: s.size)
            floors = scan.floors
            if scan.front != target { target = scan.front; targetSince = now }
            targetScreen = scan.frontScreen
            if target != declined && declined != nil && target != nil { declined = nil }
            // Standing on a Chrome window: follow it as it moves or changes size, step over to
            // another visible part of it when a window covers this one, fall when it's gone.
            if let f = floor, let id = f.window, !dragging, !falling, hop == nil {
                let mine = floors.filter { $0.window == id }
                if let any = mine.first {
                    x += any.originX - f.originX
                    if let g = mine.first(where: { mid() >= $0.minX && mid() <= $0.maxX }) { floor = g }
                    else if let g = mine.min(by: { dist($0, mid()) < dist($1, mid()) }) {
                        if dist(g, mid()) <= s.size.width { floor = g; x = clampX(x, on: g, s.size.width) }
                        else { startHop(to: g, size: s.size, now: now) }
                    }
                } else { floor = nil; falling = true; vy = 0 }
            }
        }
        // Go to the frontmost Chrome window once it has been in front for a moment.
        if !dragging, !falling, hop == nil, landing <= 0, let id = target, id != declined,
           floor?.window != id, now - targetSince >= 1.0 {
            let mine = floors.filter { $0.window == id }
            if let g = mine.min(by: { dist($0, mid()) < dist($1, mid()) }), let scr = targetScreen {
                if scr == screen { startHop(to: g, size: s.size, now: now) }
                else { dropIn(on: g, from: screen, to: scr, size: s.size) }
            } else if let scr = targetScreen, scr != screen {
                // Its window fills its screen: wait at the bottom of that screen instead.
                dropIn(on: screenFloor(scr), from: screen, to: scr, size: s.size)
            }
        }
        let ground = screenFloor(home ?? screen)
        let here = floor ?? hop?.floor ?? ground
        let minX = here.minX, maxX = here.maxX - s.size.width
        var want = "idle", speed: CGFloat = 0, loopFrom = 0
        var fixed: Int? = nil

        if dragging {
            want = "fall"; fixed = 0
        } else if var h = hop {
            // A small jump in an arc up (or down) to a window's top edge.
            h.t += dt; hop = h
            let p = CGFloat(min(1, h.t / h.dur))
            let rise = max(h.to.y, h.from.y) + 40
            x = h.from.x + (h.to.x - h.from.x) * p
            // A parabola through from (p=0), the top (rise) and to (p=1).
            let a = h.from.y, c = h.to.y, b = 2 * rise - (a + c) / 2
            y = a * (1 - p) * (1 - p) + 2 * b * p * (1 - p) + c * p * p
            want = "fall"; fixed = p < 0.5 ? 0 : 1
            dir = h.to.x >= h.from.x ? 1 : -1
            if p >= 1 { floor = h.floor; y = h.to.y; hop = nil; landing = 0.3 }
        } else if falling {
            let before = y
            vy -= 2200 * dt; y += vy * dt
            want = "fall"; fixed = vy > -200 ? 0 : 1
            // Land on the first Chrome top it passes through, else on the screen bottom.
            let hit = floors.filter { before >= $0.y - feet - 1 && y <= $0.y - feet && mid() >= $0.minX && mid() <= $0.maxX }
                .max(by: { $0.y < $1.y })
            if let f = hit {
                floor = f; y = f.y - feet; falling = false; landing = 0.3
                if f.window == declined { declined = nil }   // put back on it by hand: fine to stay
            }
            else if y <= ground.y - feet { floor = nil; y = ground.y - feet; falling = false; landing = 0.3 }
        } else if landing > 0 {
            landing -= dt
            want = "fall"; fixed = landing > 0.15 ? 2 : 3
        } else {
            switch mood {
            case .waiting:
                let target = maxX - 12
                if abs(target - x) > 3 { want = "walk"; speed = 90; dir = target > x ? 1 : -1 }
                else {
                    want = "waiting"
                    if askPending { voice.want(.ask); askPending = false }
                }
            case .failed:
                want = "failed"; loopFrom = 4
            case .music:
                want = "dance"
            case .away:
                want = "sleep"
            case .working:
                want = "walk"; speed = 60
                if Double.random(in: 0..<1) < dt * 0.25 { dir *= -1 }
            case .quiet:
                if now < restUntil { want = "idle" }
                else {
                    want = "walk"; speed = 18
                    if now >= nextRest {
                        restUntil = now + Double.random(in: 3...8)
                        nextRest = restUntil + Double.random(in: 10...25)
                    }
                    if Double.random(in: 0..<1) < dt * 0.05 { dir *= -1 }
                }
            }
        }

        x += dir * speed * CGFloat(dt)
        if !dragging && hop == nil {
            if x <= minX { x = minX; if speed > 0 { dir = 1 } }
            if x >= maxX { x = maxX; if speed > 0 && mood != .waiting { dir = -1 } }
        }
        if !dragging && !falling && hop == nil { y = (floor ?? ground).y - feet }

        guard let frames = s.frames[want] ?? s.frames["idle"], !frames.isEmpty else { return }
        if want != row { row = want; frame = 0; phase = 0 }
        if let f = fixed {
            frame = min(f, frames.count - 1)
        } else {
            let fps = (s.fps[want] ?? 8) * (speed > 40 ? 2 : 1)
            phase += dt * fps
            while phase >= 1 {
                phase -= 1; frame += 1
                if frame >= frames.count { frame = min(loopFrom, frames.count - 1) }
            }
        }
        v.show(frames[frame], mirrored: want == "walk" && dir < 0)
        w.setFrameOrigin(NSPoint(x: x, y: y))
        // Not shown means a full-screen app is in front: stay quiet there too.
        voice.flush(now: now, music: music, away: away, visible: w.occlusionState.contains(.visible))
    }

    private let feet: CGFloat = 4             // the sheet leaves this much below the feet

    // How far a pet centred at `cx` is from standing on `f` (0 when it's over it).
    private func dist(_ f: Floor, _ cx: CGFloat) -> CGFloat {
        cx < f.minX ? f.minX - cx : (cx > f.maxX ? cx - f.maxX : 0)
    }

    private func clampX(_ x: CGFloat, on f: Floor, _ w: CGFloat) -> CGFloat {
        min(max(x, f.minX), max(f.minX, f.maxX - w))
    }

    // Jump to a floor on the same screen: land as close to where it is as the floor allows.
    private func startHop(to f: Floor, size: NSSize, now: Double) {
        let to = NSPoint(x: clampX(x, on: f, size.width), y: f.y - feet)
        let d = hypot(to.x - x, to.y - y)
        hop = (from: NSPoint(x: x, y: y), to: to, t: 0, dur: min(0.9, 0.45 + Double(d) / 2000), floor: f)
        floor = nil
    }

    // On another screen: appear just above the floor there and drop onto it.
    // Keeps the same place across the width, as a fraction of the screen.
    private func dropIn(on f: Floor, from: NSScreen, to screen: NSScreen, size: NSSize) {
        let frac = (x - from.frame.minX) / max(1, from.frame.width)
        home = screen
        x = clampX(screen.frame.minX + frac * screen.frame.width, on: f, size.width)
        y = min(f.y + size.height * 0.8, screen.visibleFrame.maxY - size.height)
        floor = nil; hop = nil; falling = true; vy = 0
    }
}
