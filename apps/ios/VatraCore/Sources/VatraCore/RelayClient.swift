import Foundation

/// The Vatra Cloud push relay (`vatra-push`): turns a platform token into an opaque handle bound to one hub.
/// No auth; the relay stores nothing (the handle is the encrypted token). Only https relay URLs are used.
public struct RelayClient: Sendable {
  public let baseUrl: String
  let session: URLSession

  public init(baseUrl: String, session: URLSession = HubClient.defaultSession) {
    var b = baseUrl
    while b.hasSuffix("/") { b.removeLast() }
    self.baseUrl = b
    self.session = session
  }

  /// `platform` = apns | apns-sandbox | fcm, `token` = the platform token (APNs hex), `hub` = the hub id.
  public func handle(platform: String, token: String, hub: String) async -> ApiResult<String> {
    guard let url = URL(string: baseUrl + "/v1/handles"), url.scheme == "https" else { return .offline("bad url") }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Wire.encode(RelayHandleRequest(platform: platform, token: token, hub: hub))
    do {
      let (data, res) = try await session.data(for: req)
      let r: ApiResult<RelayHandle> = HubClient.decode(status: (res as? HTTPURLResponse)?.statusCode ?? 0, data: data)
      if case .ok(let h) = r, h.handle.isEmpty { return .offline("decode") }
      return r.map(\.handle)
    } catch {
      return .offline(String(describing: type(of: error)))
    }
  }
}
