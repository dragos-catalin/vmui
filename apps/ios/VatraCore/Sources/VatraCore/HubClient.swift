import Foundation

/// Every outcome a screen has to handle, with the hub's own localised text on refusal.
public enum ApiResult<T: Sendable>: Sendable {
  case ok(T)
  /// The hub answered and refused: `code` is stable (no_room_access, forbidden, …), `message` is localised.
  case refused(status: Int, code: String, message: String)
  /// Unreachable, timed out, or an unparseable body.
  case offline(String)
  /// The hub needs a newer app (minClient above ours).
  case tooOld(minClient: Int)

  public var value: T? { if case .ok(let v) = self { return v }; return nil }

  public func map<R>(_ f: (T) -> R) -> ApiResult<R> {
    switch self {
    case .ok(let v): return .ok(f(v))
    case .refused(let s, let c, let m): return .refused(status: s, code: c, message: m)
    case .offline(let r): return .offline(r)
    case .tooOld(let m): return .tooOld(minClient: m)
    }
  }
}

extension ApiResult: Equatable where T: Equatable {}

public enum Wire {
  public static let decoder = JSONDecoder()
  public static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  public static func encode<T: Encodable>(_ v: T) -> Data { (try? encoder.encode(v)) ?? Data("{}".utf8) }
}

/// The hub's app contract over HTTP. One instance per paired hub: `baseUrl` is that hub's address and
/// `token` the `vmd_` device token it issued at pairing (Authorization header only, never a query).
public struct HubClient: Sendable {
  /// The app-contract version this build speaks (src/lib/api-version.ts API_VERSION).
  public static let clientApi = 2

  public static let defaultSession: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 15
    c.timeoutIntervalForResource = 20
    c.waitsForConnectivity = false
    c.httpCookieStorage = nil
    c.urlCache = nil
    return URLSession(configuration: c)
  }()

  public let baseUrl: String
  let token: String?
  let language: String
  let session: URLSession

  public init(baseUrl: String, token: String?, language: String = "en", session: URLSession = HubClient.defaultSession) {
    var b = baseUrl
    while b.hasSuffix("/") { b.removeLast() }
    self.baseUrl = b
    self.token = token
    self.language = language
    self.session = session
  }

  public func discover() async -> ApiResult<Discover> { await send("GET", "/api/discover", nil, auth: false) }

  public func me() async -> ApiResult<Me> {
    let r: ApiResult<Me> = await send("GET", "/api/v1/app/me", nil)
    if case .ok(let m) = r, m.minClient > Self.clientApi { return .tooOld(minClient: m.minClient) }
    return r
  }

  public func state() async -> ApiResult<HomeState> { await send("GET", "/api/v1/app/state", nil) }
  public func control(_ c: Control) async -> ApiResult<Ok> { await send("POST", "/api/v1/app/control", Wire.encode(c)) }
  public func lights() async -> ApiResult<Lights> { await send("GET", "/api/v1/app/lights", nil) }
  public func lights(_ op: LightsOp) async -> ApiResult<Applied> { await send("POST", "/api/v1/app/lights", Wire.encode(op)) }
  public func cards(all: Bool = false) async -> ApiResult<Cards> {
    await send("GET", "/api/v1/app/notify?all=\(all ? 1 : 0)&lang=\(language)", nil)
  }
  public func notify(_ op: NotifyOp) async -> ApiResult<Ok> { await send("POST", "/api/v1/app/notify", Wire.encode(op)) }

  /// A button on a notification (Open door, Approve pairing, …): routed by the hub per card kind and member.
  public func act(cardId: String, action: String) async -> ApiResult<Ok> {
    await send("POST", "/api/notify/act", Wire.encode(CardAct(id: cardId, action: action)))
  }

  public func intercom() async -> ApiResult<Intercom> { await send("GET", "/api/v1/app/intercom", nil) }
  public func intercom(_ a: IntercomAct) async -> ApiResult<Intercom> { await send("POST", "/api/v1/app/intercom", Wire.encode(a)) }
  public func water() async -> ApiResult<Water> { await send("GET", "/api/v1/app/nutrition/water", nil) }
  public func water(_ a: WaterAct) async -> ApiResult<Water> { await send("POST", "/api/v1/app/nutrition/water", Wire.encode(a)) }
  public func nutrition() async -> ApiResult<NutritionToday> { await send("GET", "/api/v1/app/nutrition/today", nil) }
  public func pushConfig() async -> ApiResult<PushConfig> { await send("GET", "/api/v1/app/push", nil) }
  public func presence(state: String, source: String) async -> ApiResult<PresenceResult> {
    await send("POST", "/api/v1/app/presence", Wire.encode(PresenceReport(state: state, source: source)))
  }
  public func registerPush(_ r: PushRegistration) async -> ApiResult<Ok> { await send("PUT", "/api/v1/app/push", Wire.encode(r)) }

  /// PUT kind relay with the handles from RelayClient; the answer carries the new end-to-end key (rotated each time).
  public func registerRelay(platform: String, handle: String, activityHandle: String?) async -> ApiResult<RelayRegistered> {
    await send("PUT", "/api/v1/app/push", Wire.encode(PushRegistration.relay(platform: platform, handle: handle, activityHandle: activityHandle)))
  }

  /// The full card behind a trimmed relay push (`full:"0"`), with the same visibility as the notify list.
  public func pushCard(id: String) async -> ApiResult<Card> {
    let q = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? ""
    let r: ApiResult<PushCard> = await send("GET", "/api/v1/app/push/card?id=\(q)&lang=\(language)", nil)
    return r.map(\.card)
  }

  /// Deletes the paired member's account on this hub. Refusals: owner_cannot_delete 409, wrong_password 403,
  /// not_bound 403, rate_limited 429, demo_readonly 403 (message localised by the hub).
  public func deleteAccount(password: String) async -> ApiResult<Ok> {
    await send("POST", "/api/v1/app/account/delete", Wire.encode(AccountDelete(password: password)))
  }

  public func pair(_ req: PairRequest) async -> ApiResult<PairResponse> {
    await send("POST", "/api/devices/pair", Wire.encode(req), auth: false)
  }

  public func pairStatus(id: String) async -> ApiResult<PairStatus> {
    let q = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    return await send("GET", "/api/devices/pair?id=\(q)", nil, auth: false)
  }

  /// Mints an invite bound to this device's member, for the watch or another phone.
  public func invite() async -> ApiResult<Invite> { await send("POST", "/api/devices/pair/invite", Data("{}".utf8)) }

  func send<T: Decodable & Sendable>(_ method: String, _ path: String, _ body: Data?, auth: Bool = true) async -> ApiResult<T> {
    guard let url = URL(string: baseUrl + path) else { return .offline("bad url") }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue(language, forHTTPHeaderField: "Accept-Language")
    req.setValue(String(Self.clientApi), forHTTPHeaderField: "x-vatra-client")
    if auth, let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    do {
      let (data, res) = try await session.data(for: req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      return Self.decode(status: code, data: data)
    } catch {
      return .offline(String(describing: type(of: error)))
    }
  }

  public static func decode<T: Decodable & Sendable>(status: Int, data: Data) -> ApiResult<T> {
    if (200..<300).contains(status) {
      do { return .ok(try Wire.decoder.decode(T.self, from: data)) } catch { return .offline("decode") }
    }
    let err = try? Wire.decoder.decode(ApiErrorBody.self, from: data)
    let c = (err?.code).flatMap { $0.isEmpty ? nil : $0 } ?? "http_\(status)"
    return .refused(status: status, code: c, message: err?.error ?? "")
  }
}
