export function RingLightWindow() {
  return (
    <div
      className="ring-light-window"
      aria-hidden="true"
      data-tauri-drag-region
    >
      <div className="ring-light-edge ring-light-edge-top" />
      <div className="ring-light-edge ring-light-edge-right" />
      <div className="ring-light-edge ring-light-edge-bottom" />
      <div className="ring-light-edge ring-light-edge-left" />
    </div>
  );
}
