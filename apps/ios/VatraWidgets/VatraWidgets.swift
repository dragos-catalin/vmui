import ActivityKit
import AppIntents
import SwiftUI
import VatraCore
import WidgetKit

@main
struct VatraWidgetBundle: WidgetBundle {
  var body: some Widget {
    HouseWidget()
    MovieLightsControl()
    DeviceControl()
    IntercomLiveActivity()
  }
}

// MARK: house widget (Home Screen / Lock Screen), interactive (+ glass, lights off)

struct GlanceEntry: TimelineEntry {
  let date: Date
  let glance: Glance
}

struct GlanceProvider: TimelineProvider {
  func placeholder(in context: Context) -> GlanceEntry {
    GlanceEntry(date: .now, glance: Glance(lightsOn: 3, waterMl: 1000, waterTarget: 2500, hubName: "Vatra"))
  }

  func getSnapshot(in context: Context, completion: @escaping @Sendable (GlanceEntry) -> Void) {
    completion(GlanceEntry(date: .now, glance: Glance.load()))
  }

  func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<GlanceEntry>) -> Void) {
    Task {
      let g = await Glance.refresh() ?? Glance.load()
      completion(Timeline(entries: [GlanceEntry(date: .now, glance: g)], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
  }
}

struct HouseWidgetView: View {
  let entry: GlanceEntry
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let c = VatraColors.of(scheme)
    let g = entry.glance
    switch family {
    case .accessoryCircular:
      Gauge(value: Double(g.waterMl ?? 0), in: 0...Double(max(g.waterTarget ?? 2500, 1))) {
        Image(systemName: "drop.fill")
      } currentValueLabel: {
        Text("\(g.lightsOn ?? 0)")
      }
      .gaugeStyle(.accessoryCircularCapacity)
      .accessibilityLabel(L("widget_lights", g.lightsOn ?? 0))
    case .accessoryRectangular:
      VStack(alignment: .leading) {
        Text(g.hubName ?? L("app_name")).font(.headline)
        Text(L("widget_lights", g.lightsOn ?? 0))
        if let ml = g.waterMl, let t = g.waterTarget { Text(L("water_progress", ml, t)) }
      }
    default:
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          VatraMarkView(size: 20, line: c.fg, flame: c.primary, core: c.lit)
          Text(g.hubName ?? L("app_name")).font(.headline).lineLimit(1)
        }
        Text(L("widget_lights", g.lightsOn ?? 0)).font(.subheadline)
        if let ml = g.waterMl, let t = g.waterTarget {
          ProgressView(value: Double(ml), total: Double(max(t, 1)))
          Text(L("water_progress", ml, t)).font(.caption).foregroundStyle(c.fgMuted)
        }
        Spacer(minLength: 0)
        HStack {
          Button(intent: HouseActionIntent(.water)) { Label(L("water_drink"), systemImage: "drop") }
          Button(intent: HouseActionIntent(.lightsOff)) { Label(L("ambilight_off"), systemImage: "lightbulb.slash") }
        }
        .font(.caption)
        .labelStyle(.iconOnly)
        .buttonStyle(.bordered)
      }
      .containerBackground(c.surface, for: .widget)
    }
  }
}

struct HouseWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "ro.vatra.house", provider: GlanceProvider()) { e in
      HouseWidgetView(entry: e).vatraThemed().containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName(L("widget_label"))
    .description(L("widget_description"))
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
  }
}

// MARK: Control Center / Lock Screen / Action button controls (iOS 18)

struct MovieLightsControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "ro.vatra.control.movie") {
      ControlWidgetButton(action: HouseActionIntent(.movie)) {
        Label(L("tile_label"), systemImage: "tv")
      }
    }
    .displayName(LocalizedStringResource("tile_label"))
  }
}

struct DeviceValue {
  var on: Bool
  var device: DeviceEntity?
}

struct DeviceControlProvider: AppIntentControlValueProvider {
  func previewValue(configuration: SelectDeviceIntent) -> DeviceValue { DeviceValue(on: false, device: configuration.device) }

  func currentValue(configuration: SelectDeviceIntent) async throws -> DeviceValue {
    guard let id = configuration.device?.id else { return DeviceValue(on: false, device: nil) }
    let g = await Glance.refresh() ?? Glance.load()
    return DeviceValue(on: g.devices.first { $0.entity == id }?.on ?? false, device: configuration.device)
  }
}

/// Which device a Control Center toggle switches (chosen when the control is added).
struct SelectDeviceIntent: ControlConfigurationIntent {
  static let title: LocalizedStringResource = "entity.device"
  @Parameter(title: "entity.device") var device: DeviceEntity?
  init() {}
}

struct DeviceControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: "ro.vatra.control.device", provider: DeviceControlProvider()) { v in
      ControlWidgetToggle(isOn: v.on, action: v.device.map(SetDeviceIntent.init(device:)) ?? SetDeviceIntent()) {
        Label(v.device?.name ?? L("entity.device"), systemImage: "lightbulb")
      } valueLabel: { on in
        Label(on ? L("state_on") : L("state_off"), systemImage: on ? "lightbulb.fill" : "lightbulb")
      }
    }
    .displayName(LocalizedStringResource("entity.device"))
    .promptsForUserConfiguration()
  }
}

// MARK: intercom Live Activity (Lock Screen + Dynamic Island), started by the hub's push-to-start

struct IntercomLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: IntercomAttributes.self) { ctx in
      IntercomBanner(attrs: ctx.attributes, state: ctx.state).padding().vatraThemed()
    } dynamicIsland: { ctx in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Image(systemName: "bell.and.waves.left.and.right.fill").font(.title2) }
        DynamicIslandExpandedRegion(.center) { Text(L("door_ringing")).font(.headline) }
        DynamicIslandExpandedRegion(.bottom) { IntercomButtons(attrs: ctx.attributes, state: ctx.state) }
      } compactLeading: {
        Image(systemName: "bell.fill")
      } compactTrailing: {
        Text(Date(timeIntervalSince1970: TimeInterval(ctx.state.since)), style: .timer).monospacedDigit().frame(width: 40)
      } minimal: {
        Image(systemName: "bell.fill")
      }
    }
  }
}

struct IntercomBanner: View {
  let attrs: IntercomAttributes
  let state: IntercomAttributes.ContentState
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Image(systemName: "bell.and.waves.left.and.right.fill")
        Text(L("door_ringing")).font(.headline)
        Spacer()
        Text(Date(timeIntervalSince1970: TimeInterval(state.since)), style: .relative).font(.caption)
      }
      if !attrs.door.isEmpty { Text(attrs.door).font(.subheadline) }
      IntercomButtons(attrs: attrs, state: state)
    }
  }
}

struct IntercomButtons: View {
  let attrs: IntercomAttributes
  let state: IntercomAttributes.ContentState
  var body: some View {
    HStack {
      if state.canOpen {
        Button(intent: OpenDoorIntent(cardId: attrs.cardId)) { Label(L("door_open"), systemImage: "door.left.hand.open") }
          .buttonStyle(.borderedProminent)
      }
      Button(intent: HouseActionIntent(.doorIgnore)) { Label(L("door_ignore"), systemImage: "bell.slash") }
        .buttonStyle(.bordered)
    }
  }
}
