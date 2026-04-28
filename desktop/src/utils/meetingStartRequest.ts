const PENDING_MEETING_START_STORAGE_KEY = "meetJerky.pendingMeetingStart";

export function hasPendingMeetingStartRequest(): boolean {
  try {
    return Boolean(localStorage.getItem(PENDING_MEETING_START_STORAGE_KEY));
  } catch (e) {
    console.error("録音開始予約の確認に失敗しました:", e);
    return false;
  }
}

export function markPendingMeetingStartRequest() {
  try {
    localStorage.setItem(PENDING_MEETING_START_STORAGE_KEY, "1");
  } catch (e) {
    console.error("録音開始予約の保存に失敗しました:", e);
  }
}

export function clearPendingMeetingStartRequest() {
  try {
    localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
  } catch (e) {
    console.error("録音開始予約の削除に失敗しました:", e);
  }
}
