import ActivityKit
import Foundation
import UIKit
import UserNotifications
import VatraCore

/// APNs for the active hub: asks for permission, registers the device token (and the intercom Live Activity
/// push-to-start token) with PUT /api/v1/app/push kind apns. The hub sends through its own key or the Vatra
/// push relay (src/lib/notify/apns.ts); when it can do neither (`apns: false`) nothing is registered.
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
    guard await c.pushConfig().value?.apns == true else { return }
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
    guard enabled, let c = VatraEnv.activeClient() else { return }
    _ = await c.registerPush(.apns(token: hex, sandbox: sandbox, activityToken: VatraEnv.group.string(forKey: activityKey)))
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

