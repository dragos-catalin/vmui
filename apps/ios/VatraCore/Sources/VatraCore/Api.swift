import Foundation

// Wire shapes of /api/v1/app/* (src/lib/api/app-routes.ts, snapshot docs/api/app-openapi.json).
// Decoding is tolerant: unknown keys are ignored and missing optional keys take defaults, so an
// additive hub change never breaks an installed app (same rules as the Android :core WireJson).

extension KeyedDecodingContainer {
  func v<T: Decodable>(_ key: Key, _ fallback: @autoclosure () -> T) throws -> T {
    try decodeIfPresent(T.self, forKey: key) ?? fallback()
  }
}

public struct Discover: Codable, Sendable, Equatable {
  public var app = "", product = "", host = "", version = ""
  public var apiVersion = 0, minClient = 0
  public var claimed = true
  public var pair = "/api/devices/pair"

  enum CodingKeys: String, CodingKey { case app, product, host, version, apiVersion, minClient, claimed, pair }

  public init() {}

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    app = try c.v(.app, ""); product = try c.v(.product, ""); host = try c.v(.host, ""); version = try c.v(.version, "")
    apiVersion = try c.v(.apiVersion, 0); minClient = try c.v(.minClient, 0)
    claimed = try c.v(.claimed, true); pair = try c.v(.pair, "/api/devices/pair")
  }
}

public struct Member: Codable, Sendable, Equatable {
  public let displayName: String
  public let role: String
}

public struct Can: Codable, Sendable, Equatable {
  public let openDoor: Bool
  public let manageHome: Bool
}

public struct Me: Codable, Sendable, Equatable {
  public let apiVersion: Int
  public let minClient: Int
  public let member: Member
  public let deviceId: String?
  public let rooms: [String: String]
  public let can: Can

  enum CodingKeys: String, CodingKey { case apiVersion, minClient, member, deviceId, rooms, can }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    apiVersion = try c.decode(Int.self, forKey: .apiVersion)
    minClient = try c.decode(Int.self, forKey: .minClient)
    member = try c.decode(Member.self, forKey: .member)
    deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
    rooms = try c.v(.rooms, [:])
    can = try c.decode(Can.self, forKey: .can)
  }
}

public struct Room: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let level: String
  public var canControl: Bool { level == "control" }

  public init(id: String, name: String, level: String) { self.id = id; self.name = name; self.level = level }
}

public struct Device: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let kind: String
  public let room: String
  public let entity: String?
  public let entities: [String]

  enum CodingKeys: String, CodingKey { case id, name, kind, room, entity, entities }

  public init(id: String, name: String, kind: String, room: String, entity: String? = nil, entities: [String] = []) {
    self.id = id; self.name = name; self.kind = kind; self.room = room; self.entity = entity; self.entities = entities
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
    kind = try c.decode(String.self, forKey: .kind); room = try c.decode(String.self, forKey: .room)
    entity = try c.decodeIfPresent(String.self, forKey: .entity); entities = try c.v(.entities, [])
  }
}

public struct EntityState: Codable, Sendable, Equatable {
  public let state: String
  public let attributes: [String: JSONValue]

  enum CodingKeys: String, CodingKey { case state, attributes }

  public init(state: String, attributes: [String: JSONValue] = [:]) { self.state = state; self.attributes = attributes }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    state = try c.decode(String.self, forKey: .state); attributes = try c.v(.attributes, [:])
  }
}

public struct HomeState: Codable, Sendable, Equatable {
  public var rooms: [Room] = []
  public var devices: [Device] = []
  public var states: [String: EntityState] = [:]
  public var haOnline = false

  enum CodingKeys: String, CodingKey { case rooms, devices, states, haOnline }

  public init(rooms: [Room] = [], devices: [Device] = [], states: [String: EntityState] = [:], haOnline: Bool = false) {
    self.rooms = rooms; self.devices = devices; self.states = states; self.haOnline = haOnline
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    rooms = try c.v(.rooms, []); devices = try c.v(.devices, []); states = try c.v(.states, [:]); haOnline = try c.v(.haOnline, false)
  }
}

public struct Segment: Codable, Sendable, Equatable { public let id: String; public let name: String }

public struct Light: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let room: String
  public let health: String
  public let segments: [Segment]
  public let capabilities: [String: JSONValue]

  enum CodingKeys: String, CodingKey { case id, name, room, health, segments, capabilities }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
    room = try c.decode(String.self, forKey: .room); health = try c.decode(String.self, forKey: .health)
    segments = try c.v(.segments, []); capabilities = try c.v(.capabilities, [:])
  }
}

public struct Scene: Codable, Sendable, Equatable, Identifiable { public let id: String; public let name: String }

