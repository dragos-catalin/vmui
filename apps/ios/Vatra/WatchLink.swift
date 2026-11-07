import Foundation
import VatraCore
import WatchConnectivity

/// Phone side of watch pairing: when the watch asks, mint a one-time invite on the active hub for this member
/// (POST /api/devices/pair/invite) and hand the vatra://pair link back. The watch then pairs as its own device.
final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = WatchLink()

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    guard message["want"] as? String == "invite" else { return replyHandler(["error": "unknown"]) }
    let reply = UncheckedReply(replyHandler)
    Task {
      guard let c = VatraEnv.activeClient() else { return reply.send(["error": "not_paired"]) }
      switch await c.invite() {
      case .ok(let inv): reply.send(["link": inv.link])
      case .refused(_, let code, _): reply.send(["error": code])
      default: reply.send(["error": "offline"])
      }
    }
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
}

private struct UncheckedReply: @unchecked Sendable {
  let f: ([String: Any]) -> Void
  init(_ f: @escaping ([String: Any]) -> Void) { self.f = f }
  func send(_ v: [String: Any]) { f(v) }
}
