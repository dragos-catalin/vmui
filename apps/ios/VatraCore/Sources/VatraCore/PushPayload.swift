import Foundation

/// One wake-up from the hub. On iOS it arrives as the APNs `vatra` dictionary (src/lib/notify/apns.ts), which
/// carries the same string fields as the FCM data map and the UnifiedPush JSON, so all three apps share one shape.
public struct PushPayload: Sendable, Equatable {
  public let type: String
  public let id: String
  public let kind: String
  public let tag: String
  public let title: String
  public let body: String
  public let subtitle: String
  public let color: String
  public let priority: String
  public let progress: Int?
  public let actions: [CardAction]
  public let url: String
  public let sticky: Bool
  public let at: Int64
  /// The payload was trimmed to fit: fetch the full card from /api/v1/app/notify.
  public let needsFetch: Bool

  public var isDismiss: Bool { type == "dismiss" }
  public var isIntercomRing: Bool { kind == "intercom" && !isDismiss && (priority == "high" || priority == "urgent") }

  /// Stable notification identifier (tag wins, so a re-sent card replaces itself).
  public var threadKey: String { tag.isEmpty ? id : tag }

  /// UNNotificationCategory per action set, registered by the app (`vatra.<kind>`).
  public var category: String { "vatra.\(kind.isEmpty ? "card" : kind)" }

  public static func from(map m: [String: String]) -> PushPayload? {
    guard let id = m["id"], !id.isEmpty else { return nil }
    let actions: [CardAction] = m["actions"].flatMap { s in
      s.isEmpty ? nil : try? Wire.decoder.decode([CardAction].self, from: Data(s.utf8))
    } ?? []
    return PushPayload(
      type: m["type"] ?? "card", id: id, kind: m["kind"] ?? "", tag: m["tag"] ?? "", title: m["title"] ?? "",
      body: m["body"] ?? "", subtitle: m["subtitle"] ?? "", color: m["color"] ?? "", priority: m["priority"] ?? "default",
      progress: m["progress"].flatMap(Int.init), actions: actions, url: m["url"] ?? "", sticky: m["sticky"] == "1",
      at: m["at"].flatMap { Int64($0) } ?? 0, needsFetch: m["fetch"] == "1")
  }

  /// UnifiedPush-style JSON bytes (and the APNs `vatra` object re-serialised).
  public static func from(json: Data) -> PushPayload? {
    guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
    return from(userInfo: obj)
  }

  /// `userInfo["vatra"]` of an APNs notification, or a flat dictionary of strings.
  public static func from(userInfo: [AnyHashable: Any]) -> PushPayload? {
    let src = (userInfo["vatra"] as? [AnyHashable: Any]) ?? userInfo
    var m: [String: String] = [:]
    for (k, v) in src {
      guard let k = k as? String else { continue }
      switch v {
      case let s as String: m[k] = s
      case let n as NSNumber: m[k] = n.stringValue
      default: continue
      }
    }
    return from(map: m)
  }
}
