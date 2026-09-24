// swift-tools-version: 5.9
import PackageDescription

// Zecori in the macOS menu bar: the same GET /api/widget answer the Omarchy widget draws.
// ZecoriCore holds the payload model and every display rule (ported from the Omarchy
// Panel.qml helpers), so both clients say the same thing; ZecoriBar is the AppKit/SwiftUI app.
let package = Package(
    name: "ZecoriBar",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "ZecoriCore"),
        .executableTarget(name: "ZecoriBar", dependencies: ["ZecoriCore"]),
        .testTarget(name: "ZecoriCoreTests", dependencies: ["ZecoriCore"], resources: [.copy("Fixtures")]),
    ]
)
