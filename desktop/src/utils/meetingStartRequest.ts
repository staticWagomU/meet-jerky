const PENDING_MEETING_START_STORAGE_KEY = "meetJerky.pendingMeetingStart";
const PENDING_MEETING_START_TTL_MS = 60_000;

export function hasPendingMeetingStartRequest(): boolean {
  try {
    const raw = localStorage.getItem(PENDING_MEETING_START_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const createdAt = Number(raw);
    if (!Number.isFinite(createdAt)) {
      localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
      return false;
    }
    const ageMs = Date.now() - createdAt;
    if (ageMs < 0 || ageMs > PENDING_MEETING_START_TTL_MS) {
      localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
      return false;
    }
    return true;
  } catch (e) {
    console.error("録音開始予約の確認に失敗しました:", e);
    return false;
  }
}

export function markPendingMeetingStartRequest() {
  try {
    localStorage.setItem(PENDING_MEETING_START_STORAGE_KEY, String(Date.now()));
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
