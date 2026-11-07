import Foundation
import XCTest

@testable import VatraCore

/// Vatra Cloud push relay + end-to-end encryption (docs/product/cloud/CONTRACT.md). Vectors from
/// .copilot-tmp/product/ios-push-vector.mjs (node:crypto aes-256-gcm, key 32×0x11, nonce 12×0x22).
final class PushRelayTests: XCTestCase {
  let key = Data(repeating: 0x11, count: 32)
  let e = "IiIiIiIiIiIiIiIibNVzMLCqvWXHXL9OLITF93b379hI4s05NmI72jrDSSEuFsVmcZLbtyAsiF-FNyQXn_DqA_JQQNzQG4WLwEfNxhH4cF1zv3NBng_yEjeFnyyQdTr6gMz3cTtutdMcmCOX4S82aBh37m4w_c1-Gi_tRBF8yItyXLJf91ITQnTNLvpmtMKc9m1HAT56IPaceVl5Ojcvy7ibXmxit19jST4WfWkZNHUxxkKvzwYaIWqVvVWXMuHNcKQXYssE2tysTOELi_WrrjpDfjO6kw1LH4awINhRTGEmloIK2SRdwXSvZlkQAI_M6DcN7A6_6EY5RRtCXxBwUnV6LC16LTSbzfB-kby8Sp3Bich9XcNxf52SqDxPet1TENqPa0gem8s6cRA3F01vOtJfORmICJcjnwE9To56tgG-qzM8sQ0GamD33seQ3R2Yl8S2cev4QxC7v14IijsWfz6bFLlO2ue1Y5XF7JoKh_b8S7FzChYOTuf641bZKlLClyNGAfc4M3X2bZrj8VFDTQ"
  let plain = ##"{"type":"card","id":"card-123","kind":"intercom","tag":"door","title":"Sună la ușă","body":"Cineva e la intrare","subtitle":"","color":"#e67e22","icon":"","priority":"high","progress":"","actions":"[{\"id\":\"open\",\"label\":\"Deschide\",\"style\":\"primary\"},{\"id\":\"ignore\",\"label\":\"Ignoră\",\"style\":\"ghost\"}]","url":"","sticky":"0","at":"1762500000000"}"##
  let eMinimal = "IiIiIiIiIiIiIiIibNVzMLCqvWXHXL9OLITF93b379hI4s05NmIzyiXDDmorG4k4cd-YqisqzwHELChSkei8FfQGH4yWWMiNix-D11q2Pno05HFzm6W1szvLjn6M0tFXd5f5aXtltMxf122gqm1xfw11sWxtq9slQWuvFVMp2pdgDesf5V4TTXnNLvp1up1rBnX7hnipcoZ2DPNKlGcw"
  let eActivity = "IiIiIiIiIiIiIiIibNVkKK6A7zqLHeRIOtOM-T33oo0Yo5ZpGyF-mmiTACE4MrpV-aRfDW0Oj55K6nZtGg"

  func relayInfo(id: String, e: String, full: String = "1") -> [AnyHashable: Any] {
    [
      "aps": ["alert": ["title-loc-key": "VATRA_PUSH_TITLE_INTERCOM", "loc-key": "VATRA_PUSH_BODY"], "mutable-content": 1, "category": "vatra.intercom"],
      "vatra": ["v": "1", "id": id, "e": e, "full": full, "type": "card"],
    ]
  }

  // MARK: crypto

  func testOpensTheNodeVector() throws {
    let out = try XCTUnwrap(PushCrypto.open(key: key, cardId: "card-123", e: e))
    XCTAssertEqual(String(decoding: out, as: UTF8.self), plain)
  }

  func testWrongAadFails() {
    XCTAssertNil(PushCrypto.open(key: key, cardId: "card-124", e: e))
    XCTAssertNil(PushCrypto.open(key: key, cardId: "", e: e))
  }

  func testTamperedTagFails() {
    var chars = Array(e)
    chars[chars.count - 2] = chars[chars.count - 2] == "A" ? "B" : "A"
    XCTAssertNil(PushCrypto.open(key: key, cardId: "card-123", e: String(chars)))
  }

  func testTamperedCiphertextFails() {
    var chars = Array(e)
    chars[30] = chars[30] == "A" ? "B" : "A"
    XCTAssertNil(PushCrypto.open(key: key, cardId: "card-123", e: String(chars)))
  }

