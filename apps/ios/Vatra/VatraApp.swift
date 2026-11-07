import SwiftUI
import UIKit
@preconcurrency import UserNotifications
import VatraCore

@main
struct VatraApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel.shared
  @Environment(\.scenePhase) private var phase

  var body: some SwiftUI.Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .vatraThemed()
        .onOpenURL { model.open(url: $0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in a.webpageURL.map { model.open(url: $0) } }
    }
    .onChange(of: phase) { _, p in
      if p == .active { model.start() } else if p == .background { model.stop() }
    }
  }
}

/// APNs registration and notification actions. Buttons on a card run as this device through the hub
/// (/api/notify/act), exactly like the Android ActionReceiver.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    Push.registerCategories()
    WatchLink.shared.activate()
    Task { await Push.refresh() }
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task { await Push.deviceToken(hex) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    Task { @MainActor in AppModel.shared.pushError = true }
  }

  /// Silent pushes: a dismissed card removes its notification and ends a ringing Live Activity.
  func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
    guard let p = VatraEnv.push(userInfo)?.payload else { return .noData }
    if p.isDismiss {
      let center = UNUserNotificationCenter.current()
      let ids = await center.deliveredNotifications().filter { $0.request.identifier == p.threadKey || $0.request.content.threadIdentifier == p.threadKey }.map(\.request.identifier)
      center.removeDeliveredNotifications(withIdentifiers: ids + [p.threadKey])
      await Push.endIntercomActivities()
    }
    await AppModel.shared.refreshNow()
    return .newData
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    await AppModel.shared.refreshNow()
    return [.banner, .list, .sound]
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let info = response.notification.request.content.userInfo
    guard let got = VatraEnv.push(info) else { return }
    let p = got.payload, sender = got.client
    let action = response.actionIdentifier
    if action == UNNotificationDefaultActionIdentifier || action == UNNotificationDismissActionIdentifier {
      if let c = sender { _ = await c.notify(.read(ids: [p.id])) }
      if action == UNNotificationDefaultActionIdentifier { await MainActor.run { AppModel.shared.tab = .alerts } }
      return
    }
    let id = action.hasPrefix("vatra.") ? String(action.dropFirst(6)) : action
    if let url = p.actions.first(where: { $0.id == id })?.url, let u = URL(string: url) {
      await MainActor.run { UIApplication.shared.open(u) }
      return
    }
    if let c = sender { _ = await c.act(cardId: p.id, action: id) }
    await AppModel.shared.refreshNow()
  }
}
