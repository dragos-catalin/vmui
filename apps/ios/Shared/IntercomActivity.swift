#if os(iOS)
import ActivityKit
import Foundation
import VatraCore

/// The intercom ring on the Lock Screen and Dynamic Island. The hub starts it with an APNs push-to-start
/// (src/lib/notify/apns.ts, attributes-type "IntercomAttributes"); field names must match that payload.
/// Through the Vatra Cloud relay the member-specific part is end-to-end encrypted in `e` ({canOpen, door},
/// aad = cardId) so the relay and Apple never learn it; a direct push carries `canOpen` / `door` in clear.
/// Everything but `ringing` / `since` / `cardId` is optional so either shape decodes.
struct IntercomAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var ringing: Bool
    /// Unix seconds when the ring started.
    var since: Int
    var canOpen: Bool?
    var e: String?
  }

  var cardId: String
  var door: String?

  /// What this member may see: decrypted from `e` with the key of whichever paired hub opens it, else the
  /// clear fields; no key or a bad ciphertext = generic ring without the Open button.
  func secret(_ s: ContentState) -> ActivitySecret {
    if let e = s.e, !e.isEmpty {
      for h in VatraEnv.store.current().hubs {
        if let k = VatraEnv.pushKeys.key(hub: h.id), let v = ActivitySecret.open(key: k, cardId: cardId, e: e) { return v }
      }
      return ActivitySecret()
    }
    return ActivitySecret(canOpen: s.canOpen ?? false, door: door ?? "")
  }
}
#endif