public struct Lights: Codable, Sendable, Equatable {
  public var devices: [Light] = []
  public var scenes: [Scene] = []
  enum CodingKeys: String, CodingKey { case devices, scenes }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    devices = try c.v(.devices, []); scenes = try c.v(.scenes, [])
  }
}

public struct LightState: Codable, Sendable, Equatable {
  public var on: Bool?
  public var rgb: [Int]?
  public var brightnessPct: Int?
  public var kelvin: Int?
  public init(on: Bool? = nil, rgb: [Int]? = nil, brightnessPct: Int? = nil, kelvin: Int? = nil) {
    self.on = on; self.rgb = rgb; self.brightnessPct = brightnessPct; self.kelvin = kelvin
  }
}

/// POST /api/v1/app/lights (discriminator `op`).
public enum LightsOp: Encodable, Sendable, Equatable {
  case set(target: String, state: LightState)
  case scene(id: String)
  case undo

  enum K: String, CodingKey { case op, target, state, id }

  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: K.self)
    switch self {
    case .set(let t, let s): try c.encode("set", forKey: .op); try c.encode(t, forKey: .target); try c.encode(s, forKey: .state)
    case .scene(let id): try c.encode("scene", forKey: .op); try c.encode(id, forKey: .id)
    case .undo: try c.encode("undo", forKey: .op)
    }
  }
}

public struct Applied: Codable, Sendable, Equatable { public let ok: Bool; public let applied: Int }

/// POST /api/v1/app/control: one device command or a house scene (discriminator `type`).
public enum Control: Encodable, Sendable, Equatable {
  case toggle(entity: String, on: Bool)
  case light(entity: String, rgb: [Int]? = nil, brightnessPct: Int? = nil, kelvin: Int? = nil)
  case climate(entity: String, hvacMode: String? = nil, temperature: Double? = nil, fanMode: String? = nil)
  case select(entity: String, option: String)
  case media(entity: String, command: String)
  case ambilight(mode: String)
  case script(name: String)

  enum K: String, CodingKey { case type, entity, on, rgb, brightnessPct, kelvin, hvacMode, temperature, fanMode, option, command, mode, name }

  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: K.self)
    switch self {
    case .toggle(let en, let on):
      try c.encode("toggle", forKey: .type); try c.encode(en, forKey: .entity); try c.encode(on, forKey: .on)
    case .light(let en, let rgb, let b, let k):
      try c.encode("light", forKey: .type); try c.encode(en, forKey: .entity)
      try c.encodeIfPresent(rgb, forKey: .rgb); try c.encodeIfPresent(b, forKey: .brightnessPct); try c.encodeIfPresent(k, forKey: .kelvin)
    case .climate(let en, let m, let t, let f):
      try c.encode("climate", forKey: .type); try c.encode(en, forKey: .entity)
      try c.encodeIfPresent(m, forKey: .hvacMode); try c.encodeIfPresent(t, forKey: .temperature); try c.encodeIfPresent(f, forKey: .fanMode)
    case .select(let en, let o):
      try c.encode("select", forKey: .type); try c.encode(en, forKey: .entity); try c.encode(o, forKey: .option)
    case .media(let en, let cmd):
      try c.encode("media", forKey: .type); try c.encode(en, forKey: .entity); try c.encode(cmd, forKey: .command)
    case .ambilight(let m): try c.encode("ambilight", forKey: .type); try c.encode(m, forKey: .mode)
    case .script(let n): try c.encode("script", forKey: .type); try c.encode(n, forKey: .name)
    }
  }
}

public struct Ok: Codable, Sendable, Equatable {
  public var ok = true
  enum CodingKeys: String, CodingKey { case ok }
  public init() {}
  public init(from d: Decoder) throws { ok = try d.container(keyedBy: CodingKeys.self).v(.ok, true) }
}

public struct CardAct: Codable, Sendable, Equatable { public let id: String; public let action: String }

/// POST /api/v1/app/account/delete: a non-owner member deletes their own account (App Store 5.1.1(v)).
public struct AccountDelete: Codable, Sendable, Equatable {
  public let password: String
  public init(password: String) { self.password = password }
}

/// POST /api/v1/app/presence.
public struct PresenceReport: Codable, Sendable, Equatable {
  public let state: String
  public let source: String
  public init(state: String, source: String = "geofence") { self.state = state; self.source = source }
}

public struct PresenceResult: Codable, Sendable, Equatable { public let ok: Bool; public let fired: Bool }

public struct CardAction: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let label: String
  public let style: String
  public let url: String?
  public init(id: String, label: String, style: String, url: String? = nil) { self.id = id; self.label = label; self.style = style; self.url = url }
}

