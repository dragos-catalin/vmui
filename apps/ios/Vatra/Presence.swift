import CoreLocation
import Foundation
import Observation
import VatraCore

/// Arrive / leave home with a 150 m region around where the phone is when the member turns this on
/// (they are at home then). Region monitoring relaunches the app in the background on a crossing; only
/// "home" or "away" leaves the phone (POST /api/v1/app/presence), never coordinates. Same as Android P7-05.
@MainActor @Observable
final class Presence: NSObject, CLLocationManagerDelegate {
  static let shared = Presence()
  nonisolated private static let regionId = "vatra.home"
  private let lm = CLLocationManager()
  private var wantOn = false
  var enabled: Bool
  var denied = false

  override init() {
    enabled = VatraEnv.group.bool(forKey: "presence.on")
    super.init()
    lm.delegate = self
  }

  func setEnabled(_ on: Bool) {
    if !on {
      for r in lm.monitoredRegions where r.identifier == Self.regionId { lm.stopMonitoring(for: r) }
      enabled = false
      VatraEnv.group.set(false, forKey: "presence.on")
      return
    }
    wantOn = true
    switch lm.authorizationStatus {
    case .notDetermined: lm.requestWhenInUseAuthorization()
    case .authorizedWhenInUse: lm.requestAlwaysAuthorization()
    case .authorizedAlways: lm.requestLocation()
    default: denied = true
    }
  }

  nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
    Task { @MainActor in
      guard wantOn else { return }
      switch lm.authorizationStatus {
      case .authorizedWhenInUse: lm.requestAlwaysAuthorization()
      case .authorizedAlways: denied = false; lm.requestLocation()
      case .denied, .restricted: denied = true; wantOn = false
      default: break
      }
    }
  }

  nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let here = locations.last?.coordinate else { return }
    Task { @MainActor in
      guard wantOn else { return }
      wantOn = false
      let region = CLCircularRegion(center: here, radius: 150, identifier: Self.regionId)
      region.notifyOnEntry = true
      region.notifyOnExit = true
      lm.startMonitoring(for: region)
      enabled = true
      VatraEnv.group.set(true, forKey: "presence.on")
    }
  }

  nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}

  nonisolated func locationManager(_ m: CLLocationManager, didEnterRegion region: CLRegion) { report(region, "home") }
  nonisolated func locationManager(_ m: CLLocationManager, didExitRegion region: CLRegion) { report(region, "away") }

  nonisolated private func report(_ region: CLRegion, _ state: String) {
    guard region.identifier == Self.regionId else { return }
    Task { _ = await VatraEnv.activeClient()?.presence(state: state, source: "geofence") }
  }
}
