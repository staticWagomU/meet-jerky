import {
	COLLAPSE_PROPS,
	extractAllCaptionData,
	extractCaptionData,
	findCaptionAncestors,
} from "@/utils/caption-dom";
import {
	determineCaptionAction,
	extractMeetingCodeFromPath,
	isSystemMessage,
} from "@/utils/helpers";
import type {
	MeetingEndedMessage,
	MeetingStartedMessage,
	TranscriptUpdateMessage,
} from "@/utils/messaging";
import { showNotification } from "@/utils/notification";
import {
	areCaptionsOn,
	enableCaptions,
	findCaptionButton,
	findCaptionRegion,
	findLeaveButton,
	isInMeeting,
} from "@/utils/selectors";
import type {
	CaptionData,
	RawCaptionEntry,
	TranscriptBlock,
} from "@/utils/types";

// ─── Constants ───────────────────────────────────────────────────────────────

const POLLING_INTERVAL_MS = 2_000;
const CAPTION_RETRY_INTERVAL_MS = 1_500;
const CAPTION_MAX_RETRIES = 20;
const IDLE_COMMIT_MS = 2_000;
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 10;
const CAPTION_REGION_TIMEOUT_MS = 30_000;
const REJOIN_GRACE_PERIOD_MS = 120_000; // 2 minutes grace period for rejoin
const KEEPALIVE_INTERVAL_MS = 25_000; // Keep service worker alive
const MEETING_START_MAX_RETRIES = 3;
const MEETING_START_RETRY_MS = 1_000;

// ─── State ───────────────────────────────────────────────────────────────────

// Session lifecycle
let sessionId: string | null = null;
let inMeeting = false;
let meetingEnded = false;
// meetingDetectionTimer is intentionally not stored — the interval runs for the page lifetime
let rejoinGraceTimer: ReturnType<typeof setTimeout> | null = null;

// Transcript buffer
let currentBlock: CaptionData | null = null;
let pendingBlocks: TranscriptBlock[] = [];
let pendingRawEntries: RawCaptionEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let totalRawCount = 0; // Total raw entries captured in this session (sent + pending)

// Service worker keepalive
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

// Caption observation
let bodyObserver: MutationObserver | null = null;
let captionObserver: MutationObserver | null = null;
let captionRegion: HTMLElement | null = null;
let captionAncestors: HTMLElement[] = [];
let captionHidden = true;
let lastSeenCaptions: CaptionData[] = [];

// Caption guard
let captionGuardActive = false;
let captionGuardBypass = false;
let captionConfirmDialog: HTMLElement | null = null;

// ─── Toggle Button & Recording Indicator ────────────────────────────────────

let toggleButton: HTMLButtonElement | null = null;
let indicatorPanel: HTMLElement | null = null;
let indicatorDot: HTMLElement | null = null;
let indicatorCount: HTMLElement | null = null;
let manualCaptureButton: HTMLButtonElement | null = null;

const INDICATOR_STYLES = {
	panel: {
		position: "fixed",
		bottom: "120px",
		right: "24px",
		zIndex: "99999",
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "6px 12px",
		borderRadius: "20px",
		backgroundColor: "rgba(32, 33, 36, 0.85)",
		color: "#fff",
		fontSize: "12px",
		fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
		boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
	},
	dot: {
		width: "8px",
		height: "8px",
		borderRadius: "50%",
		backgroundColor: "#aaa",
		flexShrink: "0",
	},
	manualBtn: {
		padding: "2px 8px",
		borderRadius: "10px",
		border: "1px solid rgba(255,255,255,0.4)",
		backgroundColor: "transparent",
		color: "#fff",
		fontSize: "11px",
		cursor: "pointer",
		whiteSpace: "nowrap",
	},
} as const;

