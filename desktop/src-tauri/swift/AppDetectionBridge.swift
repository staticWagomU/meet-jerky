// Zoom / Microsoft Teams など、ローカルにインストールされた会議アプリの
// 起動を検知するための Swift ブリッジ。
//
// アーキテクチャ:
// - Rust 側が watch 対象の Bundle ID 一覧 (JSON) を渡して
//   `meet_jerky_app_detection_start` を呼ぶ。
// - Swift 側は `NSWorkspace.didLaunchApplicationNotification` を購読し、
//   一致する Bundle ID が起動するたびに Rust の C コールバックを呼ぶ。
// - 監視開始時点で既に起動中の対象アプリも初回スキャンで同じ
//   C コールバックに流す。重複通知の抑制は Rust 側のスロットリングに任せる。
//
// ライフサイクル:
// - シングルトン `AppDetector.instance` で Observer の所有権を保持する。
// - `meet_jerky_app_detection_stop` で観察を解除。

import AppKit
import ApplicationServices
import Foundation

/// C 側で書かれた関数ポインタの型シグネチャ。
/// (bundleId, appName, userData) の順で呼ばれる。文字列は Swift 側スコープ内で
/// 有効な C ポインタなので、Rust 側はコールバック内で複製して使う必要がある。
public typealias MeetJerkyAppDetectionCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafeMutableRawPointer?
) -> Void

/// ブラウザのアクティブタブ URL を検知したときの C コールバック。
/// URL 全文は Swift/Rust 境界を越えるが、Rust 側では分類にのみ使い、
/// UI payload やログには出さない。
public typealias MeetJerkyBrowserUrlCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafeMutableRawPointer?
) -> Void

private struct BrowserDescriptor {
    let bundleId: String
    let displayName: String
    let appleScriptName: String
    let tabScriptKind: TabScriptKind
}

private enum TabScriptKind {
    case safari
    case chromium
    case firefox
}

private struct BrowserTabSnapshot {
    let url: String
    let title: String
}

@available(macOS 11.0, *)
public final class AppDetector: @unchecked Sendable {
    private static let lock = NSLock()
    private static var instance: AppDetector?

    private let watchedBundleIds: Set<String>
    private let callback: MeetJerkyAppDetectionCallback
    private let browserUrlCallback: MeetJerkyBrowserUrlCallback
    private let userData: UnsafeMutableRawPointer?
    private var observers: [NSObjectProtocol] = []
    private var browserPollTimer: Timer?
    private var lastBrowserSnapshotKey: String?

    private let watchedBrowsers: [BrowserDescriptor] = [
        BrowserDescriptor(
            bundleId: "com.apple.Safari",
            displayName: "Safari",
            appleScriptName: "Safari",
            tabScriptKind: .safari
        ),
        BrowserDescriptor(
            bundleId: "com.google.Chrome",
            displayName: "Google Chrome",
            appleScriptName: "Google Chrome",
            tabScriptKind: .chromium
        ),
        BrowserDescriptor(
            bundleId: "com.microsoft.edgemac",
            displayName: "Microsoft Edge",
            appleScriptName: "Microsoft Edge",
            tabScriptKind: .chromium
        ),
        BrowserDescriptor(
            bundleId: "org.mozilla.firefox",
            displayName: "Firefox",
            appleScriptName: "Firefox",
            tabScriptKind: .firefox
        ),
    ]

    private init(
        bundleIds: [String],
        callback: @escaping MeetJerkyAppDetectionCallback,
        browserUrlCallback: @escaping MeetJerkyBrowserUrlCallback,
        userData: UnsafeMutableRawPointer?
    ) {
        self.watchedBundleIds = Set(bundleIds)
        self.callback = callback
        self.browserUrlCallback = browserUrlCallback
        self.userData = userData
    }

    public static func start(
        bundleIds: [String],
        callback: @escaping MeetJerkyAppDetectionCallback,
        browserUrlCallback: @escaping MeetJerkyBrowserUrlCallback,
        userData: UnsafeMutableRawPointer?
    ) {
        lock.lock()
        instance?.stopInternal()
        let detector = AppDetector(
            bundleIds: bundleIds,
            callback: callback,
            browserUrlCallback: browserUrlCallback,
            userData: userData
        )
        instance = detector
        lock.unlock()

        DispatchQueue.main.async {
            lock.lock()
            let shouldInstall = instance === detector
            lock.unlock()
            if shouldInstall {
                detector.installObservers()
            }
        }
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

        let didActivate = nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.scanFrontmostBrowser()
        }
        observers.append(didActivate)

