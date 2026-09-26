import AppKit

/// The approved bar mark (integrations/omarchy/befeast.zecori/assets/zecori-glyph-coin.svg): a Z in a
/// coin ring with the mascot's two ear discs. Drawn from the same 24×24 geometry, as a template image,
/// so macOS tints it like every other menu bar icon.
enum Glyph {
    static func image(pointSize: CGFloat = 16) -> NSImage {
        let image = NSImage(size: NSSize(width: pointSize, height: pointSize), flipped: true) { rect in
            let scale = rect.width / 24
            let transform = NSAffineTransform()
            transform.scale(by: scale)
            NSColor.black.setFill()
            let shape = path()
            shape.transform(using: transform as AffineTransform)
            shape.windingRule = .evenOdd
            shape.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Zecori"
        return image
    }

    private static func path() -> NSBezierPath {
        let p = NSBezierPath()
        // Coin ring: outer r 10.15, inner r 8.31 (even-odd leaves the ring).
        p.appendOval(in: NSRect(x: 12 - 10.15, y: 12 - 10.15, width: 20.3, height: 20.3))
        p.appendOval(in: NSRect(x: 12 - 8.31, y: 12 - 8.31, width: 16.62, height: 16.62))
        // Ear discs, left and right, rounded on the outer side.
        p.append(ear(mirrored: false))
        p.append(ear(mirrored: true))
        // Z.
        let z = NSBezierPath()
        let pts: [(CGFloat, CGFloat)] = [(8.31, 7.38), (15.69, 7.38), (15.69, 9.23), (11.05, 14.77), (15.69, 14.77),
                                          (15.69, 16.62), (8.31, 16.62), (8.31, 14.77), (12.95, 9.23), (8.31, 9.23)]
        z.move(to: NSPoint(x: pts[0].0, y: pts[0].1))
        for point in pts.dropFirst() { z.line(to: NSPoint(x: point.0, y: point.1)) }
        z.close()
        p.append(z)
        return p
    }

    private static func ear(mirrored: Bool) -> NSBezierPath {
        let e = NSBezierPath()
        let x: (CGFloat) -> CGFloat = { mirrored ? 24 - $0 : $0 }
        e.move(to: NSPoint(x: x(3.19), y: 9.23))
        e.line(to: NSPoint(x: x(1.85), y: 9.23))
        e.curve(to: NSPoint(x: x(0), y: 11.08), controlPoint1: NSPoint(x: x(0.83), y: 9.23), controlPoint2: NSPoint(x: x(0), y: 10.06))
        e.line(to: NSPoint(x: x(0), y: 12.92))
        e.curve(to: NSPoint(x: x(1.85), y: 14.77), controlPoint1: NSPoint(x: x(0), y: 13.94), controlPoint2: NSPoint(x: x(0.83), y: 14.77))
        e.line(to: NSPoint(x: x(3.19), y: 14.77))
        e.close()
        return e
    }

    /// The whole status item content — coin glyph, gap, percentage — as ONE image. As a template
    /// (normal state) the menu bar tints it light or dark per wallpaper like every other icon; a
    /// button title and contentTintColor do not follow the wallpaper on macOS 26+ (CodexBar renders
    /// its label the same way). An alarm draws it red and not as a template, so the red survives.
    static func statusImage(label: String, alarming: Bool) -> NSImage {
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        let text = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.black])
        let textSize = text.size()
        let glyphSize: CGFloat = 16, gap: CGFloat = 4, height: CGFloat = 22
        let size = NSSize(width: ceil(glyphSize + gap + textSize.width), height: height)
        let glyph = image(pointSize: glyphSize)
        let result = NSImage(size: size, flipped: false) { rect in
            glyph.draw(in: NSRect(x: 0, y: (height - glyphSize) / 2, width: glyphSize, height: glyphSize))
            text.draw(at: NSPoint(x: glyphSize + gap, y: floor((height - textSize.height) / 2) + 1))
            if alarming {
                NSColor.systemRed.setFill()
                rect.fill(using: .sourceAtop)
            }
            return true
        }
        result.isTemplate = !alarming
        result.accessibilityDescription = "Zecori \(label)"
        return result
    }

    /// The portrait for the panel hero, shipped in Contents/Resources; the coin stands in without it.
    static var mark: NSImage {
        if let url = Bundle.main.url(forResource: "zecori-mark", withExtension: "png"), let image = NSImage(contentsOf: url) { return image }
        if let path = ProcessInfo.processInfo.environment["ZECORI_MARK"], let image = NSImage(contentsOfFile: path) { return image }
        return image(pointSize: 36)
    }
}
