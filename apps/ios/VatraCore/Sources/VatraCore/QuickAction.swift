import Foundation

/// One tap-able house action shared by NFC tags, Control Center, widgets, Siri / Shortcuts and the watch.
/// Encoded as `vatra://do?a=<kind>&…` (same as the Android app) so a tag carries nothing secret: whoever taps
/// it still acts through their own paired device and room permissions.
public enum QuickAction: Sendable, Equatable, Hashable {
  case scene(String)
  case toggle(entity: String, on: Bool)
  case script(String)
  case ambilight(String)
  case water
  case doorIgnore

  /// Same allow-lists as the hub's zod schemas: a tag can never smuggle in anything else.
  public static let scripts: Set<String> = ["pc_wake", "movie_mode_on", "movie_mode_off", "music_mode"]
  public static let modes: Set<String> = ["movie", "music", "off"]

  private static func enc(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._*")
    return (s.addingPercentEncoding(withAllowedCharacters: allowed) ?? "").replacingOccurrences(of: "%20", with: "+")
  }

  public var uri: String {
    switch self {
    case .scene(let id): return "vatra://do?a=scene&id=\(Self.enc(id))"
    case .toggle(let e, let on): return "vatra://do?a=toggle&e=\(Self.enc(e))&on=\(on ? 1 : 0)"
    case .script(let n): return "vatra://do?a=script&n=\(Self.enc(n))"
    case .ambilight(let m): return "vatra://do?a=ambilight&m=\(Self.enc(m))"
    case .water: return "vatra://do?a=water"
    case .doorIgnore: return "vatra://do?a=door-ignore"
    }
  }

  public static func parse(_ raw: String) -> QuickAction? {
    // `+` means space in the Android encoder's form-encoding; URLComponents does not decode it.
    guard let c = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
      c.scheme?.lowercased() == "vatra", c.host?.lowercased() == "do" else { return nil }
    var q: [String: String] = [:]
    for part in (c.percentEncodedQuery ?? "").split(separator: "&") {
      guard let i = part.firstIndex(of: "="), i != part.startIndex else { continue }
      let v = String(part[part.index(after: i)...]).replacingOccurrences(of: "+", with: " ")
      q[String(part[..<i])] = v.removingPercentEncoding ?? v
    }
    switch q["a"] {
    case "scene":
      guard let id = q["id"], !id.trimmingCharacters(in: .whitespaces).isEmpty, id.count <= 120 else { return nil }
      return .scene(id)
    case "toggle":
      guard let e = q["e"], e.range(of: "^[a-z_]+\\.[a-z0-9_]+$", options: .regularExpression) != nil else { return nil }
      return .toggle(entity: e, on: q["on"] == "1")
    case "script":
      guard let n = q["n"], scripts.contains(n) else { return nil }
      return .script(n)
    case "ambilight":
      guard let m = q["m"], modes.contains(m) else { return nil }
      return .ambilight(m)
    case "water": return .water
    case "door-ignore": return .doorIgnore
    default: return nil
    }
  }

  public func run(_ c: HubClient) async -> ApiResult<Bool> {
    switch self {
    case .scene(let id): return await c.lights(.scene(id: id)).map { $0.ok }
    case .toggle(let e, let on): return await c.control(.toggle(entity: e, on: on)).map { $0.ok }
    case .script(let n): return await c.control(.script(name: n)).map { $0.ok }
    case .ambilight(let m): return await c.control(.ambilight(mode: m)).map { $0.ok }
    case .water: return await c.water(WaterAct()).map { _ in true }
    case .doorIgnore: return await c.intercom(IntercomAct(action: "ignore")).map { _ in true }
    }
  }
}
