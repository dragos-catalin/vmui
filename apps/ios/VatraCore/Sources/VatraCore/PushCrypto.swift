import CryptoKit
import Foundation

/// End-to-end encryption between the hub and this device for pushes that travel through the Vatra push
/// relay (docs/product/cloud/CONTRACT.md "End-to-end encryption"): `e` = b64url(nonce 12 ‖ ciphertext ‖
/// tag 16), AES-256-GCM with the per-device key the hub returned at registration, aad = the card id. The
/// relay and Apple only ever see the ciphertext.
public enum PushCrypto {
  public static func open(key: Data, cardId: String, e: String) -> Data? {
    guard key.count == 32, !cardId.isEmpty, let blob = b64url(e), blob.count > 28 else { return nil }
    do {
      let box = try AES.GCM.SealedBox(combined: blob)
      return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(cardId.utf8))
    } catch {
      return nil
    }
  }

  /// base64url without padding (padding tolerated).
  public static func b64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.hasSuffix("=") { t.removeLast() }
    guard !t.isEmpty, t.count % 4 != 1 else { return nil }
    t += String(repeating: "=", count: (4 - t.count % 4) % 4)
    return Data(base64Encoded: t)
  }
}

/// The intercom Live Activity's encrypted part (`content-state.e`): what only this member may see.
public struct ActivitySecret: Codable, Sendable, Equatable {
  public var canOpen = false
  public var door = ""
  enum CodingKeys: String, CodingKey { case canOpen, door }
  public init(canOpen: Bool = false, door: String = "") { self.canOpen = canOpen; self.door = door }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    canOpen = try c.v(.canOpen, false); door = try c.v(.door, "")
  }

  public static func open(key: Data, cardId: String, e: String) -> ActivitySecret? {
    PushCrypto.open(key: key, cardId: cardId, e: e).flatMap { try? Wire.decoder.decode(ActivitySecret.self, from: $0) }
  }
}

extension PushPayload {
  /// The relay's `vatra` object: `{v:"1", id, e, full, type}`. Nil for a direct APNs push.
  public struct RelayEnvelope: Sendable, Equatable {
    public let id: String
    public let e: String
    public let full: Bool
    public let type: String
  }

  public static func relayEnvelope(_ userInfo: [AnyHashable: Any]) -> RelayEnvelope? {
    guard let v = userInfo["vatra"] as? [AnyHashable: Any], let id = v["id"] as? String, !id.isEmpty,
      let e = v["e"] as? String, !e.isEmpty
    else { return nil }
    return RelayEnvelope(id: id, e: e, full: (v["full"] as? String) != "0", type: (v["type"] as? String) ?? "card")
  }

  /// Decrypts a relay push with this device's key for that hub. The plaintext is the UnifiedPush JSON of the
  /// card (or its minimal form with `fetch:"1"`, also implied by `full:"0"`). Nil when it is not a relay
  /// push, the key is wrong, the ciphertext was tampered with, or it names another card.
  public static func fromRelay(_ userInfo: [AnyHashable: Any], key: Data) -> PushPayload? {
    guard let env = relayEnvelope(userInfo), let plain = PushCrypto.open(key: key, cardId: env.id, e: env.e),
      let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
    else { return nil }
    var m = obj
    if !env.full { m["fetch"] = "1" }
    guard let p = from(userInfo: m), p.id == env.id else { return nil }
    return p
  }
}