function createIndicatorPanel(): void {
	if (indicatorPanel) return;

	indicatorPanel = document.createElement("div");
	Object.assign(indicatorPanel.style, INDICATOR_STYLES.panel);

	// Recording dot
	indicatorDot = document.createElement("span");
	Object.assign(indicatorDot.style, INDICATOR_STYLES.dot);
	indicatorPanel.appendChild(indicatorDot);

	// Count label
	indicatorCount = document.createElement("span");
	indicatorCount.textContent = "RAW: 0";
	indicatorPanel.appendChild(indicatorCount);

	// Manual capture button
	manualCaptureButton = document.createElement("button");
	manualCaptureButton.textContent = "手動記録";
	Object.assign(manualCaptureButton.style, INDICATOR_STYLES.manualBtn);
	manualCaptureButton.addEventListener("click", manualCapture);
	indicatorPanel.appendChild(manualCaptureButton);

	document.body.appendChild(indicatorPanel);
	updateIndicator();
}

function removeIndicatorPanel(): void {
	if (indicatorPanel) {
		indicatorPanel.remove();
		indicatorPanel = null;
		indicatorDot = null;
		indicatorCount = null;
		manualCaptureButton = null;
	}
}

function updateIndicator(): void {
	if (!indicatorDot || !indicatorCount) return;

	const isRecording = captionObserver !== null && captionRegion !== null;
	indicatorDot.style.backgroundColor = isRecording ? "#34a853" : "#d93025";
	indicatorCount.textContent = `RAW: ${totalRawCount}`;
}

function manualCapture(): void {
	if (!captionRegion) {
		// Try to find it again — it may have been recreated by Meet
		const region = findCaptionRegion();
		if (region) {
			observeCaptionRegion(region);
		} else {
			showNotification("字幕領域が見つかりません", "warning", 3000);
			return;
		}
	}

	if (!captionRegion) return;
	const data = extractCaptionData(captionRegion);
	if (!data) {
		showNotification("字幕テキストが空です", "info", 2000);
		return;
	}

	pendingRawEntries.push({
		timestamp: new Date().toISOString(),
		personName: data.personName,
		text: data.text,
	});
	totalRawCount++;
	updateIndicator();

	// Brief flash feedback on the button
	if (manualCaptureButton) {
		manualCaptureButton.textContent = "記録済";
		setTimeout(() => {
			if (manualCaptureButton) manualCaptureButton.textContent = "手動記録";
		}, 800);
	}
}

function createToggleButton(): void {
	if (toggleButton) return;

	toggleButton = document.createElement("button");
	toggleButton.textContent = "字幕: 非表示";
	Object.assign(toggleButton.style, {
		position: "fixed",
		bottom: "80px",
		right: "24px",
		zIndex: "99999",
		padding: "8px 16px",
		borderRadius: "20px",
		border: "none",
		backgroundColor: "#1a73e8",
		color: "#fff",
		fontSize: "13px",
		fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
		cursor: "pointer",
		boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
		transition: "opacity 0.2s",
		opacity: "0.85",
	});

	toggleButton.addEventListener("mouseenter", () => {
		if (toggleButton) toggleButton.style.opacity = "1";
	});
	toggleButton.addEventListener("mouseleave", () => {
		if (toggleButton) toggleButton.style.opacity = "0.85";
	});

	toggleButton.addEventListener("click", () => {
		captionHidden = !captionHidden;
		applyCaptionVisibility();
		if (toggleButton) {
			toggleButton.textContent = captionHidden ? "字幕: 非表示" : "字幕: 表示";
		}
	});

	document.body.appendChild(toggleButton);
}

function removeToggleButton(): void {
	if (toggleButton) {
		toggleButton.remove();
		toggleButton = null;
	}
	removeIndicatorPanel();
}

// ─── Caption Visibility ──────────────────────────────────────────────────────

