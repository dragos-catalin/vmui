import Foundation
import XCTest

@testable import VatraCore

/// The hub's own contract fixtures (docs/api/fixtures, validated against the zod schemas by
/// src/lib/api/openapi.test.ts) must decode into the app's models, and the app's requests must encode to
/// exactly the fixture requests. Same files as the Android ContractTest.
final class ContractTests: XCTestCase {
  static var dir: URL {
    if let p = ProcessInfo.processInfo.environment["VATRA_FIXTURES"] { return URL(fileURLWithPath: p) }
    // apps/ios/VatraCore/Tests/VatraCoreTests/<this file> -> repo root
    var u = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { u.deleteLastPathComponent() }
    return u.appendingPathComponent("docs/api/fixtures")
  }

  func fixture(_ id: String) throws -> [String: Any] {
    let d = try Data(contentsOf: Self.dir.appendingPathComponent("\(id).json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: d) as? [String: Any])
  }

  func response<T: Decodable>(_ id: String, _ t: T.Type) throws -> T {
    let r = try XCTUnwrap(try fixture(id)["response"])
    return try Wire.decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: r))
  }

  func assertRequest<T: Encodable>(_ id: String, _ v: T, file: StaticString = #filePath, line: UInt = #line) throws {
    let want = try XCTUnwrap(try fixture(id)["request"]) as AnyObject
    let got = try JSONSerialization.jsonObject(with: Wire.encode(v)) as AnyObject
    XCTAssertTrue(want.isEqual(got), "\(id): \(got) != \(want)", file: file, line: line)
  }

  static let decoders: [String: @Sendable (ContractTests, String) throws -> Void] = [
    "me": { _ = try $0.response($1, Me.self) },
    "state": { _ = try $0.response($1, HomeState.self) },
    "control": { _ = try $0.response($1, Ok.self) },
    "lights": { _ = try $0.response($1, Lights.self) },
    "lightsSet": { _ = try $0.response($1, Applied.self) },
    "notifyList": { _ = try $0.response($1, Cards.self) },
    "notifyAct": { _ = try $0.response($1, Ok.self) },
    "intercom": { _ = try $0.response($1, Intercom.self) },
    "intercomAct": { _ = try $0.response($1, Intercom.self) },
    "water": { _ = try $0.response($1, Water.self) },
    "waterAct": { _ = try $0.response($1, Water.self) },
    "nutritionToday": { _ = try $0.response($1, NutritionToday.self) },
    "push": { _ = try $0.response($1, PushConfig.self) },
    "pushRegister": { _ = try $0.response($1, RelayRegistered.self) },
    "pushCard": { _ = try $0.response($1, PushCard.self) },
    "presence": { _ = try $0.response($1, PresenceResult.self) },
  ]

  func testEveryFixtureHasAModel() throws {
    let ids = try FileManager.default.contentsOfDirectory(atPath: Self.dir.path)
      .filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    XCTAssertEqual(Self.decoders.keys.sorted(), ids)
  }

  func testResponsesDecode() throws {
    for (id, f) in Self.decoders { try f(self, id) }
    let me = try response("me", Me.self)
    XCTAssertEqual(me.member.role, "child")
    XCTAssertFalse(me.can.openDoor)
    let st = try response("state", HomeState.self)
    XCTAssertTrue(try XCTUnwrap(st.rooms.first).canControl)
    XCTAssertEqual(st.states["light.bed_lamp"]?.state, "on")
    XCTAssertEqual(try response("nutritionToday", NutritionToday.self).remaining.calories, 1280)
    XCTAssertTrue(try XCTUnwrap(try response("notifyList", Cards.self).cards.first).unread)
    XCTAssertEqual(try response("push", PushConfig.self).relay, PushRelay(url: "https://push.vatra.dragoscatalin.ro", hub: "mfrggzdfmztwq2lk"))
    XCTAssertEqual(try response("pushRegister", RelayRegistered.self).key?.count, 32)
    XCTAssertEqual(try response("pushCard", PushCard.self).card.actions.map(\.id), ["open"])
  }

  func testRequestsEncodeLikeTheFixtures() throws {
    try assertRequest("control", Control.light(entity: "light.bed_lamp", brightnessPct: 40, kelvin: 2700))
    try assertRequest("lightsSet", LightsOp.set(target: "room:bedroom", state: LightState(on: true, rgb: [255, 140, 60], brightnessPct: 50)))
    try assertRequest("notifyAct", NotifyOp.read(ids: ["c1"]))
    try assertRequest("intercomAct", IntercomAct(action: "arm", minutes: 30))
    try assertRequest("waterAct", WaterAct(op: "drink", ml: 250))
    try assertRequest("presence", PresenceReport(state: "home", source: "geofence"))
    try assertRequest("pushRegister", PushRegistration.relay(platform: "apns", handle: "h1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0", activityHandle: nil))
  }

  func testUnifiedPushRegistrationShape() throws {
    let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(PushRegistration.unifiedPush(endpoint: "https://ntfy.sh/up?up=1", p256dh: "p", auth: "a"))) as? [String: String])
    XCTAssertEqual(o, ["kind": "unifiedpush", "endpoint": "https://ntfy.sh/up?up=1", "p256dh": "p", "auth": "a"])
  }

  func testApnsRegistrationShape() throws {
    let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(PushRegistration.apns(token: "ab12", sandbox: true))) as? [String: Any])
    XCTAssertEqual(o["kind"] as? String, "apns")
    XCTAssertEqual(o["token"] as? String, "ab12")
    XCTAssertEqual(o["sandbox"] as? Bool, true)
    XCTAssertNil(o["activityToken"])
    let w = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(PushRegistration.apns(token: "ab12", sandbox: false, activityToken: "cd"))) as? [String: Any])
    XCTAssertEqual(w["activityToken"] as? String, "cd")
  }

  func testUnknownFieldsAreIgnored() throws {
    let w = try Wire.decoder.decode(Water.self, from: Data(#"{"ml":1,"target":2,"glasses":0,"underPace":false,"lastAt":null,"future":{"x":1}}"#.utf8))
    XCTAssertEqual(w.ml, 1)
    let p = try Wire.decoder.decode(PushConfig.self, from: Data(#"{"fcm":null,"webPush":true,"vapidKey":null}"#.utf8))
    XCTAssertFalse(p.apns)
  }
}
