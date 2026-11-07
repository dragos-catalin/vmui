import SwiftUI
import VatraCore

extension Color {
  init(rgb: UInt32) {
    self.init(red: Double(rgb >> 16 & 0xFF) / 255, green: Double(rgb >> 8 & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
  }
}

/// Brand semantic colours (brand/tokens via brand/scripts/emit-swift.mjs) resolved for the current appearance.
struct VatraColors {
  let p: VatraPalette
  var bg: Color { Color(rgb: p.bg) }
  var surface: Color { Color(rgb: p.surface) }
  var surface2: Color { Color(rgb: p.surface2) }
  var fg: Color { Color(rgb: p.fg) }
  var fgMuted: Color { Color(rgb: p.fgMuted) }
  var primary: Color { Color(rgb: p.primary) }
  var primaryFg: Color { Color(rgb: p.primaryFg) }
  var primaryText: Color { Color(rgb: p.primaryText) }
  var lit: Color { Color(rgb: p.lit) }
  var danger: Color { Color(rgb: p.danger) }
  var success: Color { Color(rgb: p.success) }
  var border: Color { Color(rgb: p.border) }

  static func of(_ scheme: ColorScheme) -> VatraColors { VatraColors(p: scheme == .dark ? .dark : .light) }
}

private struct VatraColorsKey: EnvironmentKey {
  static let defaultValue = VatraColors(p: .light)
}

extension EnvironmentValues {
  var vatra: VatraColors {
    get { self[VatraColorsKey.self] }
    set { self[VatraColorsKey.self] = newValue }
  }
}

/// Applies the brand palette for the system appearance, tints controls with the brand primary.
struct VatraThemed: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  func body(content: Content) -> some View {
    let c = VatraColors.of(scheme)
    content.environment(\.vatra, c).tint(c.primary)
  }
}

extension View {
  func vatraThemed() -> some View { modifier(VatraThemed()) }
}

extension Path {
  init(svg d: String) {
    self.init()
    for op in SVGPath.parse(d) {
      switch op {
      case .move(let x, let y): move(to: CGPoint(x: x, y: y))
      case .line(let x, let y): addLine(to: CGPoint(x: x, y: y))
      case .quad(let cx, let cy, let x, let y): addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
      case .cubic(let ax, let ay, let bx, let by, let x, let y):
        addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: ax, y: ay), control2: CGPoint(x: bx, y: by))
      case .close: closeSubpath()
      }
    }
  }
}

/// The Vatra mark drawn from the same geometry as the web, desktop and Android logos, never a raster.
struct VatraMarkView: View {
  var size: CGFloat
  var line: Color
  var flame: Color
  var core: Color

  var body: some View {
    let g = VatraMarks.optical(for: Double(size))
    Canvas { ctx, sz in
      let b = g.bbox
      let w = b[1] - b[0], h = b[3] - b[2]
      let k = min(sz.width / w, sz.height / h)
      ctx.translateBy(x: -b[0] * k + (sz.width - w * k) / 2, y: -b[2] * k + (sz.height - h * k) / 2)
      ctx.scaleBy(x: k, y: k)
      let stroke = StrokeStyle(lineWidth: g.stroke, lineCap: .round, lineJoin: .round)
      ctx.stroke(Path(svg: g.roof), with: .color(line), style: stroke)
      ctx.stroke(Path(svg: g.walls), with: .color(line), style: stroke)
      ctx.fill(Path(svg: g.flame), with: .color(flame))
      if let c = g.core { ctx.fill(Path(svg: c), with: .color(core)) }
      let alpha = [0.95, 0.7, 0.45]
      for (i, p) in g.puffs.enumerated() {
        let r = CGRect(x: p.cx - p.r, y: p.cy - p.r, width: p.r * 2, height: p.r * 2)
        ctx.fill(Path(ellipseIn: r), with: .color(line.opacity(i < alpha.count ? alpha[i] : 0.45)))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
