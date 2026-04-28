const PENDING_MEETING_START_STORAGE_KEY = "meetJerky.pendingMeetingStart";

export function hasPendingMeetingStartRequest(): boolean {
  return Boolean(localStorage.getItem(PENDING_MEETING_START_STORAGE_KEY));
}

export function markPendingMeetingStartRequest() {
  localStorage.setItem(PENDING_MEETING_START_STORAGE_KEY, "1");
}

export function clearPendingMeetingStartRequest() {
  localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
}
