import SwiftUI
import VatraCore

struct SettingsScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c
  @AppStorage("push.on", store: VatraEnv.group) private var pushOn = true
  @State private var presence = Presence.shared
  @State private var nfcSheet = false

  var body: some View {
    NavigationStack {
      Form {
        Section(L("homes")) {
          ForEach(model.hubs.hubs) { h in
            Button {
              model.select(h.id)
            } label: {
              HStack {
                Image(systemName: h.id == model.hub?.id ? "largecircle.fill.circle" : "circle")
                VStack(alignment: .leading) {
                  Text(h.name).foregroundStyle(c.fg)
                  Text(h.baseUrl).font(.caption).foregroundStyle(c.fgMuted)
                }
              }
            }
            .accessibilityAddTraits(h.id == model.hub?.id ? .isSelected : [])
            .swipeActions { Button(L("forget"), role: .destructive) { model.forget(h.id) } }
          }
          Button(L("add_home")) { model.adding = true }
        }

        Section {
          Toggle(L("push_apns"), isOn: $pushOn)
            .onChange(of: pushOn) { _, _ in Task { await Push.refresh() } }
          if model.pushError { Text(L("push_failed")).font(.caption).foregroundStyle(c.danger) }
        } header: {
          Text(L("notifications"))
        } footer: {
          Text(L("push_body"))
        }

        Section {
          Toggle(L("presence_title"), isOn: Binding(get: { presence.enabled }, set: { presence.setEnabled($0) }))
          if presence.denied { Text(L("presence_denied")).font(.caption).foregroundStyle(c.danger) }
        } footer: {
          Text(L("presence_body"))
        }

        if NFCTags.available {
          Section {
            Button(L("nfc_write")) { nfcSheet = true }
          } header: {
            Text(L("nfc_title"))
          } footer: {
            Text(L("nfc_body"))
          }
        }

        Section {
          Button(L("language")) {
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
          }
          LabeledContent("Vatra", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
        }
      }
      .navigationTitle(L("tab_settings"))
      .sheet(isPresented: $nfcSheet) { NFCWriteSheet() }
    }
  }
}

struct NFCWriteSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.vatra) private var c
  @State private var status: String?

  private let options: [(String, QuickAction)] = [
    ("ambilight_movie", .ambilight("movie")), ("ambilight_off", .ambilight("off")), ("pc_wake", .script("pc_wake")),
    ("water_drink", .water), ("door_ignore", .doorIgnore),
  ]

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(options, id: \.0) { o in
            Button(L(o.0)) {
              NFCTags.write(o.1) { ok in Task { @MainActor in status = L(ok ? "nfc_written" : "nfc_failed") } }
            }
          }
        } footer: {
          Text(L("nfc_hold"))
        }
        if let status { Text(status).foregroundStyle(c.fgMuted) }
      }
      .navigationTitle(L("nfc_write"))
      .toolbar { Button(L("cancel")) { dismiss() } }
    }
  }
}
