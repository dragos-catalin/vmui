import Foundation

/// The absolute SVG path subset the brand mark uses (M L H V Q C Z), parsed once so SwiftUI / CoreGraphics
/// draw the mark from the same geometry strings as the web, desktop and Android logos.
public enum PathOp: Sendable, Equatable {
  case move(Double, Double)
  case line(Double, Double)
  case quad(Double, Double, Double, Double)
  case cubic(Double, Double, Double, Double, Double, Double)
  case close
}

public enum SVGPath {
  public static func parse(_ d: String) -> [PathOp] {
    var tokens: [String] = []
    var cur = ""
    func flush() { if !cur.isEmpty { tokens.append(cur); cur = "" } }
    for ch in d {
      if ch.isLetter && ch != "e" && ch != "E" {
        flush(); tokens.append(String(ch))
      } else if ch == " " || ch == "," {
        flush()
      } else if ch == "-" && !cur.isEmpty && cur.last != "e" && cur.last != "E" {
        flush(); cur.append(ch)
      } else {
        cur.append(ch)
      }
    }
    flush()
    var ops: [PathOp] = []
    var i = 0
    var cmd = ""
    var x = 0.0, y = 0.0
    func num() -> Double? {
      guard i < tokens.count, let v = Double(tokens[i]) else { return nil }
      i += 1
      return v
    }
    while i < tokens.count {
      if Double(tokens[i]) == nil { cmd = tokens[i]; i += 1 }
      switch cmd {
      case "M": guard let a = num(), let b = num() else { return ops }; x = a; y = b; ops.append(.move(a, b)); cmd = "L"
      case "L": guard let a = num(), let b = num() else { return ops }; x = a; y = b; ops.append(.line(a, b))
      case "H": guard let a = num() else { return ops }; x = a; ops.append(.line(a, y))
      case "V": guard let b = num() else { return ops }; y = b; ops.append(.line(x, b))
      case "Q":
        guard let a = num(), let b = num(), let c = num(), let e = num() else { return ops }
        x = c; y = e; ops.append(.quad(a, b, c, e))
      case "C":
        guard let a = num(), let b = num(), let c = num(), let e = num(), let f = num(), let g = num() else { return ops }
        x = f; y = g; ops.append(.cubic(a, b, c, e, f, g))
      case "Z", "z": ops.append(.close); cmd = ""
      default: return ops
      }
    }
    return ops
  }
}
