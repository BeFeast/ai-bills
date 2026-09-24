import SwiftUI
import ZecoriCore

/// The panel, section for section like the Omarchy widget: hero, stale/error banner, empty state,
/// LIMITS NOW (per account: headline value, meter, headline line, the other windows), footer.
/// Meters are drawn from shapes, not ProgressView, so the --render PNGs show them too.
struct PanelView: View {
    @ObservedObject var store: WidgetStore
    var openSite: () -> Void = {}
    var openSettings: () -> Void = {}
    @State private var contentHeight: CGFloat = 200

    var body: some View {
        ScrollView(.vertical) {
            PanelContent(presenter: store.presenter, busy: store.busy, refresh: store.refresh, openSite: openSite, openSettings: openSettings)
                .background(GeometryReader { proxy in Color.clear.preference(key: HeightKey.self, value: proxy.size.height) })
        }
        .scrollIndicators(.automatic)
        .frame(width: PanelContent.width, height: min(contentHeight, 640))
        .onPreferenceChange(HeightKey.self) { contentHeight = $0 }
        .onKeyPress("r") { store.refresh(); return .handled }
        .onKeyPress(.return) { store.refresh(); return .handled }
    }

    private struct HeightKey: PreferenceKey {
        static var defaultValue: CGFloat = 200
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }
}

struct PanelContent: View {
    static let width: CGFloat = 380
    let presenter: Presenter
    var busy = false
    var refresh: () -> Void = {}
    var openSite: () -> Void = {}
    var openSettings: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            hero
            if !presenter.bannerText.isEmpty { banner }
            if let empty = presenter.emptyText {
                Text(empty).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 8)
            }
            if !presenter.accounts.isEmpty {
                Divider()
                Text("LIMITS NOW").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                ForEach(presenter.accounts) { account in AccountRow(account: account, presenter: presenter) }
            }
            Divider()
            HStack {
                Text("r refresh · esc close").font(.caption2).foregroundStyle(.tertiary)
                Spacer()
                Button(action: openSite) { Text("Open Zecori").font(.caption).foregroundStyle(Color.accentColor) }.buttonStyle(.plain)
                Text("·").font(.caption).foregroundStyle(.tertiary)
                Button(action: openSettings) { Text("Settings…").font(.caption).foregroundStyle(Color.accentColor) }.buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(width: Self.width, alignment: .leading)
    }

    private var hero: some View {
        HStack(spacing: 12) {
            Image(nsImage: Glyph.mark).resizable().interpolation(.high).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Zecori").font(.title3.weight(.bold))
                    if busy { Text("refreshing").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1).overlay(Capsule().stroke(.secondary.opacity(0.5))) }
                }
                Text(presenter.heroMeta.uppercased()).font(.caption2.weight(.bold)).tracking(1.1).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            // Plain SwiftUI buttons (not AppKit-backed styles), so the --render PNGs show them too.
            Button(action: refresh) { Image(systemName: "arrow.clockwise").font(.body.weight(.medium)).foregroundStyle(.secondary) }
                .buttonStyle(.plain).help("Refresh")
            Button(action: openSite) { Image(systemName: "arrow.up.forward.square").font(.body.weight(.medium)).foregroundStyle(.secondary) }
                .buttonStyle(.plain).help("Open Zecori")
        }
    }

    private var banner: some View {
        Text(presenter.bannerText).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red.opacity(0.35)))
    }
}

struct AccountRow: View {
    let account: Account
    let presenter: Presenter

    var body: some View {
        let alarming = Presenter.accountAlarming(account)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.label).font(.body.weight(.bold)).lineLimit(1)
                Spacer()
                Text(Presenter.valueText(account)).font(.body.monospacedDigit().weight(alarming || Presenter.accountWarning(account) ? .bold : .regular))
                    .foregroundStyle(alarming ? Color.red : Color.primary)
            }
            if let ratio = Presenter.meterRatio(account) { Meter(value: ratio, alarming: alarming) }
            let line = presenter.headlineLine(account)
            if !line.isEmpty {
                Text(line).font(.caption).foregroundStyle(Presenter.stateIsUrgent(account) ? Color.red : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let others = presenter.otherWindowsText(account)
            if !others.isEmpty {
                Text(others).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// What is left, drawn as a filled capsule over a track.
struct Meter: View {
    let value: Double
    let alarming: Bool
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.12))
                Capsule().fill(alarming ? Color.red : Color.primary.opacity(0.75)).frame(width: max(0, proxy.size.width * value))
            }
        }
        .frame(height: 5)
    }
}