function applyCaptionVisibility(): void {
	if (!captionRegion) return;

	if (captionAncestors.length === 0) {
		captionAncestors = findCaptionAncestors(captionRegion);
	}

	if (captionHidden) {
		// IMPORTANT: Do NOT use display:none — Google Meet may stop updating
		// caption text in the DOM for elements removed from the render tree,
		// which means MutationObserver never fires.
		// Instead, move the caption region off-screen so it remains "alive"
		// and Google Meet continues to push text updates.
		const rs = captionRegion.style;
		rs.setProperty("opacity", "0", "important");
		rs.setProperty("pointer-events", "none", "important");
		rs.setProperty("position", "fixed", "important");
		rs.setProperty("top", "-9999px", "important");
		rs.setProperty("left", "-9999px", "important");

		// Collapse ancestor containers up to (and including) the layout
		// boundary — the element whose parent is shared with the video area.
		for (const ancestor of captionAncestors) {
			const s = ancestor.style;
			s.setProperty("position", "absolute", "important");
			for (const prop of COLLAPSE_PROPS) {
				s.setProperty(prop, "0", "important");
			}
			s.setProperty("overflow", "hidden", "important");
		}
	} else {
		for (const prop of [
			"opacity",
			"pointer-events",
			"position",
			"top",
			"left",
		]) {
			captionRegion.style.removeProperty(prop);
		}
		for (const ancestor of captionAncestors) {
			ancestor.style.removeProperty("position");
			for (const prop of COLLAPSE_PROPS) {
				ancestor.style.removeProperty(prop);
			}
			ancestor.style.removeProperty("overflow");
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractMeetingCode(): string {
	return extractMeetingCodeFromPath(window.location.pathname);
}

function extractMeetingTitle(): string {
	// Strategy 1: Google Meet DOM element with meeting title class
	const titleEl = document.querySelector(".u6vdEc");
	const domTitle = titleEl?.textContent?.trim();
	if (domTitle) return domTitle;

	// Strategy 2: document.title (typically "Meeting Title - Google Meet")
	const pageTitle = document.title.replace(/\s*[-–]\s*Google Meet$/, "").trim();
	if (pageTitle && pageTitle !== "Google Meet") return pageTitle;

	// Fallback: meeting code
	return extractMeetingCode();
}

// ─── Block Management ────────────────────────────────────────────────────────

function commitCurrentBlock(): void {
	if (!currentBlock?.text.trim()) return;
	if (isSystemMessage(currentBlock.text)) {
		currentBlock = null;
		return;
	}

	const block: TranscriptBlock = {
		personName: currentBlock.personName,
		timestamp: new Date().toISOString(),
		transcriptText: currentBlock.text.trim(),
	};

	pendingBlocks.push(block);
	currentBlock = null;

	if (pendingBlocks.length >= FLUSH_THRESHOLD) {
		flushPendingBlocks();
	}
}

function resetIdleTimer(): void {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		commitCurrentBlock();
	}, IDLE_COMMIT_MS);
}

async function flushPendingBlocks(): Promise<void> {
	if (pendingBlocks.length === 0 && pendingRawEntries.length === 0) return;
	if (!sessionId) return;

	const blocksToSend = [...pendingBlocks];
	const rawToSend = [...pendingRawEntries];
	pendingBlocks = [];
	pendingRawEntries = [];

	try {
		const message: TranscriptUpdateMessage = {
			type: "TRANSCRIPT_UPDATE",
			payload: {
				sessionId: sessionId,
				blocks: blocksToSend,
				rawEntries: rawToSend,
			},
		};
		const response = await browser.runtime.sendMessage(message);

		// Guard against undefined/null response — Chrome MV3 may return
		// undefined when the service worker restarts mid-message.
		// Without this check, data is silently discarded.
		if (!response?.success) {
			console.warn(
				"[MJ] Flush failed or no response:",
				response?.error ?? "undefined response",
			);
			pendingBlocks = [...blocksToSend, ...pendingBlocks];
			pendingRawEntries = [...rawToSend, ...pendingRawEntries];
		}
	} catch (e) {
		console.warn("[MJ] Failed to flush pending blocks:", e);
		// Put blocks back for retry
		pendingBlocks = [...blocksToSend, ...pendingBlocks];
		pendingRawEntries = [...rawToSend, ...pendingRawEntries];
	}
}

// ─── Caption Observation ─────────────────────────────────────────────────────

function onCaptionMutation(): void {
	if (!captionRegion) return;

	const allData = extractAllCaptionData(captionRegion);
	if (allData.length === 0) return;

	let anyChanged = false;

	for (const data of allData) {
		// Skip blocks that haven't changed since the last mutation
		const wasSeen = lastSeenCaptions.some(
			(prev) => prev.personName === data.personName && prev.text === data.text,
		);
		if (wasSeen) continue;

		anyChanged = true;

		// Record raw caption observation before any processing
		pendingRawEntries.push({
			timestamp: new Date().toISOString(),
			personName: data.personName,
			text: data.text,
		});
		totalRawCount++;

		const result = determineCaptionAction(currentBlock, data);

		switch (result.action) {
			case "start":
				currentBlock = result.block;
				break;
			case "commit_and_start":
				currentBlock = result.commitBlock;
				commitCurrentBlock();
				currentBlock = result.newBlock;
				break;
			case "update":
				currentBlock = result.block;
				break;
		}
	}

	lastSeenCaptions = allData;

	if (anyChanged) {
		updateIndicator();
		resetIdleTimer();
	}
}

function observeCaptionRegion(region: HTMLElement): void {
	captionRegion = region;

	// Reset cached parent containers (they change when region is recreated)
	captionAncestors = [];

	// Apply initial visibility (hidden by default)
	applyCaptionVisibility();
	createToggleButton();
	createIndicatorPanel();

	// Note: bodyObserver is NOT disconnected here — it continues watching
	// so it can detect a replacement region if the user toggles captions
	// off and back on (Google Meet removes the old region and creates a new one).

	// Disconnect previous observer if re-attaching
	if (captionObserver) {
		captionObserver.disconnect();
	}

	captionObserver = new MutationObserver(() => {
		onCaptionMutation();
	});

	captionObserver.observe(region, {
		childList: true,
		characterData: true,
		subtree: true,
	});

	updateIndicator();
}

function startBodyObserver(): void {
	// Check if caption region already exists
	const existing = findCaptionRegion();
	if (existing) {
		observeCaptionRegion(existing);
	}

	// If already running, don't create another
	if (bodyObserver) return;

	bodyObserver = new MutationObserver(() => {
		// Fast path: current region is still in the DOM — nothing to do
		if (captionRegion?.isConnected) return;

		// Region was removed (captions toggled off) — clean up stale references
		if (captionRegion && !captionRegion.isConnected) {
			console.log(
				"[MJ] Caption region disconnected — searching for replacement",
			);
			if (captionObserver) {
				captionObserver.disconnect();
				captionObserver = null;
			}
			captionRegion = null;
			captionAncestors = [];
			updateIndicator();
		}

		// Search for a new caption region (appears when user re-enables captions)
		const region = findCaptionRegion();
		if (region) {
			console.log("[MJ] Caption region (re)detected — attaching observer");
			observeCaptionRegion(region);
		}
	});

	bodyObserver.observe(document.body, {
		childList: true,
		subtree: true,
	});
}

// ─── Caption Guard (click interception) ─────────────────────────────────────

/**
 * Check if a click target is inside the caption toggle button.
 */
function isCaptionButtonClick(target: HTMLElement): boolean {
	const btn = target.closest("button");
	if (!btn) return false;
	const symbol = btn.querySelector(".google-symbols");
	if (!symbol) return false;
	const text = symbol.textContent?.trim();
	return text === "closed_caption" || text === "closed_caption_off";
}

function dismissConfirmDialog(): void {
	if (captionConfirmDialog) {
		captionConfirmDialog.remove();
		captionConfirmDialog = null;
	}
}

/**
 * Capturing-phase click handler on document.
 * Intercepts clicks on the caption button when captions are ON,
 * preventing accidental turn-off.
 */
function onCaptionGuardClick(e: MouseEvent): void {
	if (!inMeeting || meetingEnded) return;
	if (captionGuardBypass) return;
	if (!areCaptionsOn()) return;

	const target = e.target as HTMLElement;
	if (!isCaptionButtonClick(target)) return;

	// Block the click
	e.stopPropagation();
	e.preventDefault();

	console.log("[MJ] Caption off click intercepted — showing confirmation");
	showCaptionGuardConfirm();
}

function showCaptionGuardConfirm(): void {
	if (captionConfirmDialog) return;

	const container = document.createElement("div");
	Object.assign(container.style, {
		position: "fixed",
		top: "16px",
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: "99999",
		padding: "12px 20px",
		borderRadius: "8px",
		backgroundColor: "#d93025",
		color: "#fff",
		fontSize: "13px",
		fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
		boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
		display: "flex",
		alignItems: "center",
		gap: "12px",
	});

	const msg = document.createElement("span");
	msg.textContent = "字幕をOFFにすると録音が停止します。OFFにしますか？";
	container.appendChild(msg);

	const confirmBtn = document.createElement("button");
	confirmBtn.textContent = "OFFにする";
	Object.assign(confirmBtn.style, {
		padding: "4px 12px",
		borderRadius: "4px",
		border: "1px solid #fff",
		backgroundColor: "transparent",
		color: "#fff",
		fontSize: "13px",
		cursor: "pointer",
		whiteSpace: "nowrap",
	});
	confirmBtn.addEventListener("click", () => {
		dismissConfirmDialog();
		// Bypass the guard for this one click
		captionGuardBypass = true;
		const btn = findCaptionButton();
		if (btn) btn.click();
		captionGuardBypass = false;
	});
	container.appendChild(confirmBtn);

	const cancelBtn = document.createElement("button");
	cancelBtn.textContent = "キャンセル";
	Object.assign(cancelBtn.style, {
		padding: "4px 12px",
		borderRadius: "4px",
		border: "none",
		backgroundColor: "rgba(255,255,255,0.2)",
		color: "#fff",
		fontSize: "13px",
		cursor: "pointer",
		whiteSpace: "nowrap",
	});
	cancelBtn.addEventListener("click", dismissConfirmDialog);
	container.appendChild(cancelBtn);

	document.body.appendChild(container);
	captionConfirmDialog = container;
}

function startCaptionGuard(): void {
	if (captionGuardActive) return;
	captionGuardActive = true;
	document.addEventListener("click", onCaptionGuardClick, true);
}

function stopCaptionGuard(): void {
	if (!captionGuardActive) return;
	captionGuardActive = false;
	document.removeEventListener("click", onCaptionGuardClick, true);
	dismissConfirmDialog();
}

// ─── Exit Protection ─────────────────────────────────────────────────────────

function attachLeaveButtonListener(): void {
	const leaveBtn = findLeaveButton();
	if (!leaveBtn) return;

	leaveBtn.addEventListener(
		"click",
		() => {
			handleMeetingEnd();
		},
		{ once: true },
	);
}

async function handleMeetingEnd(): Promise<void> {
	if (meetingEnded) return;
	meetingEnded = true;

	// Cancel grace period timer if active (e.g. explicit leave button click)
	if (rejoinGraceTimer !== null) {
		clearTimeout(rejoinGraceTimer);
		rejoinGraceTimer = null;
	}

	// Commit any in-progress block
	commitCurrentBlock();

	// Flush all pending blocks — retry once if the first attempt fails
	await flushPendingBlocks();
	if (pendingBlocks.length > 0 || pendingRawEntries.length > 0) {
		console.warn("[MJ] First flush failed at meeting end, retrying...");
		await new Promise((r) => setTimeout(r, 1000));
		await flushPendingBlocks();
	}

	if (pendingBlocks.length > 0 || pendingRawEntries.length > 0) {
		console.error(
			`[MJ] Data loss: ${pendingBlocks.length} blocks and ${pendingRawEntries.length} raw entries could not be flushed`,
		);
	}

	// Send MEETING_ENDED
	if (sessionId) {
		try {
			const message: MeetingEndedMessage = {
				type: "MEETING_ENDED",
				payload: { sessionId },
			};
			await browser.runtime.sendMessage(message);
		} catch (e) {
			console.warn("[MJ] Failed to send MEETING_ENDED:", e);
		}
	}

	cleanup();
}

function setupExitProtection(): void {
	// Leave button click listener
	attachLeaveButtonListener();

	// Visibility change — flush but do NOT end meeting
	document.addEventListener("visibilitychange", onVisibilityChange);

	// Before unload
	window.addEventListener("beforeunload", onBeforeUnload);
}

function onVisibilityChange(): void {
	if (document.visibilityState === "hidden" && inMeeting) {
		// Tab became hidden — flush pending blocks as a safety measure,
		// but do NOT end the meeting. Users frequently switch tabs during meetings.
		commitCurrentBlock();
		flushPendingBlocks();
	}
}

function onBeforeUnload(): void {
	if (rejoinGraceTimer !== null) {
		clearTimeout(rejoinGraceTimer);
		rejoinGraceTimer = null;
	}

	if (!inMeeting && !sessionId) return;

	commitCurrentBlock();

	// Send TRANSCRIPT_UPDATE first, then MEETING_ENDED
	// Both are fire-and-forget in beforeunload, but ordering matters
	if ((pendingBlocks.length > 0 || pendingRawEntries.length > 0) && sessionId) {
		const updateMessage: TranscriptUpdateMessage = {
			type: "TRANSCRIPT_UPDATE",
			payload: {
				sessionId,
				blocks: [...pendingBlocks],
				rawEntries: [...pendingRawEntries],
			},
		};
		try {
			browser.runtime.sendMessage(updateMessage);
		} catch {
			// Best effort
		}
	}

	if (sessionId) {
		const endMessage: MeetingEndedMessage = {
			type: "MEETING_ENDED",
			payload: { sessionId },
		};
		try {
			browser.runtime.sendMessage(endMessage);
		} catch {
			// Best effort
		}
	}
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** Pause observers and timers but keep sessionId and counts for possible rejoin. */
function suspendSession(): void {
	inMeeting = false;

	stopCaptionGuard();

	if (keepaliveTimer !== null) {
		clearInterval(keepaliveTimer);
		keepaliveTimer = null;
	}

	if (flushTimer !== null) {
		clearInterval(flushTimer);
		flushTimer = null;
	}

	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}

	if (bodyObserver) {
		bodyObserver.disconnect();
		bodyObserver = null;
	}

	if (captionObserver) {
		captionObserver.disconnect();
		captionObserver = null;
	}

	captionRegion = null;
	captionAncestors = [];
	currentBlock = null;
	lastSeenCaptions = [];

	removeToggleButton();
	removeIndicatorPanel();

	document.removeEventListener("visibilitychange", onVisibilityChange);
	window.removeEventListener("beforeunload", onBeforeUnload);
}

/** Fully end the session and reset all state. */
function cleanup(): void {
	suspendSession();

	pendingBlocks = [];
	pendingRawEntries = [];
	totalRawCount = 0;
	sessionId = null;
}

// ─── Rejoin Grace Period ────────────────────────────────────────────────────

function startRejoinGracePeriod(): void {
	// Flush current data before suspending
	commitCurrentBlock();
	flushPendingBlocks();

	suspendSession();

	rejoinGraceTimer = setTimeout(() => {
		rejoinGraceTimer = null;
		handleMeetingEnd();
	}, REJOIN_GRACE_PERIOD_MS);
}

// ─── Meeting Session Setup ───────────────────────────────────────────────────

/**
 * Common setup after entering (or re-entering) a meeting:
 * enable captions, start the guard, begin observing, and arm timers.
 * Called by both onMeetingDetected (new session) and onMeetingResumed (rejoin).
 */
async function setupMeetingSession(notFoundMessage: string): Promise<void> {
	const captionsEnabled = await enableCaptions(
		CAPTION_MAX_RETRIES,
		CAPTION_RETRY_INTERVAL_MS,
	);
	if (!captionsEnabled) {
		showNotification(notFoundMessage, "warning", 8000);
	}

	startCaptionGuard();
	startBodyObserver();

	flushTimer = setInterval(() => {
		commitCurrentBlock();
		flushPendingBlocks();
	}, FLUSH_INTERVAL_MS);

	// Keep the MV3 service worker alive by pinging it periodically.
	// Without this, Chrome may terminate the worker after ~30s of inactivity
	// (e.g. between flush intervals when no captions are pending).
	keepaliveTimer = setInterval(() => {
		browser.runtime.sendMessage({ type: "KEEPALIVE" }).catch(() => {
			// Best effort — if this fails, the next flush will restart the worker
		});
	}, KEEPALIVE_INTERVAL_MS);

	setupExitProtection();
}

async function onMeetingResumed(): Promise<void> {
	inMeeting = true;
	meetingEnded = false;

	await setupMeetingSession(
		"ミートジャーキー: 字幕ボタンが見つかりませんでした。",
	);
}

// ─── Meeting Start ───────────────────────────────────────────────────────────

async function onMeetingDetected(): Promise<void> {
	if (inMeeting) return;
	inMeeting = true;
	meetingEnded = false;

	const meetingCode = extractMeetingCode();
	const meetingTitle = extractMeetingTitle();
	const startTimestamp = new Date().toISOString();

	sessionId = crypto.randomUUID();

	// Retry MEETING_STARTED up to 3 times
	const message: MeetingStartedMessage = {
		type: "MEETING_STARTED",
		payload: { sessionId, meetingCode, meetingTitle, startTimestamp },
	};

	let started = false;
	for (let attempt = 0; attempt < MEETING_START_MAX_RETRIES; attempt++) {
		try {
			const response = await browser.runtime.sendMessage(message);
			if (response?.success) {
				started = true;
				break;
			}
		} catch (e) {
			console.warn(`[MJ] MEETING_STARTED attempt ${attempt + 1} failed:`, e);
		}
		if (attempt < MEETING_START_MAX_RETRIES - 1) {
			await new Promise((r) => setTimeout(r, MEETING_START_RETRY_MS));
		}
	}

	if (!started) {
		showNotification(
			"ミートジャーキー: セッション開始に失敗しました。ページを再読み込みしてください。",
			"error",
			10000,
		);
		cleanup();
		return;
	}

	await setupMeetingSession(
		"ミートジャーキー: 字幕ボタンが見つかりませんでした。ホストが字幕を無効にしている可能性があります。",
	);

	// Warn if caption region doesn't appear within the timeout
	setTimeout(() => {
		if (!captionRegion && inMeeting && !meetingEnded) {
			showNotification(
				"ミートジャーキー: 字幕領域が検出されませんでした。字幕が有効になっているか確認してください。",
				"warning",
				8000,
			);
		}
	}, CAPTION_REGION_TIMEOUT_MS);
}

// ─── Meeting Detection Polling ───────────────────────────────────────────────

function startMeetingDetection(): void {
	// Check immediately
	if (isInMeeting()) {
		onMeetingDetected();
	}

	// Poll periodically — keeps running to detect re-entry after disconnection
	setInterval(() => {
		const currentlyInMeeting = isInMeeting();

		if (!inMeeting && currentlyInMeeting) {
			if (rejoinGraceTimer !== null) {
				// Rejoined within grace period — resume existing session
				clearTimeout(rejoinGraceTimer);
				rejoinGraceTimer = null;
				console.log(
					"[MJ] Rejoin detected within grace period, resuming session:",
					sessionId,
				);
				onMeetingResumed();
			} else {
				// Fresh entry
				onMeetingDetected();
			}
		} else if (inMeeting && !currentlyInMeeting && !meetingEnded) {
			// User left the meeting — start grace period instead of ending immediately
			startRejoinGracePeriod();
		}
	}, POLLING_INTERVAL_MS);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default defineContentScript({
	matches: ["*://meet.google.com/*"],
	main() {
		console.log("[MJ] Content script loaded");
		startMeetingDetection();
	},
});
