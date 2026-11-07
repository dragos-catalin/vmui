import SwiftUI
import UIKit
import VatraCore

/// Join a home: scan the hub's QR, pick a hub found on Wi-Fi, sign in, or ask for approval.
struct AddHubScreen: View {
  let invite: PairLink?
  let canCancel: Bool
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c
  @State private var ui = PairUI()
  @State private var scanning = false
  @State private var address = ""
  @State private var email = ""
  @State private var password = ""
  @State private var found: [DiscoveredHub] = []
  @State private var job: Task<Void, Never>?

  private var pairing: Pairing { Pairing(deviceName: UIDevice.current.name, language: VatraEnv.language) }
  private var working: Bool { ui.state == .working }
  private var state: PairState? { ui.state }
  /// Pairing reports from its own task; the observable holder hops to the main actor.
  private var report: @Sendable (PairState) -> Void { { [ui] s in Task { @MainActor in ui.apply(s) } } }

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        VatraMarkView(size: 96, line: c.fg, flame: c.primary, core: c.lit)
        Text(L("add_title")).font(.title2.bold())
        Text(L("add_body")).foregroundStyle(c.fgMuted).multilineTextAlignment(.center)

        status

        if scanning {
          QRScanner { raw in
            guard let l = PairLink.parse(raw) else { return }
            scanning = false
            run { await pairing.withInvite(l, onState: report) }
          }
          .frame(height: 320)
          .clipShape(RoundedRectangle(cornerRadius: VatraRadius.lg))
          .accessibilityLabel(L("add_scan"))
        } else {
          Button(L("add_scan")) { scanning = true }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
        }

        if !found.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text(L("add_found")).font(.headline)
            ForEach(found) { h in
              HStack {
                VStack(alignment: .leading) {
                  Text(h.name)
                  Text(h.baseUrl).font(.caption).foregroundStyle(c.fgMuted)
                }
                Spacer()
                Button(L("add_use")) { address = h.baseUrl }
              }
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        Group {
          TextField(L("add_address"), text: $address).keyboardType(.URL).textContentType(.URL)
          TextField(L("add_email"), text: $email).keyboardType(.emailAddress).textContentType(.username)
          SecureField(L("add_password"), text: $password).textContentType(.password)
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textFieldStyle(.roundedBorder)

        Button(L("add_sign_in")) {
          let (a, e, p) = (address, email.trimmingCharacters(in: .whitespaces), password)
          run { await pairing.withLogin(hub: a, email: e, password: p, onState: report) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(address.isEmpty || email.isEmpty || password.isEmpty || working)

        Button(L("add_request")) {
          let a = address
          run { await pairing.withApproval(hub: a, onState: report) }
        }
        .buttonStyle(.bordered)
        .disabled(address.isEmpty || working)

        if canCancel {
          Button(L("cancel")) {
            job?.cancel()
            model.adding = false
            model.pendingInvite = nil
          }
        }
      }
      .padding(24)
    }
    .task {
      for await hubs in Discovery.scan() { found = hubs }
    }
    .task(id: invite) {
      if let invite { run { await pairing.withInvite(invite, onState: report) } }
    }
  }

  @ViewBuilder private var status: some View {
    switch state {
    case .working?: ProgressView()
    case .awaitingApproval(let code)?:
      VStack {
        Text(L("add_waiting")).font(.headline).multilineTextAlignment(.center)
        Text(code).font(.system(size: 44, weight: .bold, design: .monospaced))
      }
      .accessibilityElement(children: .combine)
    case .failed(let code, let message)?:
      Text(failText(code, message)).foregroundStyle(c.danger).multilineTextAlignment(.center)
    default: EmptyView()
    }
  }

  private func run(_ f: @escaping @Sendable () async -> PairState) {
    job?.cancel()
    job = Task {
      let r = await f()
      ui.apply(r)
      if case .paired(let h) = r { model.paired(h) }
    }
  }
}

@MainActor @Observable
final class PairUI {
  var state: PairState?

  func apply(_ s: PairState) {
    state = s
    if case .awaitingApproval = s { UIAccessibility.post(notification: .announcement, argument: L("add_waiting")) }
    if case .failed(let code, let m) = s { UIAccessibility.post(notification: .announcement, argument: failText(code, m)) }
  }
}

func failText(_ code: String, _ message: String) -> String {
    switch code {
    case "offline": return L("err_offline")
    case "not_vatra": return L("err_not_vatra")
    case "too_old": return L("update_app")
    case "rejected": return L("err_rejected")
    case "expired": return L("err_expired")
    case "bad_address": return L("err_address")
    default: return message.isEmpty ? L("err_generic", code) : message
    }
}
