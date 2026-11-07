import Foundation
import XCTest

@testable import VatraCore

final class ActionsTests: XCTestCase {
  func testQuickActionsRoundTrip() {
    let all: [QuickAction] = [
      .scene("evening & calm"), .toggle(entity: "light.bed_lamp", on: true), .toggle(entity: "switch.kettle", on: false),
      .script("pc_wake"), .ambilight("movie"), .water, .doorIgnore,
    ]
    for a in all { XCTAssertEqual(QuickAction.parse(a.uri), a, a.uri) }
  }

  func testAndroidWrittenTagsParse() {
    // java.net.URLEncoder output, as an Android phone writes it onto an NFC tag
    XCTAssertEqual(QuickAction.parse("vatra://do?a=scene&id=evening+%26+calm"), .scene("evening & calm"))
    XCTAssertEqual(QuickAction.parse("vatra://do?a=scene&id=evening+%26+calm")?.uri, "vatra://do?a=scene&id=evening+%26+calm")
  }

  func testTagsCannotSmuggleAnythingOutsideTheAllowLists() {
    XCTAssertNil(QuickAction.parse("vatra://do?a=script&n=rm_rf"))
    XCTAssertNil(QuickAction.parse("vatra://do?a=toggle&e=light.x;drop&on=1"))
    XCTAssertNil(QuickAction.parse("vatra://do?a=ambilight&m=strobe"))
    XCTAssertNil(QuickAction.parse("vatra://do?a=open-door"))
    XCTAssertNil(QuickAction.parse("https://evil/do?a=water"))
    XCTAssertNil(QuickAction.parse("vatra://pair?h=x&c=y"))
  }

  func testPushMapAndJsonGiveTheSamePayload() throws {
    let m: [String: String] = [
      "type": "card", "id": "c1", "kind": "intercom", "tag": "door", "title": "Sună", "body": "", "priority": "high",
      "actions": #"[{"id":"open","label":"Deschide","style":"primary"}]"#, "sticky": "0", "at": "1700000000000",
    ]
    let a = try XCTUnwrap(PushPayload.from(map: m))
    let b = try XCTUnwrap(PushPayload.from(json: try JSONSerialization.data(withJSONObject: m)))
    let c = try XCTUnwrap(PushPayload.from(userInfo: ["aps": ["alert": ["title": "x"]], "vatra": m]))
    XCTAssertEqual(a, b)
    XCTAssertEqual(a, c)
    XCTAssertTrue(a.isIntercomRing)
    XCTAssertEqual(a.actions.first?.id, "open")
    XCTAssertEqual(a.threadKey, "door")
    XCTAssertEqual(a.category, "vatra.intercom")
    XCTAssertEqual(a.at, 1_700_000_000_000)
  }

  func testPayloadEdgeCases() throws {
    XCTAssertNil(PushPayload.from(map: ["title": "no id"]))
    XCTAssertNil(PushPayload.from(json: Data("not json".utf8)))
    let d = try XCTUnwrap(PushPayload.from(map: ["type": "dismiss", "id": "c1", "kind": "intercom", "priority": "high", "actions": "garbage"]))
    XCTAssertTrue(d.isDismiss)
    XCTAssertFalse(d.isIntercomRing)
    XCTAssertTrue(d.actions.isEmpty)
    XCTAssertTrue(try XCTUnwrap(PushPayload.from(map: ["id": "c", "fetch": "1"])).needsFetch)
  }

  func testHomeViewDerivesTilesAndPermissions() throws {
    let s = HomeState(
      rooms: [Room(id: "bed", name: "Bedroom", level: "control"), Room(id: "kit", name: "Kitchen", level: "view")],
      devices: [
        Device(id: "lamp", name: "Lamp", kind: "light", room: "bed", entity: "light.lamp"),
        Device(id: "ac", name: "AC", kind: "climate", room: "bed", entity: "climate.ac"),
        Device(id: "hood", name: "Hood", kind: "light", room: "kit", entity: "light.hood"),
        Device(id: "door", name: "Door", kind: "sensor", room: "kit", entity: "binary_sensor.door"),
        Device(id: "dead", name: "Dead", kind: "light", room: "bed", entity: "light.dead"),
      ],
      states: [
        "light.lamp": EntityState(state: "on", attributes: ["brightness": .number(128)]),
        "climate.ac": EntityState(state: "cool"),
        "light.hood": EntityState(state: "on"),
        "binary_sensor.door": EntityState(state: "off"),
        "light.dead": EntityState(state: "unavailable"),
      ],
      haOnline: true)
    let rooms = HomeView.rooms(s)
    let bed = try XCTUnwrap(rooms.first { $0.id == "bed" })
    let lamp = try XCTUnwrap(bed.devices.first { $0.id == "lamp" })
    XCTAssertEqual(lamp.brightnessPct, 50)
    XCTAssertTrue(lamp.toggleable)
    XCTAssertEqual(bed.devices.first { $0.id == "ac" }?.on, true)
    let dead = try XCTUnwrap(bed.devices.first { $0.id == "dead" })
    XCTAssertFalse(dead.available)
    XCTAssertFalse(dead.toggleable)
    let kit = try XCTUnwrap(rooms.first { $0.id == "kit" })
    XCTAssertEqual(kit.devices.first { $0.id == "hood" }?.toggleable, false)
    XCTAssertNil(try XCTUnwrap(kit.devices.first { $0.id == "door" }).on)
    XCTAssertEqual(HomeView.lightsOn(s), 2)
  }

  func testTokensTextPairsAreAA() {
    func lum(_ hex: UInt32) -> Double {
      func ch(_ v: UInt32) -> Double {
        let c = Double(v) / 255
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * ch(hex >> 16 & 0xFF) + 0.7152 * ch(hex >> 8 & 0xFF) + 0.0722 * ch(hex & 0xFF)
    }
    func contrast(_ a: UInt32, _ b: UInt32) -> Double {
      let (x, y) = (lum(a), lum(b))
      return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
    for (name, c) in [("light", VatraPalette.light), ("dark", VatraPalette.dark)] {
      let pairs: [String: (UInt32, UInt32)] = [
        "fg/bg": (c.fg, c.bg), "fg/surface": (c.fg, c.surface), "fgMuted/surface": (c.fgMuted, c.surface),
        "fgSoft/surface": (c.fgSoft, c.surface), "primaryFg/primary": (c.primaryFg, c.primary),
        "primaryText/surface": (c.primaryText, c.surface), "litFg/lit": (c.litFg, c.lit),
        "dangerFg/danger": (c.dangerFg, c.danger), "successFg/success": (c.successFg, c.success),
        "warningFg/warning": (c.warningFg, c.warning),
      ]
      for (k, p) in pairs { XCTAssertGreaterThanOrEqual(contrast(p.0, p.1), 4.5, "\(name) \(k)") }
    }
  }

  func testOpticalSizesFollowTheBrand() {
    XCTAssertEqual(VatraMarks.optical(for: 16).stroke, VatraMarks.micro.stroke)
    XCTAssertEqual(VatraMarks.optical(for: 32).stroke, VatraMarks.small.stroke)
    XCTAssertEqual(VatraMarks.optical(for: 96).stroke, VatraMarks.master.stroke)
  }
}
