import AppKit

// `ZecoriBar --render <payload.json> <out-dir> [now-iso]` draws the panel and bar label to PNGs
// and exits: CI uses it to show the UI without anyone at the Mac. Otherwise it is a menu bar app.
let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--render"), arguments.count > index + 2 {
    let code = MainActor.assumeIsolated { Renderer.run(payload: arguments[index + 1], outDir: arguments[index + 2], now: arguments.count > index + 3 ? arguments[index + 3] : nil) }
    exit(code)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
