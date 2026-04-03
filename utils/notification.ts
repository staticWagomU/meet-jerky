/**
 * Show a dismissing toast notification in the top-center of the page.
 * Uses opacity fade-out rather than display:none to avoid layout shifts.
 */
export function showNotification(
	message: string,
	type: "info" | "warning" | "error" = "info",
	durationMs: number = 5000,
): void {
	const notification = document.createElement("div");
	notification.textContent = message;

	const bgColors = {
		info: "#1a73e8",
		warning: "#f9ab00",
		error: "#d93025",
	};

	Object.assign(notification.style, {
		position: "fixed",
		top: "16px",
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: "99999",
		padding: "8px 20px",
		borderRadius: "8px",
		backgroundColor: bgColors[type],
		color: "#fff",
		fontSize: "13px",
		fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
		boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
		transition: "opacity 0.3s",
		opacity: "1",
	});

	document.body.appendChild(notification);

	setTimeout(() => {
		notification.style.opacity = "0";
		setTimeout(() => notification.remove(), 300);
	}, durationMs);
}
