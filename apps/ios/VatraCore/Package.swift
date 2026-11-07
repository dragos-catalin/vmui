// swift-tools-version: 6.0
// VatraCore: wire models of /api/v1/app/*, the hub client, pairing, push payload and brand tokens for
// the Vatra iPhone / iPad / watch apps. No UIKit or SwiftUI, so `swift test` runs on the macOS build
// host without a Simulator. Same contract fixtures as the Android :core (docs/api/fixtures).
import PackageDescription

let package = Package(
  name: "VatraCore",
  platforms: [.iOS(.v18), .watchOS(.v11), .macOS(.v15)],
  products: [.library(name: "VatraCore", targets: ["VatraCore"])],
  targets: [
    .target(name: "VatraCore"),
    .testTarget(name: "VatraCoreTests", dependencies: ["VatraCore"]),
  ]
)
