@preconcurrency import UserNotifications
import VatraCore

/// Runs for every visible push (mutable-content). Turns the hub's card into the notification the member sees:
/// fetches the full card when the payload was trimmed, attaches the card's own action buttons (dynamic
/// category), and groups by card tag so a re-sent card replaces itself. Never shows more than the push said
/// when the hub is unreachable.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private var handler: ((UNNotificationContent) -> Void)?
  private var best: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
    best = content
    guard let p = PushPayload.from(userInfo: content.userInfo) else { return contentHandler(content) }
    let box = Handoff(content: content, handler: contentHandler)
    Task {
      let content = box.content
      var actions = p.actions
      if p.needsFetch, let c = VatraEnv.activeClient(), let card = await c.cards(all: true).value?.cards.first(where: { $0.id == p.id }) {
        content.title = card.title
        content.body = card.body.isEmpty ? " " : card.body
        if let s = card.subtitle { content.subtitle = s }
        actions = card.actions
      }
      content.threadIdentifier = p.threadKey
      content.categoryIdentifier = await Self.category(for: p, actions: actions)
      if p.isIntercomRing { content.interruptionLevel = .timeSensitive }
      box.handler(content)
    }
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