  func testWrongKeyAndGarbageFail() {
    XCTAssertNil(PushCrypto.open(key: Data(repeating: 0x12, count: 32), cardId: "card-123", e: e))
    XCTAssertNil(PushCrypto.open(key: Data(repeating: 0x11, count: 16), cardId: "card-123", e: e))
    XCTAssertNil(PushCrypto.open(key: key, cardId: "card-123", e: "short"))
    XCTAssertNil(PushCrypto.open(key: key, cardId: "card-123", e: "!!not base64!!"))
  }

  func testActivitySecret() {
    XCTAssertEqual(ActivitySecret.open(key: key, cardId: "card-123", e: eActivity), ActivitySecret(canOpen: true, door: "Intrare"))
    XCTAssertNil(ActivitySecret.open(key: key, cardId: "other", e: eActivity))
  }

  // MARK: payload

  func testFromRelayFullCard() throws {
    let p = try XCTUnwrap(PushPayload.fromRelay(relayInfo(id: "card-123", e: e), key: key))
    XCTAssertEqual(p.id, "card-123")
    XCTAssertEqual(p.kind, "intercom")
    XCTAssertEqual(p.title, "Sună la ușă")
    XCTAssertEqual(p.body, "Cineva e la intrare")
    XCTAssertEqual(p.priority, "high")
    XCTAssertEqual(p.actions.map(\.id), ["open", "ignore"])
    XCTAssertEqual(p.at, 1_762_500_000_000)
    XCTAssertFalse(p.needsFetch)
    XCTAssertTrue(p.isIntercomRing)
    XCTAssertEqual(p.threadKey, "door")
  }

  func testFromRelayMinimalNeedsFetch() throws {
    let p = try XCTUnwrap(PushPayload.fromRelay(relayInfo(id: "card-9", e: eMinimal, full: "0"), key: key))
    XCTAssertEqual(p.kind, "water")
    XCTAssertEqual(p.title, "Bea apă")
    XCTAssertTrue(p.needsFetch)
    XCTAssertTrue(p.actions.isEmpty)
  }

  func testFullZeroAloneImpliesFetch() throws {
    XCTAssertTrue(try XCTUnwrap(PushPayload.fromRelay(relayInfo(id: "card-123", e: e, full: "0"), key: key)).needsFetch)
  }

  func testFromRelayRejectsOtherCardOrKeyOrDirect() {
    // envelope id is the aad: a swapped id fails authentication
    XCTAssertNil(PushPayload.fromRelay(relayInfo(id: "card-9", e: e), key: key))
    XCTAssertNil(PushPayload.fromRelay(relayInfo(id: "card-123", e: e), key: Data(repeating: 0, count: 32)))
    XCTAssertNil(PushPayload.fromRelay(["vatra": ["id": "c1", "kind": "water", "title": "t"]], key: key))
    XCTAssertNil(PushPayload.relayEnvelope(["vatra": ["id": "c1", "title": "t"]]))
    XCTAssertEqual(PushPayload.relayEnvelope(relayInfo(id: "x", e: "y", full: "0")), PushPayload.RelayEnvelope(id: "x", e: "y", full: false, type: "card"))
  }

  // MARK: wire

