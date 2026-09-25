import SwiftUI
import ZecoriCore

/// The panel, section for section like the Omarchy widget: hero, stale/error banner, empty state,
/// LIMITS NOW (per account: headline value, meter, headline line, the other windows), MODELS (per model across
/// the pool: best remaining, meter, a chip per account, which account answers), footer.
/// Meters are drawn from shapes, not ProgressView, so the --render PNGs show them too.
struct PanelView: View {
    @ObservedObject var store: WidgetStore
    var openSite: () -> Void = {}
    var openSettings: () -> Void = {}

    // The popover's size is set by StatusItemController (content height, capped by the screen);
    // the scroll view only matters when the screen is shorter than the content.
    var body: some View {
        ScrollView(.vertical) {
            PanelContent(presenter: store.presenter, busy: store.busy, refresh: store.refresh, openSite: openSite, openSettings: openSettings)
        }
        .scrollIndicators(.automatic)
        .frame(width: PanelContent.width)
        .frame(maxHeight: .infinity, alignment: .top)
        .onKeyPress("r") { store.refresh(); return .handled }
        .onKeyPress(.return) { store.refresh(); return .handled }
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
            if !presenter.models.isEmpty {
                Divider()
                Text("MODELS").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                ForEach(presenter.models) { model in ModelRow(model: model, presenter: presenter) }
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

/// One model across the pool: the best account's remaining with its meter, a chip per account, then which account answers.
struct ModelRow: View {
    let model: WidgetModel
    let presenter: Presenter

    var body: some View {
        let alarming = Presenter.modelAlarming(model)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.label).font(.body.weight(.bold)).lineLimit(1)
                Spacer()
                Text(Presenter.modelValueText(model)).font(.body.monospacedDigit().weight(alarming || Presenter.modelWarning(model) ? .bold : .regular))
                    .foregroundStyle(alarming ? Color.red : Color.primary)
            }
            if let ratio = Presenter.modelMeterRatio(model) { Meter(value: ratio, alarming: alarming) }
            ChipFlow(spacing: 6) {
                ForEach(model.accounts) { entry in Chip(text: presenter.chipText(entry), tone: entry.tone, unknown: entry.remainingPercent == nil) }
            }
            let line = presenter.modelLine(model)
            if !line.isEmpty {
                Text(line).font(.caption).foregroundStyle(alarming ? Color.red : Color.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One account inside a model row: red when it has nothing left, bold when low, hollow when it reports no window.
struct Chip: View {
    let text: String
    let tone: String?
    let unknown: Bool

    var body: some View {
        let bad = tone == "bad"
        Text(text).font(.caption.weight(bad || tone == "warn" ? .bold : .regular)).lineLimit(1).truncationMode(.tail)
            .foregroundStyle(bad ? Color.red : (unknown ? Color.secondary : Color.primary))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(bad ? Color.red.opacity(0.12) : Color.primary.opacity(unknown ? 0 : 0.07)))
            .overlay(Capsule().stroke(bad ? Color.red.opacity(0.45) : Color.primary.opacity(unknown ? 0.25 : 0.12)))
    }
}

/// Lays the chips out left to right and wraps to the next line, like QML's Flow; a chip wider than the row is truncated.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, arrange(width: bounds.width, subviews: subviews).frames) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            size.width = min(size.width, width)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + rowHeight), frames)
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
