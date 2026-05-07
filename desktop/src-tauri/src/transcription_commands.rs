use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::transcription_commands_helpers::{
    parse_requested_transcription_sources, validate_requested_sources_available,
    validate_stream_count_for_engine, ERROR_TRANSCRIPTION_AUDIO_SOURCE_UNAVAILABLE,
};
use crate::transcription_manager::TranscriptionStateHandle;
use crate::transcription_panic_guard::run_transcription_worker_with_panic_guard;
use crate::transcription_traits::{StreamConfig, TranscriptionStream};
use crate::transcription_types::TranscriptionSource;
use crate::transcription_worker_loop::TranscriptionLoopConfig;

/// 文字起こしを停止する
#[tauri::command]
pub fn stop_transcription(state: tauri::State<'_, TranscriptionStateHandle>) -> Result<(), String> {
    let mut manager = state.0.lock();
    if !manager.is_running() {
        return Err("文字起こしは実行されていません".to_string());
    }
    manager.stop();
    Ok(())
}

/// 文字起こしを開始する
///
/// `source` パラメータ:
/// - `Some("microphone")`: マイクのみ
/// - `Some("system_audio")`: システム音声のみ
/// - `None` または `Some("both")`: 両方（デュアルストリーム）
///
/// `model_name` は Whisper を選択した時のみ使われる。Apple SpeechAnalyzer 等
/// 別エンジンを選んだ場合は無視される (引数互換のため残している)。
#[tauri::command]
pub fn start_transcription(
    model_name: String,
    source: Option<String>,
    audio_state: tauri::State<'_, crate::audio::AudioStateHandle>,
    transcription_state: tauri::State<'_, TranscriptionStateHandle>,
    settings_state: tauri::State<'_, crate::settings::SettingsStateHandle>,
    session_manager: tauri::State<'_, Arc<crate::session_manager::SessionManager>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut manager = transcription_state.0.lock();

    if manager.is_running() {
        return Err("文字起こしは既に実行中です".to_string());
    }

    // 設定からエンジン種別を読み取り、必要ならエンジンを切り替える。
    // 引数の `model_name` は Whisper の場合に優先採用 (UI から選択された値を反映)。
    let (engine_type, whisper_model, language) = {
        let settings = settings_state.0.lock();
        let model = if model_name.is_empty() {
            settings.whisper_model.clone()
        } else {
            model_name.clone()
        };
        (
            settings.transcription_engine.clone(),
            model,
            settings.language.clone(),
        )
    };

    manager.ensure_engine(&engine_type, &whisper_model)?;

    // エンジンの Arc クローンを取得（所有権を移動せずスレッドに渡す）
    let engine = Arc::clone(
        manager
            .engine
            .as_ref()
            .ok_or_else(|| "文字起こしエンジンが初期化されていません".to_string())?,
    );

    let running = manager.running_flag();

    let requested_sources = parse_requested_transcription_sources(source.as_deref())?;
    let stream_language = Some(language.trim().to_string()).filter(|value| !value.is_empty());

    let mic_sample_rate = if requested_sources.use_mic {
        audio_state.get_sample_rate()
    } else {
        None
    };
    let system_sample_rate = if requested_sources.use_system {
        audio_state.get_system_audio_sample_rate()
    } else {
        None
    };
    validate_requested_sources_available(
        requested_sources,
        mic_sample_rate.is_some() && audio_state.has_consumer(),
        system_sample_rate.is_some() && audio_state.has_system_audio_consumer(),
    )?;
    let available_stream_count = [mic_sample_rate, system_sample_rate]
        .into_iter()
        .filter(Option::is_some)
        .count();
    validate_stream_count_for_engine(&engine_type, available_stream_count)?;

    let mut pending_streams = Vec::new();

    // live loop に渡す SessionManager の Arc と、ストリーム基準時刻 (now)。
    // stream_started_at_secs はマイク/システム両 worker で共通の基準として用い、
    // セグメントの絶対時刻 (= offset 算出の起点) を決定する。
    let session_manager_arc: Arc<crate::session_manager::SessionManager> =
        Arc::clone(session_manager.inner());
    let stream_started_at_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // マイク用の文字起こしスレッド
    if let Some(mic_sample_rate) = mic_sample_rate {
        let stream_config = StreamConfig {
            sample_rate: mic_sample_rate,
            speaker: Some("自分".to_string()),
            source: Some(TranscriptionSource::Microphone),
            language: stream_language.clone(),
        };
        let stream = Arc::clone(&engine)
            .start_stream(stream_config)
            .map_err(|e| format!("マイク音声の文字起こしストリーム初期化に失敗しました: {e}"))?;

        pending_streams.push(PendingTranscriptionStream {
            source: TranscriptionSource::Microphone,
            stream,
        });
    }

    // システム音声用の文字起こしスレッド
    if let Some(sys_sample_rate) = system_sample_rate {
        let stream_config = StreamConfig {
            sample_rate: sys_sample_rate,
            speaker: Some("相手側".to_string()),
            source: Some(TranscriptionSource::SystemAudio),
            language: stream_language.clone(),
        };
        let stream = Arc::clone(&engine)
            .start_stream(stream_config)
            .map_err(|e| format!("システム音声の文字起こしストリーム初期化に失敗しました: {e}"))?;

        pending_streams.push(PendingTranscriptionStream {
            source: TranscriptionSource::SystemAudio,
            stream,
        });
    }

    let mut workers = Vec::new();
    for pending in pending_streams {
        let consumer = match pending.source {
            TranscriptionSource::Microphone => audio_state.take_consumer(),
            TranscriptionSource::SystemAudio => audio_state.take_system_audio_consumer(),
        };

        if let Some(consumer) = consumer {
            workers.push(TranscriptionLoopConfig {
                consumer,
                source: pending.source,
                stream: pending.stream,
                running: Arc::clone(&running),
                app: app.clone(),
                session_manager: Arc::clone(&session_manager_arc),
                stream_started_at_secs,
            });
        }
    }

    if workers.is_empty() {
        return Err(ERROR_TRANSCRIPTION_AUDIO_SOURCE_UNAVAILABLE.to_string());
    }

    running.store(true, Ordering::SeqCst);

    for worker in workers {
        std::thread::spawn(move || {
            run_transcription_worker_with_panic_guard(worker);
        });
    }

    Ok(())
}

struct PendingTranscriptionStream {
    source: TranscriptionSource,
    stream: Box<dyn TranscriptionStream>,
}
