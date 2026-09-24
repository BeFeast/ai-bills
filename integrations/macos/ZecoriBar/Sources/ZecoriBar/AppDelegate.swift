import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = WidgetStore()
    private var status: StatusItemController?
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Credentials.importLegacyFileIfNeeded()
        status = StatusItemController(store: store, openSettings: { [weak self] in self?.showSettings() })
        store.start()
        if Credentials.read() == nil { showSettings() }
    }

    func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(store: store)))
            window.title = "Zecori Settings"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.center()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
}