public struct Card: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: String
  public let title: String
  public let body: String
  public let subtitle: String?
  public let priority: String
  public let url: String?
  public let actions: [CardAction]
  public let createdAt: JSONValue?
  public let readAt: JSONValue?

  public var unread: Bool { readAt == nil || readAt?.isNull == true }

  enum CodingKeys: String, CodingKey { case id, kind, title, body, subtitle, priority, url, actions, createdAt, readAt }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); kind = try c.decode(String.self, forKey: .kind)
    title = try c.decode(String.self, forKey: .title); body = try c.decode(String.self, forKey: .body)
    subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle); priority = try c.decode(String.self, forKey: .priority)
    url = try c.decodeIfPresent(String.self, forKey: .url); actions = try c.v(.actions, [])
    createdAt = try c.decodeIfPresent(JSONValue.self, forKey: .createdAt); readAt = try c.decodeIfPresent(JSONValue.self, forKey: .readAt)
  }
}

public struct Cards: Codable, Sendable, Equatable {
  public var cards: [Card] = []
  public var now: Int64 = 0
  enum CodingKeys: String, CodingKey { case cards, now }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    cards = try c.v(.cards, []); now = try c.v(.now, 0)
  }
}

/// POST /api/v1/app/notify (discriminator `op`).
public enum NotifyOp: Encodable, Sendable, Equatable {
  case read(ids: [String])
  case ack(ids: [String])
  case dismiss(id: String)

  enum K: String, CodingKey { case op, ids, id }

  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: K.self)
    switch self {
    case .read(let ids): try c.encode("read", forKey: .op); try c.encode(ids, forKey: .ids)
    case .ack(let ids): try c.encode("ack", forKey: .op); try c.encode(ids, forKey: .ids)
    case .dismiss(let id): try c.encode("dismiss", forKey: .op); try c.encode(id, forKey: .id)
    }
  }
}

public struct Intercom: Codable, Sendable, Equatable {
  public let ringing: Bool
  public let ringingSince: Int64?
  public let lastRingAt: Int64?
  public let lastOpenAt: Int64?
  public let autoOpenUntil: Int64?
  public let armed: Bool
  public let canOpen: Bool
  public let ok: Bool?
}

public struct IntercomAct: Codable, Sendable, Equatable {
  public let action: String
  public let minutes: Int
  public init(action: String, minutes: Int = 45) { self.action = action; self.minutes = minutes }
}

public struct Water: Codable, Sendable, Equatable {
  public let ml: Int
  public let target: Int
  public let glasses: Int
  public let underPace: Bool
  public let lastAt: Int64?
  public init(ml: Int, target: Int, glasses: Int, underPace: Bool, lastAt: Int64? = nil) {
    self.ml = ml; self.target = target; self.glasses = glasses; self.underPace = underPace; self.lastAt = lastAt
  }
}

public struct WaterAct: Codable, Sendable, Equatable {
  public let op: String
  public let ml: Int
  public init(op: String = "drink", ml: Int = 250) { self.op = op; self.ml = ml }
}

public struct Macros: Codable, Sendable, Equatable {
  public let calories: Double, protein: Double, carbs: Double, fats: Double
}

public struct Meal: Codable, Sendable, Equatable {
  public let name: String
  public let mealType: String?
  public let calories: Double, protein: Double, carbs: Double, fats: Double
  public let at: Int64
}

public struct NutritionToday: Codable, Sendable, Equatable {
  public let day: String
  public let remaining: Macros
  public let meals: [Meal]
  public let streak: Int
  enum CodingKeys: String, CodingKey { case day, remaining, meals, streak }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    day = try c.decode(String.self, forKey: .day); remaining = try c.decode(Macros.self, forKey: .remaining)
    meals = try c.v(.meals, []); streak = try c.v(.streak, 0)
  }
}

/// Error body every refusal carries: `{ ok:false, code, error }` (error is already localised).
public struct ApiErrorBody: Codable, Sendable, Equatable {
  public var ok = false, code = "", error = ""
  enum CodingKeys: String, CodingKey { case ok, code, error }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    ok = try c.v(.ok, false); code = try c.v(.code, ""); error = try c.v(.error, "")
  }
}

/// POST /api/devices/pair.
public struct PairRequest: Codable, Sendable, Equatable {
  public let name: String
  public let platform: String
  public var invite: String?
  public var email: String?
  public var password: String?
}

public struct PairResponse: Codable, Sendable, Equatable {
  public let id: String
  public let token: String
  public let status: String
  public let code: String?
}

public struct PairStatus: Codable, Sendable, Equatable {
  public let status: String
  public let code: String?
}

/// POST /api/devices/pair/invite: a one-time QR link for another device of the same member.
public struct Invite: Codable, Sendable, Equatable {
  public let link: String, code: String, hub: String
  public let expiresAt: Int64
}

