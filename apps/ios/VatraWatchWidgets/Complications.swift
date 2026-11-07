import SwiftUI
import VatraCore
import WidgetKit

/// Watch face complications: lights on and water today, from the watch's own hub token.
@main
struct VatraWatchWidgetBundle: WidgetBundle {
  var body: some Widget { HouseComplication() }
}

struct ComplicationEntry: TimelineEntry {
  let date: Date
  let glance: Glance
}

struct ComplicationProvider: TimelineProvider {
  func placeholder(in context: Context) -> ComplicationEntry { ComplicationEntry(date: .now, glance: Glance(lightsOn: 2, waterMl: 1000, waterTarget: 2500)) }
  func getSnapshot(in context: Context, completion: @escaping @Sendable (ComplicationEntry) -> Void) {
    completion(ComplicationEntry(date: .now, glance: Glance.load()))
  }
  func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<ComplicationEntry>) -> Void) {
    Task {
      let g = await Glance.refresh() ?? Glance.load()
      completion(Timeline(entries: [ComplicationEntry(date: .now, glance: g)], policy: .after(.now.addingTimeInterval(20 * 60))))
    }
  }
}

struct ComplicationView: View {
  let entry: ComplicationEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
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
    case .accessoryCorner:
      Image(systemName: "lightbulb.fill").widgetLabel(L("widget_lights", g.lightsOn ?? 0))
    case .accessoryInline:
      Text(L("widget_lights", g.lightsOn ?? 0))
    default:
      VStack(alignment: .leading) {
        Text(g.hubName ?? L("app_name")).font(.headline)
        Text(L("widget_lights", g.lightsOn ?? 0))
        if let ml = g.waterMl, let t = g.waterTarget { Text(L("water_progress", ml, t)) }
      }
    }
  }
}

struct HouseComplication: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "ro.vatra.watch.house", provider: ComplicationProvider()) { e in
      ComplicationView(entry: e).containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName(L("widget_label"))
    .description(L("widget_description"))
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
  }
}
