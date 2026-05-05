export function getPermissionStatusLabel(
  status: string | undefined,
  error: unknown,
  isChecking: boolean,
): string {
  if (isChecking) {
    return "確認中";
  }
  if (error) {
    return "確認不可";
  }
  if (status === "granted") {
    return "許可済み";
  }
  if (status === "denied") {
    return "未許可";
  }
  return "未確認";
}

export function getPermissionRowClassName(
  status: string | undefined,
  error: unknown,
): string {
  return status === "granted" && !error
    ? "menu-permission-row menu-permission-row-granted"
    : "menu-permission-row";
}
