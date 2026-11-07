#if os(iOS)
import ActivityKit
import Foundation

/// The intercom ring on the Lock Screen and Dynamic Island. The hub starts it with an APNs push-to-start
/// (src/lib/notify/apns.ts, attributes-type "IntercomAttributes"); field names must match that payload.
struct IntercomAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var ringing: Bool
    /// Unix seconds when the ring started.
    var since: Int
    var canOpen: Bool
  }

  var cardId: String
  var door: String
}
#endif
