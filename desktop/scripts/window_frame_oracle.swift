// 実フレームのオラクル: meet-jerky の各ウィンドウが「画面上で実際に」どのサイズ・位置に
// あるかを CGWindowListCopyWindowInfo で取得し、Tauri の報告値（outer_size/outer_position）と
// 突き合わせるためのデバッグツール。`swift scripts/window_frame_oracle.swift` で実行する。
//
// 注意: kCGWindowBounds と owner 名は画面収録権限なしで取得できる。kCGWindowName(タイトル)は
// 権限が無いと空になり得るため、識別は owner＋サイズ＋layer で行う前提にしている。
import AppKit
import CoreGraphics
import Foundation

// ディスプレイの論理フレーム(ポイント)と backing scale を出す。期待中央配置の基準。
for (i, screen) in NSScreen.screens.enumerated() {
    let f = screen.frame
    print(
        "DISPLAY[\(i)] frame=(\(f.origin.x),\(f.origin.y),\(f.size.width),\(f.size.height)) "
            + "scale=\(screen.backingScaleFactor)")
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write(Data("failed to copy window list\n".utf8))
    exit(1)
}

var matched = 0
for window in list {
    let owner = (window[kCGWindowOwnerName as String] as? String) ?? ""
    guard owner.lowercased().contains("meet") else { continue }
    matched += 1
    let name = (window[kCGWindowName as String] as? String) ?? ""
    let layer = (window[kCGWindowLayer as String] as? Int) ?? -999
    var x = 0.0, y = 0.0, w = 0.0, h = 0.0
    if let bounds = window[kCGWindowBounds as String] as? [String: Any] {
        x = (bounds["X"] as? Double) ?? 0
        y = (bounds["Y"] as? Double) ?? 0
        w = (bounds["Width"] as? Double) ?? 0
        h = (bounds["Height"] as? Double) ?? 0
    }
    print("WINDOW owner=\(owner) name=\"\(name)\" layer=\(layer) frame=(\(x),\(y),\(w),\(h))")
}

if matched == 0 {
    print("WINDOW (none matching 'meet' owner)")
}
