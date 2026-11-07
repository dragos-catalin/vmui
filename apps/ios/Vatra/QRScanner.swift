import AVFoundation
import SwiftUI
import UIKit

/// Camera preview that reports QR payloads; the caller decides what is a valid Vatra invite.
struct QRScanner: UIViewRepresentable {
  let onCode: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

  func makeUIView(context: Context) -> PreviewView {
    let v = PreviewView()
    context.coordinator.attach(to: v)
    return v
  }

  func updateUIView(_ uiView: PreviewView, context: Context) {}

  static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) { coordinator.stop() }

  final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }

  final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let onCode: (String) -> Void
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "vatra.qr")

    init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

    @MainActor func attach(to v: PreviewView) {
      v.preview.session = session
      v.preview.videoGravity = .resizeAspectFill
      AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
        guard ok, let self else { return }
        self.queue.async { self.configure() }
      }
    }

    private func configure() {
      guard let cam = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: cam), session.canAddInput(input) else { return }
      session.beginConfiguration()
      session.addInput(input)
      let out = AVCaptureMetadataOutput()
      if session.canAddOutput(out) {
        session.addOutput(out)
        out.setMetadataObjectsDelegate(self, queue: .main)
        out.metadataObjectTypes = [.qr]
      }
      session.commitConfiguration()
      session.startRunning()
    }

    func stop() { queue.async { self.session.stopRunning() } }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
      for o in objects {
        if let s = (o as? AVMetadataMachineReadableCodeObject)?.stringValue { onCode(s) }
      }
    }
  }
}
