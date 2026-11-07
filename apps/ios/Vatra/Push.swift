import ActivityKit
import Foundation
import UIKit
import UserNotifications
import VatraCore

/// APNs for the active hub: asks for permission, then registers the device token (and the intercom Live
/// Activity push-to-start token). When the hub has Vatra Cloud push (`relay` in GET /api/v1/app/push) the
/// tokens go to the relay, which returns opaque handles; the hub gets only those (PUT kind relay) and answers
/// with a fresh end-to-end key kept in the shared Keychain for the notification service. Otherwise PUT kind
/// apns as before (the hub's own .p8 key); with neither (`apns: false`, no relay) nothing is registered.
enum Push {
  static var enabled: Bool { VatraEnv.group.object(forKey: "push.on") as? Bool ?? true }

  /// Development-signed builds talk to the APNs sandbox (the entitlement says which).
  static var sandbox: Bool {
    #if DEBUG
    return true
    #else
    return Bundle.main.path(forResource: "embedded", ofType: "mobileprovision")
      .flatMap { try? String(contentsOfFile: $0, encoding: .isoLatin1) }?
      .contains("<key>aps-environment</key>\n\t\t<string>development</string>") ?? false
    #endif
  }

  private static let tokenKey = "push.apnsToken"
  private static let activityKey = "push.activityToken"

  /// Card actions become notification buttons per kind. The NSE replaces them with the card's real actions
  /// (it can set a dynamic category), so these are the fallback when the extension could not run.
  static func registerCategories() {
    let kinds = ["intercom", "pairing", "water", "copilot", "agents", "pc", "pi", "door", "window", "presence", "battery", "contact", "system", "card"]
    var cats = Set(kinds.map { UNNotificationCategory(identifier: "vatra.\($0)", actions: [], intentIdentifiers: [], options: [.customDismissAction]) })
    cats.insert(UNNotificationCategory(
      identifier: "vatra.intercom.open",
      actions: [
        UNNotificationAction(identifier: "vatra.open", title: L("door_open"), options: [.authenticationRequired]),
        UNNotificationAction(identifier: "vatra.ignore", title: L("door_ignore"), options: []),
      ],
      intentIdentifiers: [], options: [.customDismissAction]))
    UNUserNotificationCenter.current().setNotificationCategories(cats)
  }

  /// Called after pairing, hub switch, the Settings toggle and every launch.
  static func refresh() async {
    guard let hub = VatraEnv.store.current().active else { return }
    let c = VatraEnv.client(hub)
    guard enabled else {
      _ = await c.registerPush(.none)
      return
    }
    guard let cfg = await c.pushConfig().value, cfg.apns || cfg.relay != nil else { return }
    let center = UNUserNotificationCenter.current()
    let ok = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    guard ok else { return }
    await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
    observeActivityToken()
    if let t = VatraEnv.group.string(forKey: tokenKey) { await send(t) }
  }

  static func deviceToken(_ hex: String) async {
    VatraEnv.group.set(hex, forKey: tokenKey)
    await send(hex)
  }

  private static func send(_ hex: String) async {
    guard enabled, let hub = VatraEnv.store.current().active else { return }
    let c = VatraEnv.client(hub)
    let activity = VatraEnv.group.string(forKey: activityKey)
    let cfg = await c.pushConfig().value
    if let relay = cfg?.relay, await sendRelay(relay, client: c, hubId: hub.id, token: hex, activity: activity) { return }
    guard cfg?.apns ?? true else { return }
    _ = await c.registerPush(.apns(token: hex, sandbox: sandbox, activityToken: activity))
  }

  /// Handles from the relay, then PUT kind relay; stores the rotated key. False when any step failed, so the
  /// caller falls back to a direct registration (the hub may still send through its own key).
  private static func sendRelay(_ relay: PushRelay, client c: HubClient, hubId: String, token: String, activity: String?) async -> Bool {
    let platform = sandbox ? "apns-sandbox" : "apns"
    let rc = RelayClient(baseUrl: relay.url)
    guard let handle = await rc.handle(platform: platform, token: token, hub: relay.hub).value else { return false }
    var activityHandle: String?
    if let activity { activityHandle = await rc.handle(platform: platform, token: activity, hub: relay.hub).value }
    guard let key = await c.registerRelay(platform: platform, handle: handle, activityHandle: activityHandle).value?.key else { return false }
    return VatraEnv.pushKeys.set(key, hub: hubId)
  }

  /// iOS 17.2+: a token that lets the hub START the intercom Live Activity without the app running.
  private static func observeActivityToken() {
    Task {
      for await data in Activity<IntercomAttributes>.pushToStartTokenUpdates {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        guard hex != VatraEnv.group.string(forKey: activityKey) else { continue }
        VatraEnv.group.set(hex, forKey: activityKey)
        if let t = VatraEnv.group.string(forKey: tokenKey) { await send(t) }
      }
    }
  }

  static func endIntercomActivities() async {
    for a in Activity<IntercomAttributes>.activities {
      await a.end(nil, dismissalPolicy: .immediate)
    }
  }
}