/// GET /api/v1/app/push: how this hub can wake the app.
public struct PushConfig: Codable, Sendable, Equatable {
  public var fcm: FcmOptions?
  public var webPush = false
  public var vapidKey: String?
  /// The hub can send through Apple Push (its own .p8 key, or the Vatra push relay).
  public var apns = false
  /// Vatra Cloud push relay (null when the owner has not enabled it): register handles there, then PUT kind relay.
  public var relay: PushRelay?
  enum CodingKeys: String, CodingKey { case fcm, webPush, vapidKey, apns, relay }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    fcm = try c.decodeIfPresent(FcmOptions.self, forKey: .fcm); webPush = try c.v(.webPush, false)
    vapidKey = try c.decodeIfPresent(String.self, forKey: .vapidKey); apns = try c.v(.apns, false)
    relay = (try? c.decodeIfPresent(PushRelay.self, forKey: .relay)).flatMap { $0.url.isEmpty || $0.hub.isEmpty ? nil : $0 }
  }
}

public struct PushRelay: Codable, Sendable, Equatable {
  public var url = ""
  public var hub = ""
  enum CodingKeys: String, CodingKey { case url, hub }
  public init(url: String, hub: String) { self.url = url; self.hub = hub }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    url = try c.v(.url, ""); hub = try c.v(.hub, "")
  }
}

/// PUT /api/v1/app/push kind relay → the per-device end-to-end key, returned once (base64url, 32 bytes).
public struct RelayRegistered: Codable, Sendable, Equatable {
  public var ok = false
  public var e2eKey = ""
  enum CodingKeys: String, CodingKey { case ok, e2eKey }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    ok = try c.v(.ok, false); e2eKey = try c.v(.e2eKey, "")
  }
  /// The decoded key, nil unless exactly 32 bytes.
  public var key: Data? { PushCrypto.b64url(e2eKey).flatMap { $0.count == 32 ? $0 : nil } }
}

/// POST {relay}/v1/handles → an opaque handle the hub stores instead of the platform token.
public struct RelayHandle: Codable, Sendable, Equatable {
  public var handle = ""
  enum CodingKeys: String, CodingKey { case handle }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    handle = try c.v(.handle, "")
  }
}

struct RelayHandleRequest: Codable, Sendable, Equatable {
  let platform: String
  let token: String
  let hub: String
}

/// GET /api/v1/app/push/card?id=: one card (bare, or wrapped as `{card}`).
public struct PushCard: Decodable, Sendable, Equatable {
  public let card: Card
  enum CodingKeys: String, CodingKey { case card }
  public init(from d: Decoder) throws {
    if let c = try? d.container(keyedBy: CodingKeys.self), let w = try? c.decode(Card.self, forKey: .card) {
      card = w
    } else {
      card = try Card(from: d)
    }
  }
}

public struct FcmOptions: Codable, Sendable, Equatable {
  public let projectId: String, applicationId: String, apiKey: String, senderId: String
}

/// PUT /api/v1/app/push (discriminator `kind`).
public enum PushRegistration: Encodable, Sendable, Equatable {
  case fcm(token: String)
  case unifiedPush(endpoint: String, p256dh: String, auth: String)
  /// An APNs device token (hex) for this app's bundle; `sandbox` for development-signed builds;
  /// `activityToken` = the intercom Live Activity push-to-start token (iOS 17.2+).
  case apns(token: String, sandbox: Bool, activityToken: String? = nil)
  /// Vatra Cloud push relay handles (`platform` apns | apns-sandbox | fcm); answered with RelayRegistered.
  case relay(platform: String, handle: String, activityHandle: String?)
  case none

  enum K: String, CodingKey { case kind, token, endpoint, p256dh, auth, sandbox, activityToken, platform, handle, activityHandle }

  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: K.self)
    switch self {
    case .fcm(let t): try c.encode("fcm", forKey: .kind); try c.encode(t, forKey: .token)
    case .unifiedPush(let ep, let p, let a):
      try c.encode("unifiedpush", forKey: .kind); try c.encode(ep, forKey: .endpoint); try c.encode(p, forKey: .p256dh); try c.encode(a, forKey: .auth)
    case .apns(let t, let s, let a):
      try c.encode("apns", forKey: .kind); try c.encode(t, forKey: .token); try c.encode(s, forKey: .sandbox)
      try c.encodeIfPresent(a, forKey: .activityToken)
    case .relay(let p, let h, let a):
      try c.encode("relay", forKey: .kind); try c.encode(p, forKey: .platform); try c.encode(h, forKey: .handle)
      if let a { try c.encode(a, forKey: .activityHandle) } else { try c.encodeNil(forKey: .activityHandle) }
    case .none: try c.encode("none", forKey: .kind)
    }
  }
}
