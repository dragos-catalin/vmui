import SwiftUI
import VatraCore

struct SettingsScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c
  @AppStorage("push.on", store: VatraEnv.group) private var pushOn = true
  @State private var presence = Presence.shared
  @State private var nfcSheet = false
  @State private var deleteSheet = false

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

        if let h = model.hub {
          Section {
            if let me = model.me {
              if me.member.role == "owner" {
                Text(L("account_delete_owner")).font(.callout).foregroundStyle(c.fgMuted)
              } else {
                Button(L("account_delete"), role: .destructive) { deleteSheet = true }
              }
            }
            if let u = URL(string: h.baseUrl + "/privacy") { Link(L("privacy_policy"), destination: u) }
            if let u = URL(string: h.baseUrl + "/account/delete") { Link(L("account_delete_page"), destination: u) }
          } header: {
            Text(L("account_title"))
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
      .sheet(isPresented: $deleteSheet) { DeleteAccountSheet(hubName: model.hub?.name ?? "") }
    }
  }
}

/// Confirms deleting this member's account on the hub with the password (App Store 5.1.1(v)).
struct DeleteAccountSheet: View {
  let hubName: String
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.vatra) private var c
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(L("account_delete_warning", hubName))
        }
        Section {
          SecureField(L("account_delete_password"), text: $password)
            .textContentType(.password)
            .submitLabel(.done)
          if let error { Text(error).font(.caption).foregroundStyle(c.danger) }
        }
        Section {
          Button(role: .destructive) {
            Task { await submit() }
          } label: {
            if busy { ProgressView() } else { Text(L("account_delete_confirm")) }
          }
          .disabled(password.isEmpty || busy)
        }
      }
      .navigationTitle(L("account_delete"))
      .toolbar { Button(L("cancel")) { dismiss() }.disabled(busy) }
      .interactiveDismissDisabled(busy)
    }
  }

  private func submit() async {
    busy = true
    error = nil
    let e = await model.deleteAccount(password: password)
    busy = false
    if let e { error = e } else { dismiss() }
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
