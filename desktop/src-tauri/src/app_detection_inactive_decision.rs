//! 会議アプリ検知の inactive / polling stall 判定ロジック (純粋関数 2 件)。
//!
//! state 依存しない純粋関数として `should_warn_polling_stall` /
//! `should_notify_meeting_inactive` を提供する。state 依存の wrapper
//! (`check_meeting_inactive_for_bundle` / `check_all_inactive_bundles`)
//! は STATE 露出回避のため `app_detection.rs` 本体に残す。

/// browser_url_callback の発火間隔が想定より大幅に遅延しているかを判定する純粋関数。
/// `Some(elapsed)` は警告対象の経過秒数、`None` は警告不要。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn should_warn_polling_stall(
    now_secs: u64,
    last_seen_secs: u64,
    last_warned_secs: u64,
    expected_interval_secs: u64,
    throttle_secs: u64,
) -> Option<u64> {
    if last_seen_secs == 0 {
        return None;
    }
    if now_secs <= last_seen_secs {
        return None;
    }
    let elapsed = now_secs - last_seen_secs;
    if elapsed <= expected_interval_secs * 3 {
        return None;
    }
    if now_secs.saturating_sub(last_warned_secs) < throttle_secs {
        return None;
    }
    Some(elapsed)
}

/// 監視中の会議アプリが長時間検知されない場合に「会議終了」通知を発火すべきかを判定する純粋関数。
/// `Some(elapsed)` は通知対象の経過秒数、`None` は通知不要。
#[allow(dead_code)]
pub(crate) fn should_notify_meeting_inactive(
    now_secs: u64,
    last_seen_secs: u64,
    last_notified_secs: u64,
    inactive_threshold_secs: u64,
    throttle_secs: u64,
) -> Option<u64> {
    if last_seen_secs == 0 {
        return None;
    }
    if now_secs <= last_seen_secs {
        return None;
    }
    let elapsed = now_secs - last_seen_secs;
    if elapsed < inactive_threshold_secs {
        return None;
    }
    if now_secs.saturating_sub(last_notified_secs) < throttle_secs {
        return None;
    }
    Some(elapsed)
}

#[cfg(test)]
mod tests {
    use super::{should_notify_meeting_inactive, should_warn_polling_stall};

