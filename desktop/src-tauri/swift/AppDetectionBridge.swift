// Zoom / Microsoft Teams など、ローカルにインストールされた会議アプリの
// 起動を検知するための Swift ブリッジ。
//
// アーキテクチャ:
// - Rust 側が watch 対象の Bundle ID 一覧 (JSON) を渡して
//   `meet_jerky_app_detection_start` を呼ぶ。
// - Swift 側は `NSWorkspace.didLaunchApplicationNotification` を購読し、
//   一致する Bundle ID が起動するたびに Rust の C コールバックを呼ぶ。
// - 既に起動中のアプリは重複検知を避けるため通知しない (起動イベントのみ)。
//
// ライフサイクル:
// - シングルトン `AppDetector.instance` で Observer の所有権を保持する。
// - `meet_jerky_app_detection_stop` で観察を解除。

import AppKit
import Foundation

/// C 側で書かれた関数ポインタの型シグネチャ。
/// (bundleId, appName, userData) の順で呼ばれる。文字列は Swift 側スコープ内で
/// 有効な C ポインタなので、Rust 側はコールバック内で複製して使う必要がある。
public typealias MeetJerkyAppDetectionCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafeMutableRawPointer?
) -> Void

@available(macOS 11.0, *)
public final class AppDetector: @unchecked Sendable {
    private static let lock = NSLock()
    private static var instance: AppDetector?

    private let watchedBundleIds: Set<String>
    private let callback: MeetJerkyAppDetectionCallback
    private let userData: UnsafeMutableRawPointer?
    private var observers: [NSObjectProtocol] = []

    private init(
        bundleIds: [String],
        callback: @escaping MeetJerkyAppDetectionCallback,
        userData: UnsafeMutableRawPointer?
    ) {
        self.watchedBundleIds = Set(bundleIds)
        self.callback = callback
        self.userData = userData
    }

    public static func start(
        bundleIds: [String],
        callback: @escaping MeetJerkyAppDetectionCallback,
        userData: UnsafeMutableRawPointer?
    ) {
        lock.lock()
        instance?.stopInternal()
        let detector = AppDetector(
            bundleIds: bundleIds,
            callback: callback,
            userData: userData
        )
        instance = detector
        lock.unlock()

        detector.installObservers()
    }

    public static func stop() {
        lock.lock()
        instance?.stopInternal()
        instance = nil
        lock.unlock()
    }

    private func installObservers() {
        let nc = NSWorkspace.shared.notificationCenter

        let didLaunch = nc.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification,
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard
                let self = self,
                let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                    as? NSRunningApplication
            else { return }
            self.handle(app: app)
        }
        observers.append(didLaunch)
    }

    private func handle(app: NSRunningApplication) {
        guard let bundleId = app.bundleIdentifier else { return }
        if !watchedBundleIds.contains(bundleId) { return }
        let name = app.localizedName ?? bundleId
        let cb = callback
        let ud = userData

        bundleId.withCString { bundleCstr in
            name.withCString { nameCstr in
                cb(bundleCstr, nameCstr, ud)
            }
        }
    }

    private func stopInternal() {
        let nc = NSWorkspace.shared.notificationCenter
        for o in observers {
            nc.removeObserver(o)
        }
        observers.removeAll()
    }
}

// ─────────────────────────────────────────────
// C ABI
// ─────────────────────────────────────────────

/// 観察を開始する。
///
/// - `bundleIdsJson`: `["us.zoom.xos","com.microsoft.teams2"]` のような JSON 配列文字列
/// - `callback`: 検知時に呼ばれる C 関数ポインタ
/// - `userData`: コールバックに透過的に渡される任意ポインタ (Rust 側 AppHandle 等)
///
/// 戻り値:
/// - `0`: 開始成功
/// - `-1`: JSON パース失敗
/// - `-2`: macOS バージョン非対応
@_cdecl("meet_jerky_app_detection_start")
public func meet_jerky_app_detection_start(
    _ bundleIdsJson: UnsafePointer<CChar>,
    _ callback: MeetJerkyAppDetectionCallback,
    _ userData: UnsafeMutableRawPointer?
) -> Int32 {
    let json = String(cString: bundleIdsJson)
    guard
        let data = json.data(using: .utf8),
        let array = try? JSONSerialization.jsonObject(with: data) as? [String]
    else {
        return -1
    }

    if #available(macOS 11.0, *) {
        AppDetector.start(bundleIds: array, callback: callback, userData: userData)
        return 0
    }
    return -2
}

@_cdecl("meet_jerky_app_detection_stop")
public func meet_jerky_app_detection_stop() {
    if #available(macOS 11.0, *) {
        AppDetector.stop()
    }
}
