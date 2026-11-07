import AppIntents

/// Siri / Spotlight phrases. Every phrase must contain the app name token.
struct VatraShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: HouseActionIntent(),
      phrases: ["Run \(\.$action) in \(.applicationName)", "\(.applicationName) \(\.$action)"],
      shortTitle: "intent.action.title",
      systemImageName: "house")
    AppShortcut(
      intent: SceneIntent(),
      phrases: ["Set \(\.$scene) lights in \(.applicationName)", "\(.applicationName) scene \(\.$scene)"],
      shortTitle: "intent.scene.title",
      systemImageName: "lightbulb.2")
    AppShortcut(
      intent: SetDeviceIntent(),
      phrases: ["Switch a device in \(.applicationName)"],
      shortTitle: "intent.toggle.title",
      systemImageName: "power")
  }
}
