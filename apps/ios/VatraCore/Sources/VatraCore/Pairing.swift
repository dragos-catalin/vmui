import Foundation

/// `vatra://pair?h=<hub url>&c=<one-time invite>` as shown by POST /api/devices/pair/invite.
public struct PairLink: Sendable, Equatable {
  public let hub: String
  public let invite: String

  public init(hub: String, invite: String) { self.hub = hub; self.invite = invite }

  static func query(_ comps: URLComponents) -> [String: String] {
    var q: [String: String] = [:]
    for item in comps.queryItems ?? [] where !item.name.isEmpty { q[item.name] = item.value ?? "" }
    return q
  }

  /// Nil for anything that is not a well-formed Vatra invite (a stray QR, a URL with a script, …).
  public static func parse(_ raw: String) -> PairLink? {
    guard let c = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
      c.scheme?.lowercased() == "vatra", c.host?.lowercased() == "pair" else { return nil }
    let q = query(c)
    guard let h = q["h"], let hub = normaliseHub(h) else { return nil }
    guard let code = q["c"], code.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil else { return nil }
    return PairLink(hub: hub, invite: code)
  }

  /// Only http(s) origins: no path, no credentials, no query (a QR must not point the token elsewhere).
  public static func normaliseHub(_ raw: String) -> String? {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return nil }
    let withScheme = t.contains("://") ? t : "http://\(t)"
    guard let u = URLComponents(string: withScheme), let scheme = u.scheme?.lowercased(),
      scheme == "http" || scheme == "https", let host = u.host, !host.isEmpty else { return nil }
    if u.user != nil || u.password != nil { return nil }
    if let q = u.percentEncodedQuery, !q.isEmpty { return nil }
    if let f = u.percentEncodedFragment, !f.isEmpty { return nil }
    if !(u.percentEncodedPath.isEmpty || u.percentEncodedPath == "/") { return nil }
    let h = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    return "\(scheme)://\(h)\(u.port.map { ":\($0)" } ?? "")"
  }
}

/// Where a pairing attempt is; the UI renders one screen per state.
public enum PairState: Sendable, Equatable {
  case working
  /// Waiting for someone signed in to approve; they compare this code with the one on the phone.
  case awaitingApproval(code: String)
  case paired(PairedHub)
  /// `code` is the hub's stable error code (invite_invalid, bad_credentials, rate_limited, …) or
  /// offline / rejected / expired / too_old / not_vatra / bad_address.
  case failed(code: String, message: String = "")
}

/// The three ways a device joins a hub (src/app/api/devices/pair/route.ts): a QR invite (instant, bound to
/// the member who showed it), the account e-mail + password (instant), or a request approved by comparing
/// a 4-digit code.
public struct Pairing: Sendable {
  /// Distinct from the Android app (vatra-android) and the desktop app; the watch pairs as vatra-watchos.
  public static let platformIOS = "vatra-ios"
  public static let platformWatch = "vatra-watchos"

  let deviceName: String
  let language: String
  let platform: String
  let client: @Sendable (String, String?) -> HubClient
  let pollNanos: UInt64
  let timeout: TimeInterval
  let now: @Sendable () -> Date

  public init(
    deviceName: String, language: String, platform: String = Pairing.platformIOS,
    session: URLSession = HubClient.defaultSession, pollMs: UInt64 = 2_000, timeout: TimeInterval = 600,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.deviceName = deviceName
    self.language = language
    self.platform = platform
    self.client = { url, token in HubClient(baseUrl: url, token: token, language: language, session: session) }
    self.pollNanos = pollMs * 1_000_000
    self.timeout = timeout
    self.now = now
  }

  public func withInvite(_ link: PairLink, onState: @Sendable (PairState) -> Void = { _ in }) async -> PairState {
    await run(link.hub, PairRequest(name: deviceName, platform: platform, invite: link.invite), onState)
  }

  public func withLogin(hub: String, email: String, password: String, onState: @Sendable (PairState) -> Void = { _ in }) async -> PairState {
    await run(hub, PairRequest(name: deviceName, platform: platform, email: email, password: password), onState)
  }

  public func withApproval(hub: String, onState: @Sendable (PairState) -> Void = { _ in }) async -> PairState {
    await run(hub, PairRequest(name: deviceName, platform: platform), onState)
  }

  private func run(_ rawHub: String, _ req: PairRequest, _ onState: @Sendable (PairState) -> Void) async -> PairState {
    func done(_ s: PairState) -> PairState { onState(s); return s }
    guard let hub = PairLink.normaliseHub(rawHub) else { return done(.failed(code: "bad_address")) }
    onState(.working)
    let anon = client(hub, nil)
    // Talk only to a Vatra hub this build understands, before sending any secret.
    switch await anon.discover() {
    case .ok(let d):
      if d.product != "vatra" && d.app != "vmui" { return done(.failed(code: "not_vatra")) }
      if d.minClient > HubClient.clientApi { return done(.failed(code: "too_old")) }
    case .refused: return done(.failed(code: "not_vatra"))
    default: return done(.failed(code: "offline"))
    }
    let start: PairResponse
    switch await anon.pair(req) {
    case .ok(let r): start = r
    case .refused(_, let c, let m): return done(.failed(code: c, message: m))
    case .tooOld: return done(.failed(code: "too_old"))
    case .offline: return done(.failed(code: "offline"))
    }
    if start.status != "approved" {
      onState(.awaitingApproval(code: start.code ?? ""))
      let deadline = now().addingTimeInterval(timeout)
      while true {
        if now() > deadline { return done(.failed(code: "expired")) }
        try? await Task.sleep(nanoseconds: pollNanos)
        if Task.isCancelled { return done(.failed(code: "expired")) }
        guard let s = await anon.pairStatus(id: start.id).value else { continue }
        if s.status == "approved" { break }
        if s.status == "rejected" || s.status == "revoked" { return done(.failed(code: "rejected")) }
      }
    }
    let member = await client(hub, start.token).me().value?.member.displayName ?? ""
    let host = await anon.discover().value?.host ?? ""
    let name = host.isEmpty ? (hub.components(separatedBy: "://").last ?? hub) : host
    let paired = PairedHub(
      id: start.id, name: name, baseUrl: hub, token: start.token, deviceId: start.id, memberName: member,
      addedAt: Int64(now().timeIntervalSince1970 * 1000))
    return done(.paired(paired))
  }
}
