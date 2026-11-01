import Cocoa

// Icon trên thanh menu cho CPM-server: bật/tắt server, mở trình duyệt, tự chạy khi mở máy.
let res = (Bundle.main.resourcePath ?? "")
func ctl(_ args: String...) -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [res + "/ctl.sh"] + args
    let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    p.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}
func ctlAsync(_ args: [String], done: (() -> Void)? = nil) {
    DispatchQueue.global().async {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [res + "/ctl.sh"] + args
        try? p.run(); p.waitUntilExit()
        if let d = done { DispatchQueue.main.async(execute: d) }
    }
}

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    var up = false
    let background = CommandLine.arguments.contains("--background")

    func applicationDidFinishLaunching(_ n: Notification) {
        if let b = item.button {
            if let img = NSImage(systemSymbolName: "terminal", accessibilityDescription: "CPM-server") { b.image = img } else { b.title = "CPM" }
        }
        menu.delegate = self
        item.menu = menu
        ctlAsync([background ? "start-bg" : "start"]) { [weak self] in
            if self?.background == false { self?.openBrowser() }
        }
    }
    func openBrowser() { if let u = URL(string: ctl("url")) { NSWorkspace.shared.open(u) } }

    func menuNeedsUpdate(_ m: NSMenu) {
        up = ctl("status") == "up"
        m.removeAllItems()
        let st = NSMenuItem(title: up ? "Server đang chạy — \(ctl("url"))" : "Server đang tắt", action: nil, keyEquivalent: "")
        st.isEnabled = false; m.addItem(st)
        m.addItem(.separator())
        m.addItem(mk("Mở trình duyệt", #selector(open)))
        m.addItem(mk(up ? "Dừng server" : "Khởi động server", #selector(toggle)))
        let au = mk("Tự chạy khi mở máy", #selector(autostart))
        au.state = ctl("autostart") == "on" ? .on : .off
        m.addItem(au)
        m.addItem(.separator())
        m.addItem(mk("Thoát (dừng server)", #selector(quit)))
    }
    func mk(_ t: String, _ a: Selector) -> NSMenuItem { let i = NSMenuItem(title: t, action: a, keyEquivalent: ""); i.target = self; return i }
    @objc func open() { if !up { ctlAsync(["start"]) { self.openBrowser() } } else { openBrowser() } }
    @objc func toggle() { ctlAsync([up ? "stop" : "start"]) }
    @objc func autostart() { ctlAsync([ctl("autostart") == "on" ? "autostart-off" : "autostart-on"]) }
    @objc func quit() { ctlAsync(["stop"]) { NSApp.terminate(nil) } }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
