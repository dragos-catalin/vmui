import Foundation
import XCTest

@testable import VatraCore

/// Scripted HTTP responses in order, recording every request (the MockWebServer of the Android tests).
final class Stub: URLProtocol, @unchecked Sendable {
  struct Seen { let request: URLRequest; let body: String }
  nonisolated(unsafe) static var queue: [(Int, String)] = []
  nonisolated(unsafe) static var seen: [Seen] = []
  nonisolated(unsafe) static var down = false
  static let lock = NSLock()

  static func reset(_ q: [(Int, String)]) { lock.withLock { queue = q; seen = []; down = false } }

  static var session: URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [Stub.self]
    return URLSession(configuration: c)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var body = ""
    if let s = request.httpBodyStream {
      s.open()
      var d = Data()
      let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
      while s.hasBytesAvailable { let n = s.read(buf, maxLength: 4096); if n <= 0 { break }; d.append(buf, count: n) }
      buf.deallocate()
      s.close()
      body = String(decoding: d, as: UTF8.self)
    } else if let d = request.httpBody {
      body = String(decoding: d, as: UTF8.self)
    }
    let next: (Int, String)? = Stub.lock.withLock {
      Stub.seen.append(Seen(request: request, body: body))
      if Stub.down || Stub.queue.isEmpty { return nil }
      return Stub.queue.removeFirst()
    }
    guard let (code, text) = next else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    let res = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(text.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

final class PairingTests: XCTestCase {
  let url = "http://hub.test:3737"
  let discover = #"{"app":"vmui","product":"vatra","host":"vatra-ab12","version":"1.0.0","apiVersion":1,"minClient":1,"claimed":true,"pair":"/api/devices/pair"}"#
  let me = #"{"apiVersion":1,"minClient":1,"member":{"displayName":"Ana","role":"adult"},"deviceId":"0123456789abcdef","rooms":{},"can":{"openDoor":true,"manageHome":false}}"#

  func pairing(_ lang: String = "en") -> Pairing { Pairing(deviceName: "iPhone", language: lang, session: Stub.session, pollMs: 1) }

  func testLinkParsesTheHubInvite() {
    XCTAssertEqual(
      PairLink.parse("vatra://pair?h=http%3A%2F%2F192.168.1.5%3A3737&c=AbCdEfGhIjKlMnOpQrStUv"),
      PairLink(hub: "http://192.168.1.5:3737", invite: "AbCdEfGhIjKlMnOpQrStUv"))
  }

  func testLinkRejectsAnythingElse() {
    XCTAssertNil(PairLink.parse("https://evil.example/pair?h=x&c=AbCdEfGhIjKlMnOpQrStUv"))
    XCTAssertNil(PairLink.parse("vatra://pair?h=http%3A%2F%2Fhub&c=short"))
    XCTAssertNil(PairLink.parse("vatra://pair?h=file%3A%2F%2F%2Fetc&c=AbCdEfGhIjKlMnOpQrStUv"))
    XCTAssertNil(PairLink.parse("vatra://pair?h=http%3A%2F%2Fu%3Ap%40hub&c=AbCdEfGhIjKlMnOpQrStUv"))
    XCTAssertNil(PairLink.parse("vatra://pair?h=http%3A%2F%2Fhub%2Fapi&c=AbCdEfGhIjKlMnOpQrStUv"))
    XCTAssertNil(PairLink.parse("not a link"))
  }

  func testBareAddressBecomesAnOrigin() {
    XCTAssertEqual(PairLink.normaliseHub("vatra.local"), "http://vatra.local")
    XCTAssertEqual(PairLink.normaliseHub("https://h.example:8443/"), "https://h.example:8443")
    XCTAssertEqual(PairLink.normaliseHub("192.168.1.20:3737"), "http://192.168.1.20:3737")
  }

  func testInviteIsInstantAndSendsTheTokenOnlyInTheHeader() async throws {
    Stub.reset([(200, discover), (200, #"{"id":"0123456789abcdef","token":"vmd_secret","status":"approved"}"#), (200, me), (200, discover)])
    let r = await pairing("ro").withInvite(PairLink(hub: url, invite: "AbCdEfGhIjKlMnOpQrStUv"))
    guard case .paired(let hub) = r else { return XCTFail("\(r)") }
    XCTAssertEqual(hub.memberName, "Ana")
    XCTAssertEqual(hub.name, "vatra-ab12")
    XCTAssertEqual(hub.token, "vmd_secret")
    let pair = Stub.seen[1]
    XCTAssertTrue(pair.body.contains(#""invite":"AbCdEfGhIjKlMnOpQrStUv""#))
    XCTAssertTrue(pair.body.contains(#""platform":"vatra-ios""#))
    XCTAssertNil(pair.request.value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(pair.request.value(forHTTPHeaderField: "Accept-Language"), "ro")
    let meReq = Stub.seen[2]
    XCTAssertEqual(meReq.request.value(forHTTPHeaderField: "Authorization"), "Bearer vmd_secret")
    XCTAssertFalse(meReq.request.url!.absoluteString.contains("vmd_"))
    XCTAssertEqual(meReq.request.value(forHTTPHeaderField: "x-vatra-client"), "2")
  }

  func testApprovalPollsUntilApproved() async {
    Stub.reset([
      (200, discover), (200, #"{"id":"0123456789abcdef","token":"vmd_x","code":"0420","status":"pending"}"#),
      (200, #"{"status":"pending","code":"0420"}"#), (200, #"{"status":"approved","code":null}"#), (200, me), (200, discover),
    ])
    let seen = Box()
    let r = await pairing().withApproval(hub: url) { seen.add($0) }
    guard case .paired = r else { return XCTFail("\(r)") }
    XCTAssertTrue(seen.all.contains(.awaitingApproval(code: "0420")))
  }

  func testRefusalCarriesTheHubCode() async {
    Stub.reset([(200, discover), (401, #"{"ok":false,"code":"invite_invalid","error":"Invitația a expirat"}"#)])
    let r = await pairing("ro").withInvite(PairLink(hub: url, invite: "AbCdEfGhIjKlMnOpQrStUv"))
    XCTAssertEqual(r, .failed(code: "invite_invalid", message: "Invitația a expirat"))
  }

  func testRefusesAHubThatNeedsANewerApp() async {
    Stub.reset([(200, discover.replacingOccurrences(of: #""minClient":1"#, with: #""minClient":9"#))])
    let r = await pairing().withApproval(hub: url)
    XCTAssertEqual(r, .failed(code: "too_old"))
    XCTAssertEqual(Stub.seen.count, 1)
  }

  func testRejectsANonVatraServerBeforeSendingCredentials() async {
    Stub.reset([(200, #"{"app":"other"}"#)])
    let r = await pairing().withLogin(hub: url, email: "a@b.c", password: "pw")
    XCTAssertEqual(r, .failed(code: "not_vatra"))
    XCTAssertEqual(Stub.seen.count, 1)
  }

  func testDeleteAccountPostsThePasswordWithTheDeviceToken() async throws {
    Stub.reset([(200, #"{"ok":true}"#)])
    let c = HubClient(baseUrl: url, token: "vmd_x", language: "ro", session: Stub.session)
    let r = await c.deleteAccount(password: "pw 1")
    XCTAssertEqual(r, .ok(Ok()))
    let req = try XCTUnwrap(Stub.seen.first)
    XCTAssertEqual(req.request.httpMethod, "POST")
    XCTAssertEqual(req.request.url?.path, "/api/v1/app/account/delete")
    XCTAssertEqual(req.request.value(forHTTPHeaderField: "Authorization"), "Bearer vmd_x")
    XCTAssertEqual(req.body, #"{"password":"pw 1"}"#)
  }

  func testDeleteAccountOwnerRefusalCarriesTheHubText() async {
    Stub.reset([(409, #"{"ok":false,"code":"owner_cannot_delete","error":"Proprietarul șterge casa resetând hubul"}"#)])
    let c = HubClient(baseUrl: url, token: "vmd_x", session: Stub.session)
    let r = await c.deleteAccount(password: "pw")
    XCTAssertEqual(r, .refused(status: 409, code: "owner_cannot_delete", message: "Proprietarul șterge casa resetând hubul"))
    Stub.reset([(403, #"{"ok":false,"code":"wrong_password","error":"Wrong password"}"#)])
    let w = await c.deleteAccount(password: "x")
    XCTAssertEqual(w, .refused(status: 403, code: "wrong_password", message: "Wrong password"))
  }

  func testClientMapsOfflineAndTooOld() async {
    Stub.reset([(200, me.replacingOccurrences(of: #""minClient":1"#, with: #""minClient":5"#))])
    let c = HubClient(baseUrl: url, token: "vmd_x", session: Stub.session)
    let r = await c.me()
    XCTAssertEqual(r, .tooOld(minClient: 5))
    Stub.lock.withLock { Stub.down = true }
    guard case .offline = await c.state() else { return XCTFail("expected offline") }
  }

  func testHubListAddsSelectsAndRemoves() {
    let a = PairedHub(id: "a", name: "Home", baseUrl: "http://a", token: "vmd_a", deviceId: "a")
    let b = PairedHub(id: "b", name: "Parents", baseUrl: "http://b", token: "vmd_b", deviceId: "b")
    var l = HubList().add(a).add(b)
    XCTAssertEqual(l.active?.id, "b")
    l = l.select("a")
    XCTAssertEqual(l.active?.id, "a")
    l = l.add(a.with(id: "a2", token: "vmd_new"))
    XCTAssertEqual(l.hubs.count, 2)
    XCTAssertEqual(l.active?.token, "vmd_new")
    l = l.remove("a2")
    XCTAssertEqual(l.active?.id, "b")
    XCTAssertEqual(HubList.decode(l.encode()), l)
    XCTAssertEqual(HubList.decode(Data("garbage".utf8)), HubList())
  }
}

final class Box: @unchecked Sendable {
  private var items: [PairState] = []
  private let lock = NSLock()
  func add(_ s: PairState) { lock.withLock { items.append(s) } }
  var all: [PairState] { lock.withLock { items } }
}
