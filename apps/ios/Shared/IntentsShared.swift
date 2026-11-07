import AppIntents
import Foundation
import VatraCore
import WidgetKit

// App Intents used by Siri / Shortcuts / Spotlight (app target), Control Center controls and interactive
// widgets (widget extension). They act as this device on the active hub, with this member's room permissions.

enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
  case notPaired
  case refused(String)
  case offline

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .notPaired: return "intent.not_paired"
    case .refused(let m): return "\(m)"
    case .offline: return "intent.offline"
    }
  }
}

func runQuick(_ a: QuickAction) async throws {
  guard let c = VatraEnv.activeClient() else { throw IntentFailure.notPaired }
  switch await a.run(c) {
  case .ok: break
  case .refused(_, let code, let m): throw IntentFailure.refused(m.isEmpty ? code : m)
  case .offline: throw IntentFailure.offline
  case .tooOld: throw IntentFailure.refused(L("update_app"))
  }
  _ = await Glance.refresh()
  WidgetCenter.shared.reloadAllTimelines()
}

/// A device this member can switch, from the last refresh (so the picker works offline).
struct DeviceEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "entity.device"
  static let defaultQuery = DeviceQuery()
  let id: String
  let name: String
  let room: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(room)") }
}

struct DeviceQuery: EntityQuery, EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [DeviceEntity] {
    all().filter { identifiers.contains($0.id) }
  }
  func suggestedEntities() async throws -> [DeviceEntity] {
    if Glance.load().devices.isEmpty { _ = await Glance.refresh() }
    return all()
  }
  func entities(matching string: String) async throws -> [DeviceEntity] {
    all().filter { $0.name.localizedCaseInsensitiveContains(string) || $0.room.localizedCaseInsensitiveContains(string) }
  }
  private func all() -> [DeviceEntity] {
    Glance.load().devices.map { DeviceEntity(id: $0.entity, name: $0.name, room: $0.room) }
  }
}

/// Switch one device on or off (also the action of the Control Center toggle).
struct SetDeviceIntent: SetValueIntent {
  static let title: LocalizedStringResource = "intent.toggle.title"
  static let description = IntentDescription("intent.toggle.description")

  @Parameter(title: "entity.device") var device: DeviceEntity?
  @Parameter(title: "intent.toggle.on") var value: Bool

  init() {}
  init(device: DeviceEntity) { self.device = device }

  func perform() async throws -> some IntentResult {
    guard let device else { throw IntentFailure.notPaired }
    try await runQuick(.toggle(entity: device.id, on: value))
    return .result()
  }
}

enum HouseAction: String, AppEnum {
  case movie, music, lightsOff, pcWake, water, doorIgnore

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "entity.house_action"
  static let caseDisplayRepresentations: [HouseAction: DisplayRepresentation] = [
    .movie: "ambilight_movie", .music: "ambilight_music", .lightsOff: "ambilight_off", .pcWake: "pc_wake",
    .water: "water_drink", .doorIgnore: "door_ignore",
  ]

  var quick: QuickAction {
    switch self {
    case .movie: return .ambilight("movie")
    case .music: return .ambilight("music")
    case .lightsOff: return .ambilight("off")
    case .pcWake: return .script("pc_wake")
    case .water: return .water
    case .doorIgnore: return .doorIgnore
    }
  }
}

/// One of the house actions every member may run (same allow-list as NFC tags and the hub's schemas).
struct HouseActionIntent: AppIntent {
  static let title: LocalizedStringResource = "intent.action.title"
  static let description = IntentDescription("intent.action.description")

  @Parameter(title: "entity.house_action") var action: HouseAction

  init() {}
  init(_ a: HouseAction) { action = a }

  func perform() async throws -> some IntentResult {
    try await runQuick(action.quick)
    return .result()
  }
}

/// Apply one of the hub's light scenes by id (the picker lists the scenes this member may run).
struct SceneEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "entity.scene"
  static let defaultQuery = SceneQuery()
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct SceneQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [SceneEntity] {
    try await suggestedEntities().filter { identifiers.contains($0.id) }
  }
  func suggestedEntities() async throws -> [SceneEntity] {
    guard let c = VatraEnv.activeClient() else { return [] }
    return (await c.lights().value?.scenes ?? []).map { SceneEntity(id: $0.id, name: $0.name) }
  }
}

struct SceneIntent: AppIntent {
  static let title: LocalizedStringResource = "intent.scene.title"
  static let description = IntentDescription("intent.scene.description")

  @Parameter(title: "entity.scene") var scene: SceneEntity

  init() {}

  func perform() async throws -> some IntentResult {
    try await runQuick(.scene(scene.id))
    return .result()
  }
}

/// Opens the app on the intercom (from the Live Activity / door control).
struct OpenDoorIntent: AppIntent {
  static let title: LocalizedStringResource = "intent.door.title"
  static let description = IntentDescription("intent.door.description")
  static let openAppWhenRun = false

  @Parameter(title: "intent.door.card") var cardId: String

  init() {}
  init(cardId: String) { self.cardId = cardId }

  func perform() async throws -> some IntentResult {
    guard let c = VatraEnv.activeClient() else { throw IntentFailure.notPaired }
    switch await c.act(cardId: cardId, action: "open") {
    case .ok: return .result()
    case .refused(_, let code, let m): throw IntentFailure.refused(m.isEmpty ? code : m)
    default: throw IntentFailure.offline
    }
  }
}
