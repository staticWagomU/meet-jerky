export const RING_LIGHT_MODE_EVENT = "ring-light-mode-changed";

export type RingLightMode = "off" | "soft" | "bright";

export interface RingLightModePayload {
  mode: RingLightMode;
}

export function isRingLightMode(value: unknown): value is RingLightMode {
  return value === "off" || value === "soft" || value === "bright";
}

export function isRingLightModePayload(
  value: unknown,
): value is RingLightModePayload {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    isRingLightMode((value as Partial<RingLightModePayload>).mode)
  );
}

export function getNextRingLightMode(mode: RingLightMode): RingLightMode {
  if (mode === "off") return "soft";
  if (mode === "soft") return "bright";
  return "off";
}
