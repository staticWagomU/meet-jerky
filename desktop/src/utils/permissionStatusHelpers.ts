import { STATUS_CHECKING_LABEL, STATUS_DENIED_LABEL, STATUS_UNDETERMINED_LABEL } from "./statusLabels";

export function getPermissionStatusLabel(
  status: string | undefined,
  error: unknown,
  isChecking: boolean,
): string {
  if (isChecking) {
    return STATUS_CHECKING_LABEL;
  }
  if (error) {
    return "確認不可";
  }
  if (status === "granted") {
    return "許可済み";
  }
  if (status === "denied") {
    return STATUS_DENIED_LABEL;
  }
  return STATUS_UNDETERMINED_LABEL;
}

export function getPermissionRowClassName(
  status: string | undefined,
  error: unknown,
): string {
  return status === "granted" && !error
    ? "menu-permission-row menu-permission-row-granted"
    : "menu-permission-row";
}
