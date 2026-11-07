import SwiftUI
import VatraCore
import WatchConnectivity
import WidgetKit

@main
struct VatraWatchApp: App {
  @State private var model = WatchModel()
  var body: some SwiftUI.Scene {
    WindowGroup {
      WatchRoot().environment(model).vatraThemed()
    }
  }
}

/// The watch keeps its own paired hub (its own `vmd_` token, platform vatra-watchos) so it works away from
/// the phone. Pairing: the phone mints a one-time invite for the same member and hands it over
/// WatchConnectivity; without the phone, the watch asks the hub for approval by address.
@MainActor @Observable
final class WatchModel: NSObject, WCSessionDelegate {
  var hubs = VatraEnv.store.current()
  var state: HomeState?
  var water: Water?
  var pair: PairState?
  var message: String?

  override init() {
    super.init()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  var client: HubClient? { hubs.active.map(VatraEnv.client) }

  func refresh() async {
    guard let c = client else { return }
    async let s = c.state()
    async let w = c.water()
    let (st, wa) = await (s, w)
    state = st.value ?? state
    water = wa.value ?? water
    Glance.from(state: state, water: water, hub: hubs.active?.name).save()
    WidgetCenter.shared.reloadAllTimelines()
  }

  func act(_ a: QuickAction) {
    guard let c = client else { return }
    Task {
      if case .refused(_, let code, let m) = await a.run(c) { message = m.isEmpty ? code : m }
      await refresh()
    }
  }

  private var pairing: Pairing { Pairing(deviceName: L("watch_name"), language: VatraEnv.language, platform: Pairing.platformWatch) }

  func pairFromPhone() {
    guard WCSession.default.activationState == .activated, WCSession.default.isReachable else {
      pair = .failed(code: "phone_unreachable")
      return
    }
    pair = .working
    WCSession.default.sendMessage(["want": "invite"]) { reply in
      let link = (reply["link"] as? String).flatMap(PairLink.parse)
      Task { @MainActor in
        guard let link else { self.pair = .failed(code: (reply["error"] as? String) ?? "rejected"); return }
        await self.finish(self.pairing.withInvite(link))
      }
    } errorHandler: { _ in
      Task { @MainActor in self.pair = .failed(code: "phone_unreachable") }
    }
  }

  func pairByApproval(_ address: String) {
    Task {
      await finish(pairing.withApproval(hub: address) { s in Task { @MainActor in self.pair = s } })
    }
  }

  private func finish(_ s: PairState) async {
    pair = s
    if case .paired(let h) = s {
      hubs = VatraEnv.store.update { $0.add(h) }
      pair = nil
      await refresh()
    }
  }

  func forget() {
    if let id = hubs.active?.id { hubs = VatraEnv.store.update { $0.remove(id) } }
  }

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
}

struct WatchRoot: View {
  @Environment(WatchModel.self) private var model
  var body: some View {
    if model.hubs.active == nil { WatchPairView() } else { WatchHome() }
  }
}

struct WatchPairView: View {
  @Environment(WatchModel.self) private var model
  @Environment(\.vatra) private var c
  @State private var address = ""

  var body: some View {
    ScrollView {
      VStack(spacing: 8) {
        VatraMarkView(size: 40, line: c.fg, flame: c.primary, core: c.lit)
        Text(L("pair_title")).font(.headline)
        Text(L("watch_pair_body")).font(.footnote).multilineTextAlignment(.center)
        Button(L("watch_pair_phone")) { model.pairFromPhone() }.buttonStyle(.borderedProminent)
        TextField(L("add_address"), text: $address).textContentType(.URL)
        Button(L("add_request")) { model.pairByApproval(address) }.disabled(address.isEmpty)
        switch model.pair {
        case .working?: ProgressView()
        case .awaitingApproval(let code)?:
          Text(L("add_waiting")).font(.footnote)
          Text(code).font(.title.monospacedDigit().bold())
        case .failed(let code, let m)?:
          Text(code == "phone_unreachable" ? L("watch_phone_unreachable") : m.isEmpty ? L("err_generic", code) : m)
            .font(.footnote).foregroundStyle(c.danger)
        default: EmptyView()
        }
      }
    }
  }
}

struct WatchHome: View {
  @Environment(WatchModel.self) private var model
  @Environment(\.vatra) private var c

  var body: some View {
    let tiles = model.state.map { HomeView.rooms($0).flatMap { $0.devices.filter(\.toggleable) } } ?? []
    List {
      if let w = model.water {
        Section(L("water_title")) {
          Gauge(value: Double(w.ml), in: 0...Double(max(w.target, 1))) { Text(L("water_progress", w.ml, w.target)) }
          Button(L("water_drink")) { model.act(.water) }
        }
      }
      Section {
        Button(L("ambilight_movie")) { model.act(.ambilight("movie")) }
        Button(L("ambilight_off")) { model.act(.ambilight("off")) }
      }
      Section(L("tab_home")) {
        ForEach(tiles) { d in
          Toggle(d.name, isOn: Binding(get: { d.on ?? false }, set: { v in d.entity.map { model.act(.toggle(entity: $0, on: v)) } }))
        }
      }
      if let m = model.message { Text(m).foregroundStyle(c.danger) }
      Button(L("forget"), role: .destructive) { model.forget() }
    }
    .navigationTitle(model.hubs.active?.name ?? L("app_name"))
    .task {
      while !Task.isCancelled {
        await model.refresh()
        try? await Task.sleep(for: .seconds(15))
      }
    }
  }
}