    #[test]
    fn should_warn_polling_stall_first_call_returns_none() {
        // last_seen_secs == 0 は初回起動: 警告しない
        assert_eq!(should_warn_polling_stall(1000, 0, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_within_normal_range_returns_none() {
        // elapsed = 5s <= expected(3) * 3 = 9s: 正常範囲なので警告しない
        assert_eq!(should_warn_polling_stall(1000, 995, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_stalled_returns_some_elapsed() {
        // elapsed = 30s > 9s, 未警告 → Some(30)
        assert_eq!(should_warn_polling_stall(1000, 970, 0, 3, 60), Some(30));
    }

    #[test]
    fn should_warn_polling_stall_throttled_returns_none() {
        // elapsed = 30s > 9s だが 30s 前に警告済み (throttle=60s) → None
        assert_eq!(should_warn_polling_stall(1000, 970, 970, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_boundary_at_expected_times_three_returns_none() {
        // 境界: elapsed == expected_interval_secs * 3 ぴったり (= 9s) は正常範囲扱いで None
        // (実装は `elapsed <= expected_interval_secs * 3` で短絡)。
        // この境界を保護する: `<=` を `<` に変える誤改修を CI で検知。
        assert_eq!(should_warn_polling_stall(1009, 1000, 0, 3, 60), None);
        // 境界の 1 秒外: elapsed = 10 > 9 で Some(10)
        assert_eq!(should_warn_polling_stall(1010, 1000, 0, 3, 60), Some(10));
    }

    #[test]
    fn should_warn_polling_stall_clock_skew_last_warned_after_now_returns_none() {
        // clock 巻き戻し相当: last_warned_secs > now_secs。
        // saturating_sub で 0 に飽和し、0 < throttle (60) で None を返す契約を固定。
        // saturating_sub を sub に変える panic 化、または巻き戻し時に throttle を無視する誤改修を検知。
        // 前提: elapsed = 30s > expected(3) * 3 = 9s なので throttle 経路まで到達する。
        assert_eq!(should_warn_polling_stall(1000, 970, 1500, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_now_equals_last_seen_returns_none() {
        // now_secs <= last_seen_secs (同時刻) → None (時刻同期問題への保守的扱い)
        assert_eq!(should_warn_polling_stall(1000, 1000, 0, 3, 60), None);
    }

    #[test]
    fn should_warn_polling_stall_zero_expected_returns_some_when_elapsed_positive() {
        // expected_interval_secs = 0, elapsed = 1: 1 <= 0 は偽なので警告発火 → Some(1)
        // 検知装置: expected=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(should_warn_polling_stall(1001, 1000, 0, 0, 60), Some(1));
    }

    #[test]
    fn should_warn_polling_stall_zero_throttle_returns_some_when_stalled() {
        // throttle_secs = 0, elapsed = 30 > 9: saturating_sub(999) = 1 >= 0 → Some(30)
        // 検知装置: throttle=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(should_warn_polling_stall(1000, 970, 999, 3, 0), Some(30));
    }

    #[test]
    fn should_warn_polling_stall_now_secs_max_with_seen_returns_some_huge_elapsed() {
        // now=u64::MAX, last_seen=1: elapsed = u64::MAX - 1 (overflow なし) → Some(u64::MAX - 1)
        // 検知装置: u64 overflow への panic 化 / 不要なキャスト追加による精度損失
        assert_eq!(
            should_warn_polling_stall(u64::MAX, 1, 0, 3, 60),
            Some(u64::MAX - 1)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_first_call_returns_none() {
        // last_seen_secs == 0 は一度も検知されていない: 通知しない
        assert_eq!(should_notify_meeting_inactive(1000, 0, 0, 300, 600), None);
    }

    #[test]
    fn should_notify_meeting_inactive_within_active_range_returns_none() {
        // elapsed = 200s < threshold = 300s: まだアクティブ範囲内なので通知しない
        assert_eq!(should_notify_meeting_inactive(1000, 800, 0, 300, 600), None);
    }

    #[test]
    fn should_notify_meeting_inactive_inactive_returns_some_elapsed() {
        // elapsed = 400s >= threshold = 300s, 未通知 (throttle check = 1000-0=1000 >= 600) → Some(400)
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 0, 300, 600),
            Some(400)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_throttled_returns_none() {
        // elapsed = 400s >= threshold だが now - last_notified = 400s < throttle = 600s → None
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 600, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_now_equals_last_seen_returns_none() {
        // now_secs <= last_seen_secs (同時刻) → None (時刻同期問題への保守的扱い)
        assert_eq!(
            should_notify_meeting_inactive(1000, 1000, 0, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_threshold_boundary_returns_some() {
        // elapsed = 300 == threshold = 300: < 判定のため境界ちょうどで発火する → Some(300)
        // 検知装置: `<` を `<=` に変える誤改修 (境界で発火しない化)
        assert_eq!(
            should_notify_meeting_inactive(1300, 1000, 0, 300, 600),
            Some(300)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_zero_threshold_returns_some_when_elapsed_positive() {
        // inactive_threshold_secs = 0, elapsed = 1: 0 < 0 は偽なので通知発火 → Some(1)
        // 検知装置: threshold=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(
            should_notify_meeting_inactive(1001, 1000, 0, 0, 600),
            Some(1)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_zero_throttle_returns_some_when_inactive() {
        // throttle_secs = 0, elapsed = 400 >= threshold = 300: saturating_sub(999) = 1 >= 0 → Some(400)
        // 検知装置: throttle=0 を「無効化」と読み替えて None を返す誤改修
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 999, 300, 0),
            Some(400)
        );
    }

    #[test]
    fn should_notify_meeting_inactive_clock_skew_last_notified_after_now_returns_none() {
        // last_notified(1500) > now(1000): saturating_sub → 0 < throttle(600) → None
        // 検知装置: saturating_sub を sub に変える panic 化 / または巻き戻し時 throttle 無視の誤改修
        assert_eq!(
            should_notify_meeting_inactive(1000, 600, 1500, 300, 600),
            None
        );
    }

    #[test]
    fn should_notify_meeting_inactive_now_secs_max_with_seen_returns_some_huge_elapsed() {
        // now=u64::MAX, last_seen=1: elapsed = u64::MAX - 1 (overflow なし) → Some(u64::MAX - 1)
        // 検知装置: u64 overflow への panic 化 / 不要なキャスト追加による精度損失
        assert_eq!(
            should_notify_meeting_inactive(u64::MAX, 1, 0, 300, 600),
            Some(u64::MAX - 1)
        );
    }
}
