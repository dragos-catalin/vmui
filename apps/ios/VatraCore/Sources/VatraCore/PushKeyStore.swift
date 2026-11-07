import Foundation
import Security

/// The per-device end-to-end push key of each paired hub, in the same shared Keychain access group as the
/// hub tokens (HubStore), so the notification service and the Live Activity widget can decrypt. One item
/// per hub id; `ThisDeviceOnly` and readable after first unlock (a push arrives while the phone is locked).
public final class PushKeyStore: @unchecked Sendable {
  private let service: String
  private let accessGroup: String?

  public init(service: String = "ro.vatra.pushkeys", accessGroup: String? = nil) {
    self.service = service
    self.accessGroup = accessGroup
  }

  private func base(_ hub: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: hub,
    ]
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    return q
  }

  public func key(hub: String) -> Data? {
    var q = base(hub)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 else { return nil }
    return d
  }

  /// Re-registering rotates the key: the new one simply replaces the old.
  @discardableResult
  public func set(_ key: Data, hub: String) -> Bool {
    guard key.count == 32 else { return false }
    let attrs: [String: Any] = [
      kSecValueData as String: key,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let st = SecItemUpdate(base(hub) as CFDictionary, attrs as CFDictionary)
    if st == errSecItemNotFound {
      var add = base(hub)
      add.merge(attrs) { $1 }
      return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    return st == errSecSuccess
  }

  public func remove(hub: String) { SecItemDelete(base(hub) as CFDictionary) }
}
