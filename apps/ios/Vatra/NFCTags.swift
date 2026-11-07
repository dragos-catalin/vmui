@preconcurrency import CoreNFC
import Foundation
import VatraCore

/// House-action stickers: a `vatra://do?…` URI record (same format the Android app writes), so a tag written
/// on either phone works on both. Reading happens through iOS background tag reading, which opens the URL
/// in the app (AppModel.open). The tag holds no secret.
enum NFCTags {
  static var available: Bool { NFCNDEFReaderSession.readingAvailable }

  nonisolated(unsafe) private static var writer: Writer?

  static func write(_ a: QuickAction, done: @escaping @Sendable (Bool) -> Void) {
    guard let payload = NFCNDEFPayload.wellKnownTypeURIPayload(string: a.uri) else { return done(false) }
    let w = Writer(message: NFCNDEFMessage(records: [payload]), done: done)
    writer = w
    w.begin()
  }

  final class Writer: NSObject, NFCNDEFReaderSessionDelegate, @unchecked Sendable {
    let message: NFCNDEFMessage
    let done: @Sendable (Bool) -> Void
    var session: NFCNDEFReaderSession?

    init(message: NFCNDEFMessage, done: @escaping @Sendable (Bool) -> Void) { self.message = message; self.done = done }

    func begin() {
      session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
      session?.alertMessage = L("nfc_hold")
      session?.begin()
    }

    func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {}
    func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {}

    func readerSession(_ session: NFCNDEFReaderSession, didDetect tags: [NFCNDEFTag]) {
      guard let tag = tags.first else { return }
      // CoreNFC calls back on the session's queue; session and tag are only touched from there.
      let io = TagIO(session: session, tag: tag)
      io.session.connect(to: io.tag) { err in
        if err != nil { return self.finish(io.session, false) }
        io.tag.queryNDEFStatus { status, _, _ in
          guard status == .readWrite else { return self.finish(io.session, false) }
          io.tag.writeNDEF(self.message) { e in self.finish(io.session, e == nil) }
        }
      }
    }

    private func finish(_ s: NFCNDEFReaderSession, _ ok: Bool) {
      if ok { s.alertMessage = L("nfc_written"); s.invalidate() } else { s.invalidate(errorMessage: L("nfc_failed")) }
      done(ok)
    }
  }
}

private struct TagIO: @unchecked Sendable {
  let session: NFCNDEFReaderSession
  let tag: NFCNDEFTag
}