        scanRunningApplications()
        scanFrontmostBrowser()
        startBrowserPolling()
    }

    private func scanRunningApplications() {
        for app in NSWorkspace.shared.runningApplications {
            handle(app: app)
        }
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

    private func startBrowserPolling() {
        browserPollTimer?.invalidate()
        let timer = Timer(timeInterval: 3.0, repeats: true) {
            [weak self] _ in
            self?.scanFrontmostBrowser()
        }
        browserPollTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func scanFrontmostBrowser() {
        guard
            let frontmost = NSWorkspace.shared.frontmostApplication,
            let bundleId = frontmost.bundleIdentifier,
            let browser = watchedBrowsers.first(where: { $0.bundleId == bundleId })
        else { return }

        guard let tab = activeTabSnapshot(for: browser, app: frontmost) else { return }
        let normalizedUrl = tab.url.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedUrl.isEmpty { return }

        let snapshotKey = "\(bundleId)\t\(normalizedUrl)"
        if snapshotKey == lastBrowserSnapshotKey {
            return
        }
        lastBrowserSnapshotKey = snapshotKey

        let cb = browserUrlCallback
        let ud = userData
        bundleId.withCString { bundleCstr in
            browser.displayName.withCString { nameCstr in
                normalizedUrl.withCString { urlCstr in
                    tab.title.withCString { titleCstr in
                        cb(bundleCstr, nameCstr, urlCstr, titleCstr, ud)
                    }
                }
            }
        }
    }

    private func activeTabSnapshot(
        for browser: BrowserDescriptor,
        app: NSRunningApplication
    ) -> BrowserTabSnapshot? {
        if let snapshot = activeTabSnapshotViaAppleScript(for: browser) {
            return snapshot
        }

        if browser.tabScriptKind == .firefox {
            return activeTabSnapshotViaAccessibility(app: app)
        }

        return nil
    }

    private func activeTabSnapshotViaAppleScript(
        for browser: BrowserDescriptor
    ) -> BrowserTabSnapshot? {
        let script: String
        switch browser.tabScriptKind {
        case .safari:
            script = """
            tell application "\(browser.appleScriptName)"
                if (count of windows) is 0 then return {"", ""}
                set tabUrl to URL of current tab of front window
                set tabTitle to name of current tab of front window
                return {tabUrl, tabTitle}
            end tell
            """
        case .chromium, .firefox:
            script = """
            tell application "\(browser.appleScriptName)"
                if (count of windows) is 0 then return {"", ""}
                set tabUrl to URL of active tab of front window
                set tabTitle to title of active tab of front window
                return {tabUrl, tabTitle}
            end tell
            """
        }

        var error: NSDictionary?
        guard
            let appleScript = NSAppleScript(source: script),
            let descriptor = appleScript.executeAndReturnError(&error).coerce(toDescriptorType: typeAEList)
        else {
            return nil
        }

        guard let url = descriptor.atIndex(1)?.stringValue else { return nil }
        let title = descriptor.atIndex(2)?.stringValue ?? ""
        return BrowserTabSnapshot(url: url, title: title)
    }

    private func activeTabSnapshotViaAccessibility(app: NSRunningApplication) -> BrowserTabSnapshot? {
        guard AXIsProcessTrusted() else { return nil }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let focusedWindow = copyAXElementAttribute(axApp, kAXFocusedWindowAttribute as CFString) else {
            return nil
        }

        let url = copyAXStringAttribute(focusedWindow, kAXDocumentAttribute as CFString)
            ?? findAXStringAttribute(focusedWindow, kAXDocumentAttribute as CFString, maxDepth: 4)
        guard let url = url else { return nil }

        let title = copyAXStringAttribute(focusedWindow, kAXTitleAttribute as CFString) ?? ""
        return BrowserTabSnapshot(url: url, title: title)
    }

    private func copyAXElementAttribute(
        _ element: AXUIElement,
        _ attribute: CFString
    ) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        if result != .success {
            return nil
        }
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return (value as! AXUIElement)
    }

    private func copyAXStringAttribute(
        _ element: AXUIElement,
        _ attribute: CFString
    ) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        if result != .success {
            return nil
        }
        return value as? String
    }

    private func findAXStringAttribute(
        _ element: AXUIElement,
        _ attribute: CFString,
        maxDepth: Int
    ) -> String? {
        if let value = copyAXStringAttribute(element, attribute) {
            return value
        }
        if maxDepth <= 0 {
            return nil
        }

        var childrenRef: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef)
        if result != .success {
            return nil
        }
        guard let children = childrenRef as? [AXUIElement] else {
            return nil
        }

        for child in children {
            if let value = findAXStringAttribute(child, attribute, maxDepth: maxDepth - 1) {
                return value
            }
        }
        return nil
    }

    private func stopInternal() {
        browserPollTimer?.invalidate()
        browserPollTimer = nil

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
    _ bundleIdsJson: UnsafePointer<CChar>?,
    _ callback: MeetJerkyAppDetectionCallback,
    _ browserUrlCallback: MeetJerkyBrowserUrlCallback,
    _ userData: UnsafeMutableRawPointer?
) -> Int32 {
    guard let bundleIdsJson else {
        return -1
    }

    let json = String(cString: bundleIdsJson)
    guard
        let data = json.data(using: .utf8),
        let array = try? JSONSerialization.jsonObject(with: data) as? [String]
    else {
        return -1
    }

    if #available(macOS 11.0, *) {
        AppDetector.start(
            bundleIds: array,
            callback: callback,
            browserUrlCallback: browserUrlCallback,
            userData: userData
        )
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
