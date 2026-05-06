import { STATUS_UNCHECKABLE_LABEL } from "./statusLabels";

export function getExternalApiKeyStatusLabel(
  externalApiProvider: string | null,
  hasExternalApiKey: boolean | undefined,
  externalApiKeyError: unknown,
): string | null {
  if (!externalApiProvider) {
    return null;
  }
  if (externalApiKeyError) {
    return STATUS_UNCHECKABLE_LABEL;
  }
  if (hasExternalApiKey === undefined) {
    return "確認中";
  }
  return hasExternalApiKey ? "登録済み" : "未登録";
}

export function getExternalApiKeyStatusPillClass(
  statusLabel: string | null,
): string {
  if (statusLabel === "登録済み") {
    return "meeting-status-pill-active";
  }
  if (statusLabel === STATUS_UNCHECKABLE_LABEL) {
    return "meeting-status-pill-error";
  }
  if (statusLabel === "未登録") {
    return "meeting-status-pill-idle";
  }
  return "meeting-status-pill-neutral";
}

export function getExternalApiKeyStatusAriaLabel(
  externalApiProvider: string | null,
  statusLabel: string | null,
): string | null {
  if (!externalApiProvider || !statusLabel) {
    return null;
  }
  if (statusLabel === "登録済み") {
    return `${externalApiProvider} API キー: 登録済み。キー値は画面に再表示されません`;
  }
  return `${externalApiProvider} API キー: ${statusLabel}`;
}
