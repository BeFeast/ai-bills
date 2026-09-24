import AppKit
import SwiftUI
import ZecoriCore

/// Draws the panel and the bar label from a payload file into PNGs (light and dark), for CI review.
@MainActor
enum Renderer {
    static func run(payload path: String, outDir: String, now nowText: String?) -> Int32 {
        guard let data = FileManager.default.contents(atPath: path) else { FileHandle.standardError.write(Data("cannot read \(path)\n".utf8)); return 2 }
        let payload: WidgetPayload
        do { payload = try PayloadDecoder.decode(data) } catch { FileHandle.standardError.write(Data("cannot decode: \(error)\n".utf8)); return 2 }
        let now = Presenter.parseDate(nowText) ?? Date()
        let presenter = Presenter(payload: payload, fetchedAt: now.addingTimeInterval(-40), now: now, timeZone: TimeZone(identifier: "UTC")!)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        var ok = true
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            let panel = PanelContent(presenter: presenter)
                .background(scheme == .dark ? Color(white: 0.16) : Color(white: 0.97))
                .environment(\.colorScheme, scheme)
            ok = write(panel, to: "\(outDir)/panel-\(name).png") && ok
            let bar = BarPreview(presenter: presenter).environment(\.colorScheme, scheme)
            ok = write(bar, to: "\(outDir)/bar-\(name).png") && ok
        }
        print("rendered to \(outDir): bar=\(presenter.barLabel) alarming=\(presenter.alarming)")
        return ok ? 0 : 1
    }

    private static func write<V: View>(_ view: V, to path: String) -> Bool {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return false }
        return FileManager.default.createFile(atPath: path, contents: png)
    }
}

/// The status item content as the menu bar would show it: template glyph in the label colour, then the percentage.
private struct BarPreview: View {
    let presenter: Presenter
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let color: Color = presenter.alarming ? .red : (scheme == .dark ? .white : .black)
        HStack(spacing: 4) {
            Image(nsImage: Glyph.image()).renderingMode(.template).foregroundStyle(color)
            Text(presenter.barLabel).font(.system(size: 13).monospacedDigit()).foregroundStyle(color)
        }
        .padding(.horizontal, 10).frame(height: 24)
        .background(scheme == .dark ? Color(white: 0.12) : Color(white: 0.92))
    }
}
