import Foundation
import Observation
import SwiftUI
import VatraCore
import WidgetKit

enum Tab: Hashable { case home, lights, alerts, settings }

/// Everything the phone shows about the active hub; polled every 5 s while the app is in front
/// (the SSE stream stays a web-only surface), same as the Android HomeModel.
@MainActor @Observable
final class AppModel {
  static let shared = AppModel()

  var hubs = HubList()
  var me: Me?
  var state: HomeState?
  var lights: Lights?
  var cards: Cards?
  var intercom: Intercom?
  var water: Water?
  var offline = false
  var tooOld = false
  var loading = true
  /// Last refusal text from the hub (already localised), shown once.
  var message: String?
  var tab: Tab = .home
  var adding = false
  var pendingInvite: PairLink?
  var pushError = false

  private var poll: Task<Void, Never>?

  init() { hubs = VatraEnv.store.current() }

  var hub: PairedHub? { hubs.active }
  var unread: Int { cards?.cards.filter(\.unread).count ?? 0 }

  func client() -> HubClient? { hub.map(VatraEnv.client) }

  func start() {
    hubs = VatraEnv.store.current()
    poll?.cancel()
    guard let c = client() else { loading = false; return }
    poll = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh(c)
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  func stop() { poll?.cancel() }

  func refreshNow() async {
    if let c = client() { await refresh(c) }
  }

  private func refresh(_ c: HubClient) async {
    let me = await c.me()
    if case .tooOld = me { tooOld = true; loading = false; return }
    async let st = c.state()
    async let li = c.lights()
    async let ca = c.cards()
    async let ic = c.intercom()
    async let wa = c.water()
    let (s, l, cs, i, w) = await (st, li, ca, ic, wa)
    guard c.baseUrl == client()?.baseUrl else { return }
    self.me = me.value ?? self.me
    if case .offline = s { offline = true } else { offline = false }
    state = s.value ?? state
    lights = l.value ?? lights
    cards = cs.value ?? cards
    intercom = i.value ?? intercom
    water = w.value ?? water
    loading = false
    tooOld = false
    let g = Glance.from(state: state, water: water, hub: hub?.name)
    if g.lightsOn != Glance.load().lightsOn || g.waterMl != Glance.load().waterMl || g.devices != Glance.load().devices {
      g.save()
      WidgetCenter.shared.reloadAllTimelines()
    }
  }

  private func act<T>(_ f: @escaping @Sendable (HubClient) async -> ApiResult<T>) {
    guard let c = client() else { return }
    Task {
      switch await f(c) {
      case .refused(_, let code, let m): message = m.isEmpty ? code : m
      case .offline: offline = true
      default: break
      }
      await refresh(c)
    }
  }

  func toggle(_ entity: String, _ on: Bool) { act { await $0.control(.toggle(entity: entity, on: on)) } }
  func brightness(_ entity: String, _ pct: Int) { act { await $0.control(.light(entity: entity, brightnessPct: min(100, max(1, pct)))) } }
  func scene(_ id: String) { act { await $0.lights(.scene(id: id)) } }
  func lightsTarget(_ target: String, _ on: Bool) { act { await $0.lights(.set(target: target, state: LightState(on: on))) } }
  func ambilight(_ mode: String) { act { await $0.control(.ambilight(mode: mode)) } }
  func script(_ name: String) { act { await $0.control(.script(name: name)) } }
  func door(_ action: String) { act { await $0.intercom(IntercomAct(action: action)) } }
  func drink() { act { await $0.water(WaterAct(op: "drink")) } }
  func undoDrink() { act { await $0.water(WaterAct(op: "undo")) } }
  func dismiss(_ id: String) { act { await $0.notify(.dismiss(id: id)) } }
  func cardAction(_ id: String, _ action: String) { act { await $0.act(cardId: id, action: action) } }
  func quick(_ a: QuickAction) { act { await a.run($0) } }

  // MARK: hubs

  func paired(_ h: PairedHub) {
    hubs = VatraEnv.store.update { $0.add(h) }
    adding = false
    pendingInvite = nil
    resetHubState()
    start()
    Task { await Push.refresh() }
  }

  func select(_ id: String) {
    hubs = VatraEnv.store.update { $0.select(id) }
    resetHubState()
    start()
    Task { await Push.refresh() }
  }

  func forget(_ id: String) {
    if let h = hubs.hubs.first(where: { $0.id == id }) {
      // best effort: tell that hub to stop pushing to this device before the token is dropped
      let c = VatraEnv.client(h)
      Task { _ = await c.registerPush(.none) }
    }
    hubs = VatraEnv.store.update { $0.remove(id) }
    resetHubState()
    start()
  }

  private func resetHubState() {
    me = nil; state = nil; lights = nil; cards = nil; intercom = nil; water = nil
    offline = false; tooOld = false; loading = hub != nil
  }

  /// vatra://pair?… (QR / link) opens the add-hub screen with the invite; vatra://do?… runs a house action.
  func open(url: URL) {
    let s = url.absoluteString
    if let link = PairLink.parse(s) {
      pendingInvite = link
      adding = true
    } else if let a = QuickAction.parse(s) {
      quick(a)
    }
  }
}
