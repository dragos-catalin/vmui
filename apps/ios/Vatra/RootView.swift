import SwiftUI
import VatraCore

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.vatra) private var c

  var body: some View {
    @Bindable var m = model
    Group {
      if model.hub == nil || model.adding {
        AddHubScreen(invite: model.pendingInvite, canCancel: model.hub != nil)
      } else {
        TabView(selection: $m.tab) {
          content { HomeScreen() }
            .tabItem { Label(L("tab_home"), systemImage: "house") }
            .tag(Tab.home)
          content { LightsScreen() }
            .tabItem { Label(L("tab_lights"), systemImage: "lightbulb") }
            .tag(Tab.lights)
          content { AlertsScreen() }
            .tabItem { Label(L("tab_alerts"), systemImage: "bell") }
            .badge(model.unread)
            .tag(Tab.alerts)
          SettingsScreen()
            .tabItem { Label(L("tab_settings"), systemImage: "gearshape") }
            .tag(Tab.settings)
        }
      }
    }
    .alert(model.message ?? "", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
      Button(L("ok"), role: .cancel) {}
    }
    .task { model.start() }
  }

  @ViewBuilder private func content<V: View>(@ViewBuilder _ v: () -> V) -> some View {
    if model.tooOld {
      ContentUnavailableView(L("update_app"), systemImage: "arrow.down.app")
    } else if model.loading {
      ProgressView().accessibilityLabel(L("loading"))
    } else {
      v()
    }
  }
}
