import AppKit
import Combine
import SwiftUI
import ZecoriCore

/// The menu bar item: the coin glyph and the tightest headline percentage, red when a limit is out,
/// the snapshot is stale or the instance cannot be read. Left click toggles the panel, middle or
/// Option-click refreshes, right click opens a small menu.
@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    private let store: WidgetStore
    private let openSettings: () -> Void
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private var subscription: AnyCancellable?

    init(store: WidgetStore, openSettings: @escaping () -> Void) {
        self.store = store
        self.openSettings = openSettings
        super.init()
        item.autosaveName = "zecori"
        if let button = item.button {
            button.image = Glyph.image()
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp, .otherMouseUp])
        }
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        let hosting = NSHostingController(rootView: PanelView(store: store, openSite: { [weak self] in self?.openSite() }, openSettings: openSettings))
        hosting.sizingOptions = []
        popover.contentViewController = hosting
        subscription = store.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.render() } }
        render()
    }

    private func render() {
        guard let button = item.button else { return }
        let presenter = store.presenter
        let color: NSColor = presenter.alarming ? .systemRed : .labelColor
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        button.attributedTitle = NSAttributedString(string: " " + presenter.barLabel, attributes: [.foregroundColor: color, .font: font])
        button.contentTintColor = presenter.alarming ? .systemRed : nil
        button.toolTip = presenter.barTooltip
        if popover.isShown { popover.contentSize = fittedSize() }
    }

    /// The whole panel if it fits, otherwise the height of the screen below the menu bar (then it scrolls).
    private func fittedSize() -> NSSize {
        let probe = NSHostingView(rootView: PanelContent(presenter: store.presenter, busy: store.busy))
        let content = ceil(probe.fittingSize.height)
        let screen = item.button?.window?.screen ?? NSScreen.main
        let available = (screen?.visibleFrame.height ?? 800) - 24
        return NSSize(width: PanelContent.width, height: max(120, min(content, available)))
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return togglePanel() }
        switch event.type {
        case .rightMouseUp: showMenu()
        case .otherMouseUp: store.refresh()
        default:
            if event.modifierFlags.contains(.option) { store.refresh() } else { togglePanel() }
        }
    }

    private func togglePanel() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = item.button else { return }
        store.panelOpened()
        popover.contentSize = fittedSize()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        NSApp.activate(ignoringOtherApps: true)
    }

    func popoverDidClose(_ notification: Notification) { store.panelClosed() }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refreshNow), keyEquivalent: "r").target = self
        menu.addItem(withTitle: "Open Zecori", action: #selector(openSiteAction), keyEquivalent: "o").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(settingsAction), keyEquivalent: ",").target = self
        menu.addItem(withTitle: "Quit Zecori", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    @objc private func refreshNow() { store.refresh() }
    @objc private func openSiteAction() { openSite() }
    @objc private func settingsAction() { openSettings() }

    func openSite() {
        popover.performClose(nil)
        if let url = URL(string: Defaults.baseURL) { NSWorkspace.shared.open(url) }
    }
}
