// macOS status-window positioning helpers exposed to Rust through a small C ABI.
//
// Tauri's tray rect is not stable enough for a menu-bar popover on multi-monitor
// macOS setups. Use AppKit/Quartz as the source of truth: pick the NSScreen under
// the current mouse location, then convert its CGDisplay bounds to Tauri's
// physical coordinate space.

import AppKit
import CoreGraphics
import Foundation

@_cdecl("meet_jerky_status_anchor_position")
public func meet_jerky_status_anchor_position(
    _ windowWidth: Double,
    _ windowHeight: Double,
    _ rightInset: Double,
    _ topOffset: Double,
    _ outX: UnsafeMutablePointer<Double>?,
    _ outY: UnsafeMutablePointer<Double>?
) -> Bool {
    guard let outX = outX, let outY = outY else {
        return false
    }

    let mouseLocation = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { screen in
        NSMouseInRect(mouseLocation, screen.frame, false)
    } ?? NSScreen.main

    guard
        let screen = screen,
        let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
            as? NSNumber
    else {
        return false
    }

    let displayId = CGDirectDisplayID(screenNumber.uint32Value)
    let bounds = CGDisplayBounds(displayId)
    let scale = screen.backingScaleFactor

    let screenX = bounds.origin.x * scale
    let screenY = bounds.origin.y * scale
    let screenWidth = bounds.width * scale
    let screenHeight = bounds.height * scale
    let clampedWindowWidth = max(1.0, min(windowWidth, screenWidth))
    let clampedWindowHeight = max(1.0, min(windowHeight, screenHeight))

    let targetX = screenX + screenWidth - clampedWindowWidth - (rightInset * scale)
    let targetY = screenY + (topOffset * scale)
    outX.pointee = min(max(targetX, screenX), screenX + max(0.0, screenWidth - clampedWindowWidth))
    outY.pointee = min(max(targetY, screenY), screenY + max(0.0, screenHeight - clampedWindowHeight))
    return true
}
