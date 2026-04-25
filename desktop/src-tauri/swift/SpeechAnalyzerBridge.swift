// Apple SpeechAnalyzer (macOS 26+) と Rust を繋ぐ Swift ブリッジ。
//
// アーキテクチャ:
// - Rust 側は extern "C" で `meet_jerky_speech_*` 関数群を呼ぶ。
// - 本ファイルが C ABI を提供し、内部で Swift の async/await で
//   SpeechAnalyzer を駆動する。
// - 結果セグメントはスレッドセーフなキューに溜め、Rust が
//   `drain_json` でポーリングして取り出す。
//
// 注意:
//   SpeechAnalyzer / SpeechTranscriber の API はまだプレビュー段階のため、
//   実機ビルド時にコンパイルエラーが出たら Apple のドキュメントに従って
//   微修正してください。`// SDK_VERIFY:` コメントが付いている箇所は
//   本ブリッジで未確認の API 呼び出しです。

import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, *)
public final class SpeechBridge: @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let transcriber: SpeechTranscriber
    private let inputContinuation: AsyncStream<AnalyzerInput>.Continuation
    private let sampleRate: Double
    private let format: AVAudioFormat
    private let lock = NSLock()
    private var pendingSegments: [(text: String, startMs: Int64, endMs: Int64)] = []
    private var consumerTask: Task<Void, Never>?

    public init(localeId: String, sampleRate: Double) async throws {
        self.sampleRate = sampleRate

        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            )
        else {
            throw NSError(
                domain: "MeetJerky.SpeechBridge",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create AVAudioFormat"]
            )
        }
        self.format = format

        let locale = Locale(identifier: localeId)

        // SDK_VERIFY: SpeechTranscriber initializer signature on macOS 26.
        // 公開資料では transcriptionOptions / reportingOptions / attributeOptions の
        // 3 つを取るバリアントが想定されている。実機で型不一致が出たら
        // 引数名を確認すること。
        self.transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .frequentFinalization],
            attributeOptions: [.audioTimeRange]
        )

        self.analyzer = SpeechAnalyzer(modules: [transcriber])

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.inputContinuation = continuation

        // SDK_VERIFY: start(inputSequence:) の正確な API 名。
        // analyzer.start(inputSequence:) もしくは analyzer.analyzeSequence(_:)。
        try await analyzer.start(inputSequence: stream)

        // 結果コンシューマを別タスクで回す。
        self.consumerTask = Task { [weak self] in
            guard let self = self else { return }
            do {
                for try await result in self.transcriber.results {
                    self.appendResult(result)
                }
            } catch {
                NSLog("SpeechBridge consumer error: \(error)")
            }
        }
    }

    private func appendResult(_ result: SpeechTranscriber.Result) {
        // SDK_VERIFY: 結果の型構造。
        // result.text は AttributedString、result.range は CMTimeRange を想定。
        let text = String(result.text.characters)
        let startMs = Int64(result.range.start.seconds * 1000.0)
        let endMs = Int64(result.range.end.seconds * 1000.0)

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }

        lock.lock()
        pendingSegments.append((text: trimmed, startMs: startMs, endMs: endMs))
        lock.unlock()
    }

    public func feed(samples: UnsafePointer<Float>, count: Int) {
        if count == 0 { return }

        guard
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(count)
            )
        else { return }
        buffer.frameLength = AVAudioFrameCount(count)

        if let dst = buffer.floatChannelData?.pointee {
            dst.update(from: samples, count: count)
        }

        let input = AnalyzerInput(buffer: buffer)
        inputContinuation.yield(input)
    }

    public func drainJson() -> String? {
        lock.lock()
        let snapshot = pendingSegments
        pendingSegments.removeAll(keepingCapacity: true)
        lock.unlock()

        if snapshot.isEmpty { return nil }

        let array: [[String: Any]] = snapshot.map { seg in
            [
                "text": seg.text,
                "startMs": seg.startMs,
                "endMs": seg.endMs,
            ]
        }
        guard
            let data = try? JSONSerialization.data(withJSONObject: array),
            let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return json
    }

    public func finalize() async {
        inputContinuation.finish()
        // SDK_VERIFY: finalize/finish の API 名。analyzer.finalizeAndFinish() ?
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await consumerTask?.value
    }
}

// ─────────────────────────────────────────────
// C ABI
// ─────────────────────────────────────────────

private func runSync<T>(_ block: @escaping () async -> T) -> T {
    // 同期境界で async コードを 1 回実行するためのヘルパ。
    // Rust 側は同期 API を期待しているので、ここで async/await を完結させる。
    let semaphore = DispatchSemaphore(value: 0)
    var result: T?
    Task {
        result = await block()
        semaphore.signal()
    }
    semaphore.wait()
    return result!
}

@available(macOS 26.0, *)
@_cdecl("meet_jerky_speech_create")
public func meet_jerky_speech_create(
    _ localeIdPtr: UnsafePointer<CChar>,
    _ sampleRate: Double
) -> UnsafeMutableRawPointer? {
    let localeId = String(cString: localeIdPtr)

    let bridge: SpeechBridge? = runSync {
        do {
            return try await SpeechBridge(localeId: localeId, sampleRate: sampleRate)
        } catch {
            NSLog("meet_jerky_speech_create failed: \(error)")
            return nil
        }
    }

    guard let bridge = bridge else { return nil }
    return Unmanaged.passRetained(bridge).toOpaque()
}

@available(macOS 26.0, *)
@_cdecl("meet_jerky_speech_feed")
public func meet_jerky_speech_feed(
    _ ptr: UnsafeMutableRawPointer,
    _ samples: UnsafePointer<Float>,
    _ len: Int
) -> Int32 {
    let bridge = Unmanaged<SpeechBridge>.fromOpaque(ptr).takeUnretainedValue()
    bridge.feed(samples: samples, count: len)
    return 0
}

@available(macOS 26.0, *)
@_cdecl("meet_jerky_speech_drain_json")
public func meet_jerky_speech_drain_json(
    _ ptr: UnsafeMutableRawPointer
) -> UnsafePointer<CChar>? {
    let bridge = Unmanaged<SpeechBridge>.fromOpaque(ptr).takeUnretainedValue()
    guard let json = bridge.drainJson() else { return nil }
    // strdup で確保した文字列は呼び出し側 (Rust) が
    // meet_jerky_speech_free_string で解放する。
    return UnsafePointer(strdup(json))
}

@available(macOS 26.0, *)
@_cdecl("meet_jerky_speech_finalize")
public func meet_jerky_speech_finalize(_ ptr: UnsafeMutableRawPointer) -> Int32 {
    let bridge = Unmanaged<SpeechBridge>.fromOpaque(ptr).takeUnretainedValue()
    runSync {
        await bridge.finalize()
    }
    return 0
}

@available(macOS 26.0, *)
@_cdecl("meet_jerky_speech_destroy")
public func meet_jerky_speech_destroy(_ ptr: UnsafeMutableRawPointer) {
    Unmanaged<SpeechBridge>.fromOpaque(ptr).release()
}

@_cdecl("meet_jerky_speech_free_string")
public func meet_jerky_speech_free_string(_ ptr: UnsafePointer<CChar>) {
    free(UnsafeMutableRawPointer(mutating: ptr))
}
