//! 保存済みセッションに紐づく音声サイドカーの状態を返す。
//!
//! Markdown 履歴を起点に、同じ保存ディレクトリ内の `<session>.mic.wav`,
//! `<session>.speaker.wav`, `<session>.mix.wav` を安全に問い合わせる。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::session_commands_helpers::resolve_output_directory;
use crate::settings::SettingsStateHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAudioAsset {
    pub track: &'static str,
    pub path: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAudioAssets {
    pub session_path: PathBuf,
    pub microphone: SessionAudioAsset,
    pub speaker: SessionAudioAsset,
    pub mix: SessionAudioAsset,
}

pub fn get_session_audio_assets_inner(
    output_dir: &Path,
    requested: &Path,
) -> Result<SessionAudioAssets, String> {
    let canonical_dir = output_dir
        .canonicalize()
        .map_err(|e| format!("セッション保存先の確認に失敗しました: {e}"))?;
    let canonical_session = requested
        .canonicalize()
        .map_err(|e| format!("セッションファイルの確認に失敗しました: {e}"))?;

    if !canonical_session.starts_with(&canonical_dir) {
        return Err("セッションファイルが保存先ディレクトリの外を指しています".into());
    }
    if canonical_session.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("セッションファイルは .md でなければなりません".into());
    }

    let stem = canonical_session
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "セッションファイル名を解決できません".to_string())?;
    let parent = canonical_session
        .parent()
        .ok_or_else(|| "セッション保存ディレクトリを解決できません".to_string())?;

    let microphone = audio_asset(parent, stem, "microphone", "mic");
    let speaker = audio_asset(parent, stem, "speaker", "speaker");
    let mix = audio_asset(parent, stem, "mix", "mix");

    Ok(SessionAudioAssets {
        session_path: canonical_session,
        microphone,
        speaker,
        mix,
    })
}

fn audio_asset(
    parent: &Path,
    stem: &str,
    track: &'static str,
    suffix: &'static str,
) -> SessionAudioAsset {
    let path = parent.join(format!("{stem}.{suffix}.wav"));
    let exists = path.is_file();
    SessionAudioAsset {
        track,
        path,
        exists,
    }
}

#[tauri::command]
pub fn get_session_audio_assets_cmd(
    path: String,
    settings_state: tauri::State<'_, SettingsStateHandle>,
) -> Result<SessionAudioAssets, String> {
    let output_dir = resolve_output_directory(settings_state.inner());
    get_session_audio_assets_inner(&output_dir, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn returns_expected_sidecar_paths_and_existence() {
        let dir = tempdir().unwrap();
        let session_path = dir.path().join("1700000000-0.md");
        let mic_path = dir.path().join("1700000000-0.mic.wav");
        let speaker_path = dir.path().join("1700000000-0.speaker.wav");
        fs::write(&session_path, "# test").unwrap();
        fs::write(&mic_path, b"mic").unwrap();
        fs::write(&speaker_path, b"speaker").unwrap();

        let assets = get_session_audio_assets_inner(dir.path(), &session_path).unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();

        assert!(assets.microphone.exists);
        assert!(assets.speaker.exists);
        assert!(!assets.mix.exists);
        assert_eq!(assets.microphone.track, "microphone");
        assert_eq!(assets.speaker.track, "speaker");
        assert_eq!(assets.mix.track, "mix");
        assert_eq!(
            assets.microphone.path,
            canonical_dir.join("1700000000-0.mic.wav")
        );
        assert_eq!(
            assets.speaker.path,
            canonical_dir.join("1700000000-0.speaker.wav")
        );
        assert_eq!(assets.mix.path, canonical_dir.join("1700000000-0.mix.wav"));
    }

    #[test]
    fn rejects_path_outside_output_dir() {
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("1700000000-0.md");
        fs::write(&outside_file, "# outside").unwrap();
        let output_dir = tempdir().unwrap();

        let err = get_session_audio_assets_inner(output_dir.path(), &outside_file).unwrap_err();

        assert!(
            err.contains("外を指しています"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn rejects_non_markdown_session_path() {
        let dir = tempdir().unwrap();
        let text_path = dir.path().join("1700000000-0.txt");
        fs::write(&text_path, "not markdown").unwrap();

        let err = get_session_audio_assets_inner(dir.path(), &text_path).unwrap_err();

        assert!(err.contains(".md"), "unexpected error message: {err}");
    }
}
