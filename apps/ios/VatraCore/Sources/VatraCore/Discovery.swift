import Foundation
import Network

/// A hub advertising `_vatra._tcp` (pi/avahi-vmui.service, deploy/vatra hub-install.sh).
public struct DiscoveredHub: Sendable, Equatable, Identifiable {
  public let name: String
  public let host: String
  public let port: Int
  public var id: String { name }

  public init(name: String, host: String, port: Int) { self.name = name; self.host = host; self.port = port }

  public var baseUrl: String {
    let h = host.contains(":") ? "[\(host)]" : host
    return "http://\(h)\(port == 80 ? "" : ":\(port)")"
  }
}

/// Finds hubs on this network over Bonjour and resolves each to an address (needs NSBonjourServices +
/// NSLocalNetworkUsageDescription in the app's Info.plist). Stops browsing when the stream ends.
public enum Discovery {
  public static let serviceType = "_vatra._tcp"

  public static func scan() -> AsyncStream<[DiscoveredHub]> {
    AsyncStream { cont in
      let q = DispatchQueue(label: "vatra.discovery")
      let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: .tcp)
      let found = Found()
      browser.browseResultsChangedHandler = { results, _ in
        let names = Set(results.compactMap { r -> String? in
          if case .service(let n, _, _, _) = r.endpoint { return n }
          return nil
        })
        found.keep(names)
        cont.yield(found.all)
        for r in results {
          guard case .service(let name, _, _, _) = r.endpoint, !found.has(name) else { continue }
          resolve(r.endpoint, name: name, on: q) { hub in
            found.put(hub)
            cont.yield(found.all)
          }
        }
      }
      browser.start(queue: q)
      cont.onTermination = { _ in browser.cancel() }
    }
  }

  private static func resolve(_ ep: NWEndpoint, name: String, on q: DispatchQueue, done: @escaping @Sendable (DiscoveredHub) -> Void) {
    let conn = NWConnection(to: ep, using: .tcp)
    conn.stateUpdateHandler = { st in
      switch st {
      case .ready:
        if case .hostPort(let host, let port) = conn.currentPath?.remoteEndpoint {
          var h = "\(host)"
          if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
          done(DiscoveredHub(name: name, host: h, port: Int(port.rawValue)))
        }
        conn.cancel()
      case .failed, .waiting: conn.cancel()
      default: break
      }
    }
    conn.start(queue: q)
  }

  private final class Found: @unchecked Sendable {
    private var map: [String: DiscoveredHub] = [:]
    private let lock = NSLock()
    var all: [DiscoveredHub] { lock.withLock { map.values.sorted { $0.name < $1.name } } }
    func has(_ n: String) -> Bool { lock.withLock { map[n] != nil } }
    func put(_ h: DiscoveredHub) { lock.withLock { map[h.name] = h } }
    func keep(_ names: Set<String>) { lock.withLock { map = map.filter { names.contains($0.key) } } }
  }
}
