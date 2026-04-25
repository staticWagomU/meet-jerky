// macOS privacy permission checks exposed to Rust through a small C ABI.

import AVFoundation
import CoreGraphics
import Foundation

private enum PermissionStatus: Int32 {
    case undetermined = 0
    case denied = 1
    case granted = 2
}

@_cdecl("meet_jerky_microphone_permission_status")
public func meet_jerky_microphone_permission_status() -> Int32 {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return PermissionStatus.granted.rawValue
    case .notDetermined:
        return PermissionStatus.undetermined.rawValue
    case .denied, .restricted:
        return PermissionStatus.denied.rawValue
    @unknown default:
        return PermissionStatus.denied.rawValue
    }
}

@_cdecl("meet_jerky_screen_recording_permission_status")
public func meet_jerky_screen_recording_permission_status() -> Int32 {
    CGPreflightScreenCaptureAccess()
        ? PermissionStatus.granted.rawValue
        : PermissionStatus.denied.rawValue
}
