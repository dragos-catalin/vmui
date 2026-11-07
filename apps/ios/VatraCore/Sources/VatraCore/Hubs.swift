import Foundation

/// One paired hub. The token is this device's own `vmd_` credential for that hub only.
public struct PairedHub: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let baseUrl: String
  public let token: String
  public let deviceId: String
  public var memberName: String = ""
  public var addedAt: Int64 = 0

  public init(id: String, name: String, baseUrl: String, token: String, deviceId: String, memberName: String = "", addedAt: Int64 = 0) {
    self.id = id; self.name = name; self.baseUrl = baseUrl; self.token = token; self.deviceId = deviceId
    self.memberName = memberName; self.addedAt = addedAt
  }

  public func with(id: String? = nil, token: String? = nil) -> PairedHub {
    PairedHub(id: id ?? self.id, name: name, baseUrl: baseUrl, token: token ?? self.token, deviceId: deviceId, memberName: memberName, addedAt: addedAt)
  }
}

/// A person may belong to several homes (parents' house, holiday home): one active, the rest switchable.
public struct HubList: Codable, Sendable, Equatable {
  public var hubs: [PairedHub] = []
  public var activeId: String?

  public init(hubs: [PairedHub] = [], activeId: String? = nil) { self.hubs = hubs; self.activeId = activeId }

  public var active: PairedHub? { hubs.first { $0.id == activeId } ?? hubs.first }

  /// Re-pairing the same hub (same address) replaces its old entry instead of duplicating it.
  public func add(_ h: PairedHub) -> HubList {
    HubList(hubs: hubs.filter { $0.baseUrl != h.baseUrl && $0.id != h.id } + [h], activeId: h.id)
  }

  public func remove(_ id: String) -> HubList {
    let rest = hubs.filter { $0.id != id }
    return HubList(hubs: rest, activeId: activeId == id ? rest.first?.id : activeId)
  }

  public func select(_ id: String) -> HubList { hubs.contains { $0.id == id } ? HubList(hubs: hubs, activeId: id) : self }

  public func encode() -> Data { Wire.encode(self) }

  public static func decode(_ d: Data?) -> HubList {
    guard let d, let l = try? Wire.decoder.decode(HubList.self, from: d) else { return HubList() }
    return l
  }
}
