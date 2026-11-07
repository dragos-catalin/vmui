import SwiftUI
import VatraCore

struct HomeScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c

  var body: some View {
    let rooms = model.state.map(HomeView.rooms) ?? []
    NavigationStack {
      List {
        if let name = model.me?.member.displayName {
          Text(L("signed_in_as", name)).font(.footnote).foregroundStyle(c.fgMuted)
        }
        if model.offline {
          Label(L("hub_offline"), systemImage: "wifi.exclamationmark").foregroundStyle(c.danger)
        } else if model.state?.haOnline == false {
          Label(L("ha_offline"), systemImage: "exclamationmark.triangle").foregroundStyle(c.danger)
        }
        if let i = model.intercom, i.ringing {
          Section {
            Text(L("door_ringing")).font(.headline)
            HStack {
              if i.canOpen { Button(L("door_open")) { model.door("open") }.buttonStyle(.borderedProminent) }
              Button(L("door_ignore")) { model.door("ignore") }.buttonStyle(.bordered)
            }
          }
        }
        if let w = model.water {
          Section(L("water_title")) {
            ProgressView(value: Double(w.ml), total: Double(max(w.target, 1)))
              .accessibilityValue(L("water_progress", w.ml, w.target))
            Text(L("water_progress", w.ml, w.target)).font(.subheadline).foregroundStyle(c.fgMuted)
            HStack {
              Button(L("water_drink")) { model.drink() }.buttonStyle(.borderedProminent)
              Button(L("undo")) { model.undoDrink() }.buttonStyle(.bordered)
            }
          }
        }
        Section {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack {
              Button(L("ambilight_movie")) { model.ambilight("movie") }
              Button(L("ambilight_off")) { model.ambilight("off") }
              Button(L("pc_wake")) { model.script("pc_wake") }
            }
            .buttonStyle(.bordered)
          }
        }
        if rooms.isEmpty {
          Text(L("no_rooms")).foregroundStyle(c.fgMuted)
        }
        ForEach(rooms) { r in
          Section {
            ForEach(r.devices) { d in DeviceRow(d: d) }
          } header: {
            HStack {
              Text(r.name)
              if !r.canControl { Text(L("view_only")).font(.caption2).foregroundStyle(c.fgMuted) }
            }
          }
        }
      }
      .navigationTitle(model.hub?.name ?? L("app_name"))
      .refreshable { await model.refreshNow() }
    }
  }
}

struct DeviceRow: View {
  let d: DeviceTile
  @Environment(AppModel.self) private var model
  @State private var bri: Double = 50

  private var stateText: String {
    if !d.available { return L("state_unavailable") }
    switch d.on { case true?: return L("state_on"); case false?: return L("state_off"); default: return "" }
  }

  var body: some View {
    VStack(alignment: .leading) {
      if let on = d.on, let e = d.entity {
        Toggle(isOn: Binding(get: { on }, set: { model.toggle(e, $0) })) {
          VStack(alignment: .leading) {
            Text(d.name)
            if !stateText.isEmpty { Text(stateText).font(.caption).foregroundStyle(.secondary) }
          }
        }
        .disabled(!d.toggleable)
        .accessibilityValue(stateText)
      } else {
        LabeledContent(d.name, value: stateText)
      }
      if d.kind == "light", d.on == true, d.toggleable, let b = d.brightnessPct, let e = d.entity {
        Slider(value: $bri, in: 1...100) { editing in if !editing { model.brightness(e, Int(bri)) } }
          .accessibilityLabel(L("brightness"))
          .accessibilityValue("\(Int(bri)) %")
          .onAppear { bri = Double(b) }
          .onChange(of: b) { _, nb in bri = Double(nb) }
      }
    }
  }
}

struct LightsScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c

  var body: some View {
    NavigationStack {
      List {
        Section(L("scenes")) {
          if model.lights?.scenes.isEmpty ?? true { Text(L("no_scenes")).foregroundStyle(c.fgMuted) }
          ForEach(model.lights?.scenes ?? []) { s in
            Button(s.name) { model.scene(s.id) }
          }
        }
        Section(L("lights")) {
          ForEach(model.lights?.devices ?? []) { d in
            HStack {
              VStack(alignment: .leading) {
                Text(d.name)
                Text(d.health == "ok" ? d.room : "\(d.room) · \(d.health)").font(.caption).foregroundStyle(c.fgMuted)
              }
              Spacer()
              Button(L("state_off")) { model.lightsTarget("dev:\(d.id)", false) }.buttonStyle(.bordered)
              Button(L("state_on")) { model.lightsTarget("dev:\(d.id)", true) }.buttonStyle(.bordered)
            }
          }
        }
      }
      .navigationTitle(L("tab_lights"))
      .refreshable { await model.refreshNow() }
    }
  }
}

struct AlertsScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c

  var body: some View {
    NavigationStack {
      List {
        let cards = model.cards?.cards ?? []
        if cards.isEmpty { Text(L("no_alerts")).foregroundStyle(c.fgMuted) }
        ForEach(cards) { card in
          VStack(alignment: .leading, spacing: 6) {
            Text(card.title).font(.headline)
            if !card.body.isEmpty { Text(card.body) }
            if let s = card.subtitle { Text(s).font(.caption).foregroundStyle(c.fgMuted) }
            HStack {
              ForEach(card.actions) { a in
                if a.style == "primary" {
                  Button(a.label) { model.cardAction(card.id, a.id) }.buttonStyle(.borderedProminent)
                } else {
                  Button(a.label) { model.cardAction(card.id, a.id) }.buttonStyle(.bordered)
                }
              }
            }
          }
          .swipeActions { Button(L("dismiss"), role: .destructive) { model.dismiss(card.id) } }
          .accessibilityAction(named: L("dismiss")) { model.dismiss(card.id) }
        }
      }
      .navigationTitle(L("tab_alerts"))
      .refreshable { await model.refreshNow() }
    }
  }
}