  func testPushConfigRelayIsTolerant() throws {
    func cfg(_ s: String) throws -> PushConfig { try Wire.decoder.decode(PushConfig.self, from: Data(s.utf8)) }
    XCTAssertEqual(try cfg(#"{"apns":true,"relay":{"url":"https://push.vatra.ro","hub":"hb_1"}}"#).relay, PushRelay(url: "https://push.vatra.ro", hub: "hb_1"))
    XCTAssertNil(try cfg(#"{"apns":true,"relay":null}"#).relay)
    XCTAssertNil(try cfg(#"{"apns":true}"#).relay)
    XCTAssertNil(try cfg(#"{"apns":true,"relay":"weird"}"#).relay)
    XCTAssertNil(try cfg(#"{"relay":{"url":""}}"#).relay)
    XCTAssertTrue(try cfg(#"{"apns":true,"relay":"weird"}"#).apns)
  }

  func testRelayRegistrationEncodes() throws {
    let a = try JSONSerialization.jsonObject(with: Wire.encode(PushRegistration.relay(platform: "apns-sandbox", handle: "h1.a", activityHandle: "h1.b"))) as? [String: Any]
    XCTAssertEqual(a?["kind"] as? String, "relay")
    XCTAssertEqual(a?["platform"] as? String, "apns-sandbox")
    XCTAssertEqual(a?["handle"] as? String, "h1.a")
    XCTAssertEqual(a?["activityHandle"] as? String, "h1.b")
    let b = String(decoding: Wire.encode(PushRegistration.relay(platform: "apns", handle: "h1.a", activityHandle: nil)), as: UTF8.self)
    XCTAssertTrue(b.contains(#""activityHandle":null"#), b)
  }

  func testRegisterRelayReturnsTheKey() async throws {
    let k = Data(repeating: 0x11, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    Stub.reset([(200, #"{"ok":true,"e2eKey":"\#(k)","extra":1}"#)])
    let c = HubClient(baseUrl: "http://hub.test:3737", token: "vmd_t", session: Stub.session)
    let r = await c.registerRelay(platform: "apns", handle: "h1.x", activityHandle: nil)
    XCTAssertEqual(r.value?.key, key)
    let seen = try XCTUnwrap(Stub.seen.first)
    XCTAssertEqual(seen.request.httpMethod, "PUT")
    XCTAssertEqual(seen.request.url?.path, "/api/v1/app/push")
    XCTAssertEqual(seen.request.value(forHTTPHeaderField: "Authorization"), "Bearer vmd_t")
    let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(seen.body.utf8)) as? [String: Any])
    XCTAssertEqual(body["kind"] as? String, "relay")
    XCTAssertEqual(body["handle"] as? String, "h1.x")
  }

  func testBadKeyLengthIsNoKey() throws {
    let r = try Wire.decoder.decode(RelayRegistered.self, from: Data(#"{"ok":true,"e2eKey":"AAAA"}"#.utf8))
    XCTAssertNil(r.key)
  }

  func testPushCardRequestAndBothShapes() async throws {
    let card = #"{"id":"card-9","kind":"water","title":"Bea apă","body":"Mai ai 750 ml","priority":"default","actions":[{"id":"drink","label":"+250 ml","style":"primary"}]}"#
    Stub.reset([(200, card), (200, #"{"card":\#(card)}"#), (404, #"{"ok":false,"code":"not_found","error":"Nu există"}"#)])
    let c = HubClient(baseUrl: "http://hub.test:3737", token: "vmd_t", language: "ro", session: Stub.session)
    let a = await c.pushCard(id: "card-9")
    XCTAssertEqual(a.value?.body, "Mai ai 750 ml")
    XCTAssertEqual(a.value?.actions.map(\.id), ["drink"])
    let b = await c.pushCard(id: "card-9")
    XCTAssertEqual(b.value?.id, "card-9")
    let missing = await c.pushCard(id: "card 9/x")
    guard case .refused(404, "not_found", _) = missing else { return XCTFail("expected refusal, got \(missing)") }
    let req = Stub.seen[0].request
    XCTAssertEqual(req.httpMethod, "GET")
    XCTAssertEqual(req.url?.path, "/api/v1/app/push/card")
    XCTAssertEqual(URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value, "card-9")
    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer vmd_t")
    XCTAssertEqual(URLComponents(url: Stub.seen[2].request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value, "card 9/x")
  }

  func testRelayHandleRequestShape() async throws {
    Stub.reset([(200, #"{"handle":"h1.abc"}"#), (429, #"{"error":"rate_limited","retryAfter":60}"#)])
    let rc = RelayClient(baseUrl: "https://push.vatra.ro/", session: Stub.session)
    let h = await rc.handle(platform: "apns", token: "ab".repeated(32), hub: "hb_1")
    XCTAssertEqual(h.value, "h1.abc")
    let seen = try XCTUnwrap(Stub.seen.first)
    XCTAssertEqual(seen.request.httpMethod, "POST")
    XCTAssertEqual(seen.request.url?.absoluteString, "https://push.vatra.ro/v1/handles")
    XCTAssertNil(seen.request.value(forHTTPHeaderField: "Authorization"))
    let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(seen.body.utf8)) as? [String: String])
    XCTAssertEqual(body, ["platform": "apns", "token": "ab".repeated(32), "hub": "hb_1"])
    let limited = await rc.handle(platform: "apns", token: "x", hub: "hb_1")
    guard case .refused(429, _, _) = limited else { return XCTFail("expected 429, got \(limited)") }
  }

  func testRelayRefusesPlainHttp() async {
    Stub.reset([(200, #"{"handle":"h1.abc"}"#)])
    let r = await RelayClient(baseUrl: "http://push.vatra.ro", session: Stub.session).handle(platform: "apns", token: "t", hub: "h")
    XCTAssertNil(r.value)
    XCTAssertTrue(Stub.seen.isEmpty)
  }
}

private extension String {
  func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
