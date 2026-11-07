import Foundation

/// What a tile shows for one device, derived from the hub state once for phone, watch, widgets and Controls.
public struct DeviceTile: Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let kind: String
  public let room: String
  public let entity: String?
  public let on: Bool?
  public let available: Bool
  public let brightnessPct: Int?
  public let canControl: Bool

  /// A tap toggles only things that have an on/off and that this member controls.
  public var toggleable: Bool { canControl && available && on != nil && entity != nil }
}

public struct RoomView: Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let canControl: Bool
  public let devices: [DeviceTile]
  public var onCount: Int { devices.filter { $0.on == true }.count }
}

public enum HomeView {
  static let toggleDomains: Set<String> = ["light", "switch", "fan", "media_player", "climate", "humidifier", "input_boolean"]

  public static func rooms(_ s: HomeState) -> [RoomView] {
    let byRoom = Dictionary(grouping: s.devices, by: \.room)
    return s.rooms.map { r in
      RoomView(id: r.id, name: r.name, canControl: r.canControl, devices: (byRoom[r.id] ?? []).map { tile($0, s.states, r.canControl) })
    }
  }

  public static func tile(_ d: Device, _ states: [String: EntityState], _ canControl: Bool) -> DeviceTile {
    let st = d.entity.flatMap { states[$0] }
    let domain = d.entity.map { String($0.split(separator: ".", maxSplits: 1).first ?? "") }
    let on: Bool?
    if let st, let domain, toggleDomains.contains(domain) {
      if st.state == "unavailable" || st.state == "unknown" { on = nil }
      else if domain == "climate" { on = st.state != "off" }
      else if domain == "media_player" { on = !["off", "standby"].contains(st.state) }
      else { on = st.state == "on" }
    } else {
      on = nil
    }
    let bri = st?.attributes["brightness"]?.intValue.map { ($0 * 100 + 127) / 255 }
    return DeviceTile(
      id: d.id, name: d.name, kind: d.kind, room: d.room, entity: d.entity, on: on,
      available: st != nil && st?.state != "unavailable", brightnessPct: bri, canControl: canControl)
  }

  /// House-wide summary for the watch complication and the widget: lights on.
  public static func lightsOn(_ s: HomeState) -> Int {
    rooms(s).reduce(0) { $0 + $1.devices.filter { $0.kind == "light" && $0.on == true }.count }
  }
}
