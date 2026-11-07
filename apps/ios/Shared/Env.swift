import Foundation
import VatraCore

/// Localised string from the target's String Catalog (Shared/Localizable.xcstrings, en + ro).
func L(_ key: String) -> String { NSLocalizedString(key, comment: "") }

func L(_ key: String, _ args: CVarArg...) -> String { String(format: NSLocalizedString(key, comment: ""), arguments: args) }

/// Process-wide access to the paired hubs and a client for the active one. Every target (app, widgets,
/// notification service, watch) reads the same Keychain item through the shared access group.
enum VatraEnv {
  static let store = HubStore()
  /// UserDefaults is documented thread-safe; it just is not marked Sendable.
  nonisolated(unsafe) static let group = UserDefaults(suiteName: "group.ro.vatra") ?? .standard

  /// `ro` when the device prefers Romanian, else `en` (the hub localises refusals and cards in it).
  static var language: String {
    (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("ro") ? "ro" : "en"
  }

  static func client(_ hub: PairedHub) -> HubClient { HubClient(baseUrl: hub.baseUrl, token: hub.token, language: language) }

  static func activeClient() -> HubClient? { store.current().active.map(client) }

  /// Per-hub end-to-end keys for relay pushes (same shared Keychain group as the tokens).
  static let pushKeys = PushKeyStore()

  /// A push as this device may read it: a relay push is decrypted with the key of whichever paired hub
  /// opens it (the push does not name the hub; AES-GCM rejects every other key), a direct push is read as
  /// is. The client is the hub that sent it, for fetching the full card or acting on it.
  static func push(_ userInfo: [AnyHashable: Any]) -> (payload: PushPayload, client: HubClient?)? {
    let hubs = store.current()
    if PushPayload.relayEnvelope(userInfo) != nil {
      let ordered = (hubs.active.map { [$0] } ?? []) + hubs.hubs.filter { $0.id != hubs.active?.id }
      for h in ordered {
        if let k = pushKeys.key(hub: h.id), let p = PushPayload.fromRelay(userInfo, key: k) { return (p, client(h)) }
      }
      return nil
    }
    return PushPayload.from(userInfo: userInfo).map { ($0, hubs.active.map(client)) }
  }
}

/// What the widgets, controls and complications draw without waiting for the network; written by the app
/// (and the widget timeline itself) after every successful refresh.
struct Glance: Codable, Sendable, Equatable {
  var lightsOn: Int?
  var waterMl: Int?
  var waterTarget: Int?
  var hubName: String?
  var devices: [GlanceDevice] = []
  var at: Date = .distantPast

  static let key = "glance.v1"

  static func load() -> Glance {
    guard let d = VatraEnv.group.data(forKey: key), let g = try? JSONDecoder().decode(Glance.self, from: d) else { return Glance() }
    return g
  }

  func save() {
    if let d = try? JSONEncoder().encode(self) { VatraEnv.group.set(d, forKey: Self.key) }
  }

  static func from(state: HomeState?, water: Water?, hub: String?) -> Glance {
    let tiles = state.map { HomeView.rooms($0).flatMap { r in r.devices.filter(\.toggleable).map { GlanceDevice(tile: $0, room: r.name) } } } ?? []
    return Glance(lightsOn: state.map(HomeView.lightsOn), waterMl: water?.ml, waterTarget: water?.target, hubName: hub, devices: tiles, at: Date())
  }

  /// Fetches fresh state + water from the active hub and stores it; nil when not paired or unreachable.
  static func refresh() async -> Glance? {
    guard let c = VatraEnv.activeClient() else { return nil }
    async let s = c.state()
    async let w = c.water()
    let (st, wa) = await (s.value, w.value)
    if st == nil && wa == nil { return nil }
    let g = from(state: st, water: wa, hub: VatraEnv.store.current().active?.name)
    g.save()
    return g
  }
}

struct GlanceDevice: Codable, Sendable, Equatable, Identifiable {
  let id: String
  let name: String
  let room: String
  let entity: String
  let on: Bool

  init(tile: DeviceTile, room: String) {
    id = tile.id; name = tile.name; self.room = room; entity = tile.entity ?? ""; on = tile.on ?? false
  }
}
