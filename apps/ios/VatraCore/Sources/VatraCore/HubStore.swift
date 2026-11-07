import Foundation
import Security

/// Paired hubs in the Keychain (one generic-password item holding the whole list, decoded once per read).
/// `accessGroup` is the shared group of the app, its widget / intents / notification extensions and the
/// watch app, so a Control Center button acts with the same `vmd_` token. `ThisDeviceOnly`: the tokens
/// never leave this device in a backup or iCloud Keychain; a restored phone simply pairs again.
public final class HubStore: @unchecked Sendable {
  private let service: String
  private let account = "hubs.v1"
  private let accessGroup: String?
  private let lock = NSLock()

  public init(service: String = "ro.vatra.hubs", accessGroup: String? = nil) {
    self.service = service
    self.accessGroup = accessGroup
  }

  private func base() -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    return q
  }

  public func current() -> HubList {
    lock.lock(); defer { lock.unlock() }
    return read()
  }

  private func read() -> HubList {
    var q = base()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return HubList() }
    return HubList.decode(out as? Data)
  }

  @discardableResult
  public func update(_ f: (HubList) -> HubList) -> HubList {
    lock.lock(); defer { lock.unlock() }
    let next = f(read())
    let data = next.encode()
    let attrs: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let st = SecItemUpdate(base() as CFDictionary, attrs as CFDictionary)
    if st == errSecItemNotFound {
      var add = base()
      add.merge(attrs) { $1 }
      SecItemAdd(add as CFDictionary, nil)
    }
    return next
  }
}
