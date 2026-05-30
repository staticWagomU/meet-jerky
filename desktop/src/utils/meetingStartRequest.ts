export const MEETING_START_REQUEST_EVENT =
  "meet-jerky-start-recording-requested";

const PENDING_MEETING_START_STORAGE_KEY = "meetJerky.pendingMeetingStart";
const PENDING_MEETING_START_TTL_MS = 60_000;

export type MeetingStartRequestSource =
  | "meeting-detection"
  | "controller"
  | "menu-bar"
  | "unknown";

export interface PendingMeetingStartRequest {
  requestedAt: number;
  source: MeetingStartRequestSource;
  sourceLabel: string;
}

function normalizePendingMeetingStartRequest(
  raw: string,
): PendingMeetingStartRequest | null {
  const timestamp = Number(raw);
  if (Number.isFinite(timestamp)) {
    return {
      requestedAt: timestamp,
      source: "unknown",
      sourceLabel: "開始要求",
    };
  }

  const parsed = JSON.parse(raw) as Partial<PendingMeetingStartRequest>;
  const requestedAt = Number(parsed.requestedAt);
  if (!Number.isFinite(requestedAt)) {
    return null;
  }
  const source = isMeetingStartRequestSource(parsed.source)
    ? parsed.source
    : "unknown";
  const sourceLabel =
    typeof parsed.sourceLabel === "string" && parsed.sourceLabel.trim()
      ? parsed.sourceLabel.trim()
      : source === "meeting-detection"
        ? "検知通知"
        : source === "controller"
          ? "検証パネル"
          : source === "menu-bar"
            ? "メニューバー"
            : "開始要求";

  return {
    requestedAt,
    source,
    sourceLabel,
  };
}

function isMeetingStartRequestSource(
  source: unknown,
): source is MeetingStartRequestSource {
  return (
    source === "meeting-detection" ||
    source === "controller" ||
    source === "menu-bar" ||
    source === "unknown"
  );
}

export function readMeetingStartRequestPayload(
  payload: unknown,
): Partial<Pick<PendingMeetingStartRequest, "source" | "sourceLabel">> {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const candidate = payload as Partial<PendingMeetingStartRequest>;
  const source = isMeetingStartRequestSource(candidate.source)
    ? candidate.source
    : undefined;
  const sourceLabel =
    typeof candidate.sourceLabel === "string" && candidate.sourceLabel.trim()
      ? candidate.sourceLabel.trim()
      : undefined;
  return {
    ...(source ? { source } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
  };
}

export function readPendingMeetingStartRequest(): PendingMeetingStartRequest | null {
  try {
    const raw = localStorage.getItem(PENDING_MEETING_START_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const request = normalizePendingMeetingStartRequest(raw);
    if (!request) {
      localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
      return null;
    }
    const ageMs = Date.now() - request.requestedAt;
    if (ageMs < 0 || ageMs > PENDING_MEETING_START_TTL_MS) {
      localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
      return null;
    }
    return request;
  } catch (e) {
    console.error("録音開始予約の確認に失敗しました:", e);
    localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
    return null;
  }
}

export function hasPendingMeetingStartRequest(): boolean {
  return readPendingMeetingStartRequest() !== null;
}

export function markPendingMeetingStartRequest(
  request?: Partial<Pick<PendingMeetingStartRequest, "source" | "sourceLabel">>,
) {
  try {
    const source = request?.source ?? "unknown";
    const sourceLabel =
      request?.sourceLabel ??
      (source === "meeting-detection"
        ? "検知通知"
        : source === "controller"
          ? "検証パネル"
          : source === "menu-bar"
            ? "メニューバー"
            : "開始要求");
    const pendingRequest: PendingMeetingStartRequest = {
      requestedAt: Date.now(),
      source,
      sourceLabel,
    };
    localStorage.setItem(
      PENDING_MEETING_START_STORAGE_KEY,
      JSON.stringify(pendingRequest),
    );
  } catch (e) {
    console.error("録音開始予約の保存に失敗しました:", e);
  }
}

export function markControllerMeetingStartRequest() {
  markPendingMeetingStartRequest({
    source: "controller",
    sourceLabel: "検証パネル",
  });
}

export function markMeetingDetectionStartRequest() {
  markPendingMeetingStartRequest({
    source: "meeting-detection",
    sourceLabel: "検知通知",
  });
}

export function markMenuBarMeetingStartRequest() {
  markPendingMeetingStartRequest({
    source: "menu-bar",
    sourceLabel: "メニューバー",
  });
}

export function clearPendingMeetingStartRequest() {
  try {
    localStorage.removeItem(PENDING_MEETING_START_STORAGE_KEY);
  } catch (e) {
    console.error("録音開始予約の削除に失敗しました:", e);
  }
}
