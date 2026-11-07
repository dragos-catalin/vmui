@preconcurrency import UserNotifications
import VatraCore

/// Runs for every visible push (mutable-content). Turns the hub's card into the notification the member sees:
/// fetches the full card when the payload was trimmed, attaches the card's own action buttons (dynamic
/// category), and groups by card tag so a re-sent card replaces itself. Never shows more than the push said
/// when the hub is unreachable. A push through the Vatra Cloud relay carries only `vatra.e` (the card,
/// AES-GCM with this device's key); the alert stays the localised generic one (VATRA_PUSH_TITLE_<KIND>)
/// unless the card decrypts here.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private var handler: ((UNNotificationContent) -> Void)?
  private var best: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
    best = content
    let relayed = PushPayload.relayEnvelope(content.userInfo) != nil
    guard let got = VatraEnv.push(content.userInfo) else { return contentHandler(content) }
    let p = got.payload, client = got.client
    let box = Handoff(content: content, handler: contentHandler)
    Task {
      let content = box.content
      var actions = p.actions
      if relayed && !p.needsFetch {
        if !p.title.isEmpty { content.title = p.title }
        content.body = p.body.isEmpty ? " " : p.body
        content.subtitle = p.subtitle
      }
      if p.needsFetch, let c = client, let card = await Self.fetch(p.id, client: c, relayed: relayed) {
        content.title = card.title
        content.body = card.body.isEmpty ? " " : card.body
        if let s = card.subtitle { content.subtitle = s }
        actions = card.actions
      } else if p.needsFetch, relayed, !p.title.isEmpty {
        content.title = p.title
      }
      content.threadIdentifier = p.threadKey
      content.categoryIdentifier = await Self.category(for: p, actions: actions)
      if p.isIntercomRing { content.interruptionLevel = .timeSensitive }
      box.handler(content)
    }
  }

  /// Relay hubs answer GET /api/v1/app/push/card; older hubs only have the notify list.
  static func fetch(_ id: String, client c: HubClient, relayed: Bool) async -> Card? {
    if relayed, let card = await c.pushCard(id: id).value { return card }
    return await c.cards(all: true).value?.cards.first(where: { $0.id == id })
  }

  /// A category per distinct action set: buttons are the card's own labels (already localised by the hub).
  static func category(for p: PushPayload, actions: [CardAction]) async -> String {
    guard !actions.isEmpty else { return p.category }
    let id = "\(p.category).\(actions.map(\.id).joined(separator: "+"))"
    let buttons = actions.prefix(4).map { a in
      UNNotificationAction(
        identifier: "vatra.\(a.id)", title: a.label,
        options: a.id == "open" ? [.authenticationRequired] : a.style == "danger" ? [.destructive] : a.url != nil ? [.foreground] : [])
    }
    let center = UNUserNotificationCenter.current()
    var cats = await center.notificationCategories()
    if !cats.contains(where: { $0.identifier == id }) {
      cats.insert(UNNotificationCategory(identifier: id, actions: Array(buttons), intentIdentifiers: [], options: [.customDismissAction]))
      center.setNotificationCategories(cats)
    }
    return id
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler, let best { handler(best) }
  }
}

/// The content and handler cross into the fetch task once; the system serialises the callbacks.
private struct Handoff: @unchecked Sendable {
  let content: UNMutableNotificationContent
  let handler: (UNNotificationContent) -> Void
}
