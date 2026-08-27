import { buildSessionDownload } from "@/utils/download";
import { idbDeleteSession, idbLoadSession, idbSaveSession } from "@/utils/idb";
import type { ExtensionMessage } from "@/utils/messaging";
import type { SessionIndexEntry } from "@/utils/retention";
import { enforceRetentionPolicy } from "@/utils/retention";
import { loadSettings, SETTINGS_STORAGE_KEY } from "@/utils/settings";
import type { MeetingSession } from "@/utils/types";

// --- Storage helpers ---

async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
	const result = await browser.storage.local.get("sessions-index");
	return (result["sessions-index"] as SessionIndexEntry[]) ?? [];
}

async function saveSessionIndex(index: SessionIndexEntry[]): Promise<void> {
	await browser.storage.local.set({ "sessions-index": index });
}

async function saveSession(session: MeetingSession): Promise<void> {
	await idbSaveSession(session);

	// Keep lightweight index in storage.local for quick popup listing
	const index = await loadSessionIndex();
	const entry: SessionIndexEntry = {
		sessionId: session.sessionId,
		meetingCode: session.meetingCode,
		meetingTitle: session.meetingTitle,
		startTimestamp: session.startTimestamp,
		endTimestamp: session.endTimestamp,
		// retention はインデックスのみを読むため、除外判定に必要な pinned を複製する
		pinned: session.pinned ?? false,
	};

	const existingIdx = index.findIndex((e) => e.sessionId === session.sessionId);
	if (existingIdx >= 0) {
		index[existingIdx] = entry;
	} else {
		index.push(entry);
	}

	await saveSessionIndex(index);
}

async function loadSession(sessionId: string): Promise<MeetingSession | null> {
	return idbLoadSession(sessionId);
}

async function deleteSessionFromStorage(sessionId: string): Promise<void> {
	await idbDeleteSession(sessionId);

	const index = await loadSessionIndex();
	const filtered = index.filter((e) => e.sessionId !== sessionId);
	await saveSessionIndex(filtered);
}

/**
 * Notify open extension pages (popup / side panel) that session data changed.
 * Fire-and-forget: rejects when no page is listening, which is the normal case.
 */
function broadcastSessionsChanged(sessionId: string): void {
	browser.runtime
		.sendMessage({ type: "SESSIONS_CHANGED", payload: { sessionId } })
		.catch(() => {});
}

// --- Retention dependency wiring ---

async function getTranscriptCount(sessionId: string): Promise<number | null> {
	const session = await loadSession(sessionId);
	return session ? session.transcript.length : null;
}

const retentionDeps = {
	loadSessionIndex,
	deleteSessionFromStorage,
	getTranscriptCount,
};

// --- In-memory state ---

const sessionBuffer = new Map<string, MeetingSession>();
const tabToSession = new Map<number, string>();
const endedSessions = new Set<string>();

// --- In-memory cleanup helpers ---

/** Remove the tab → session mapping for a given sessionId. */
function removeTabMapping(sessionId: string): void {
	for (const [tabId, sid] of tabToSession.entries()) {
		if (sid === sessionId) {
			tabToSession.delete(tabId);
			break;
		}
	}
}

// --- Auto download on meeting end ---

/**
 * Write the transcript to the download folder when the user enabled
 * auto download. Marks the session so a later MEETING_ENDED or tab-close
 * for the same meeting does not produce a second file.
 *
 * Mutates `session` instead of persisting itself — the caller saves right
 * after, so the flag rides along in that same write.
 */
async function autoDownloadTranscript(session: MeetingSession): Promise<void> {
	try {
		const settings = await loadSettings();
		const download = buildSessionDownload(session, settings.autoDownload);
		if (!download) return;

		await browser.downloads.download({
			url: download.url,
			filename: download.filename,
			saveAs: settings.autoDownload.saveAs,
			conflictAction: "uniquify",
		});

		session.autoDownloadedAt = new Date().toISOString();
	} catch (e) {
		// ダウンロード失敗でセッション保存を巻き添えにしない
		console.warn("[MJ] Auto download failed:", e);
	}
}

// --- Helper to flush and end a session ---

async function flushAndEndSession(sessionId: string): Promise<void> {
	const session = sessionBuffer.get(sessionId);
	if (!session) return;

	session.endTimestamp = new Date().toISOString();
	await autoDownloadTranscript(session);
	await saveSession(session);
	await browser.alarms.clear(`persist-${sessionId}`);
	sessionBuffer.delete(sessionId);
	removeTabMapping(sessionId);

	await enforceRetentionPolicy(retentionDeps);
}

// --- Helper to reload a session from storage into sessionBuffer ---

async function ensureSessionInBuffer(
	sessionId: string,
	tabId?: number,
): Promise<MeetingSession | null> {
	let session = sessionBuffer.get(sessionId) ?? null;
	if (!session) {
		session = await loadSession(sessionId);
		if (session) {
			sessionBuffer.set(sessionId, session);
			if (tabId != null) {
				tabToSession.set(tabId, sessionId);
			}
		}
	}
	return session;
}

// --- Migration from storage.local to IndexedDB ---

async function migrateStorageLocalToIDB(): Promise<void> {
	const { "idb-migrated": migrated } =
		await browser.storage.local.get("idb-migrated");
	if (migrated) return;

	const all = await browser.storage.local.get(null);
	const sessionKeys = Object.keys(all).filter(
		(k) => k.startsWith("session-") && k !== "sessions-index",
	);

	for (const key of sessionKeys) {
		const session = all[key] as MeetingSession;
		if (session?.sessionId) {
			await idbSaveSession(session);
		}
	}

	// Remove migrated session data from storage.local
	if (sessionKeys.length > 0) {
		await browser.storage.local.remove(sessionKeys);
	}
	await browser.storage.local.set({ "idb-migrated": true });
}

// --- Background entry point ---

export default defineBackground(() => {
	// Migrate existing data on first startup after update
	migrateStorageLocalToIDB().catch(() => {});

	// Service Worker 起動時にクリーンアップ実行
	enforceRetentionPolicy(retentionDeps).catch(() => {});

	// 設定変更を監視し、即座にクリーンアップを実行
	browser.storage.onChanged.addListener(async (changes, areaName) => {
		if (areaName !== "local") return;
		if (!changes[SETTINGS_STORAGE_KEY]) return;

		await enforceRetentionPolicy(retentionDeps);
	});

	// Message handler
	browser.runtime.onMessage.addListener(
		(
			message: ExtensionMessage,
			sender: Browser.runtime.MessageSender,
			sendResponse: (response: unknown) => void,
		) => {
			const handleMessage = async () => {
				switch (message.type) {
					case "MEETING_STARTED": {
						const { sessionId, meetingCode, meetingTitle, startTimestamp } =
							message.payload;

						const session: MeetingSession = {
							sessionId,
							meetingCode,
							meetingTitle,
							startTimestamp,
							endTimestamp: "",
							transcript: [],
							rawTranscript: [],
						};

						sessionBuffer.set(sessionId, session);

						// Track tab association
						if (sender.tab?.id != null) {
							tabToSession.set(sender.tab.id, sessionId);
						}

						// Persist immediately so the session exists in storage
						// even if no TRANSCRIPT_UPDATE arrives before the worker dies
						await saveSession(session);
						broadcastSessionsChanged(sessionId);

						// Set up periodic persistence alarm (every 1 minute)
						await browser.alarms.create(`persist-${sessionId}`, {
							periodInMinutes: 1,
						});

						return { success: true, sessionId };
					}

					case "TRANSCRIPT_UPDATE": {
						const { sessionId, blocks, rawEntries } = message.payload;

						// Reject updates for sessions that have already ended
						if (endedSessions.has(sessionId)) {
							return { success: false, error: "Session already ended" };
						}

						const wasInBuffer = sessionBuffer.has(sessionId);
						const session = await ensureSessionInBuffer(
							sessionId,
							sender.tab?.id ?? undefined,
						);

						if (!session) {
							return { success: false, error: "Session not found" };
						}

						// Re-create the persistence alarm lost on service worker restart
						if (!wasInBuffer) {
							await browser.alarms.create(`persist-${sessionId}`, {
								periodInMinutes: 1,
							});
						}

						session.transcript.push(...blocks);
						session.rawTranscript.push(...rawEntries);

						// Persist to storage on every update so data survives
						// even if MEETING_ENDED never arrives
						await saveSession(session);
						broadcastSessionsChanged(sessionId);
						return { success: true };
					}

					case "MEETING_ENDED": {
						const { sessionId } = message.payload;
						endedSessions.add(sessionId);
						await ensureSessionInBuffer(sessionId, sender.tab?.id ?? undefined);
						await flushAndEndSession(sessionId);
						broadcastSessionsChanged(sessionId);
						return { success: true };
					}

					case "GET_SESSIONS": {
						const index = await loadSessionIndex();
						// Sort by startTimestamp descending (newest first)
						const sorted = [...index].sort(
							(a, b) =>
								new Date(b.startTimestamp).getTime() -
								new Date(a.startTimestamp).getTime(),
						);

						// Return metadata with transcriptCount instead of full transcript
						const sessions = await Promise.all(
							sorted.map(async (entry) => {
								const session = await loadSession(entry.sessionId);
								if (!session) {
									return { ...entry, transcriptCount: 0 };
								}
								// 一覧には要約本文を載せない（詳細取得時のみ返す）
								const { transcript, rawTranscript, aiSummary, ...metadata } =
									session;
								return { ...metadata, transcriptCount: transcript.length };
							}),
						);

						return { sessions };
					}

					case "GET_TRANSCRIPT": {
						const { sessionId } = message.payload;
						const session = await loadSession(sessionId);
						return { session };
					}

					case "DELETE_SESSION": {
						const { sessionId } = message.payload;

						// Clear in-memory state if session is active
						sessionBuffer.delete(sessionId);
						await browser.alarms.clear(`persist-${sessionId}`);
						removeTabMapping(sessionId);
						endedSessions.add(sessionId); // Prevent re-creation from late updates

						await deleteSessionFromStorage(sessionId);
						broadcastSessionsChanged(sessionId);
						return { success: true };
					}

					case "UPDATE_SESSION_TITLE": {
						const { sessionId, meetingTitle } = message.payload;

						// Update in-memory buffer if present
						const buffered = sessionBuffer.get(sessionId);
						if (buffered) {
							buffered.meetingTitle = meetingTitle;
						}

						// Update persisted session data
						const stored = await loadSession(sessionId);
						if (!stored) {
							return { success: false, error: "Session not found" };
						}
						stored.meetingTitle = meetingTitle;
						await saveSession(stored);
						broadcastSessionsChanged(sessionId);

						return { success: true };
					}

					case "UPDATE_SESSION_PIN": {
						const { sessionId, pinned } = message.payload;

						const buffered = sessionBuffer.get(sessionId);
						if (buffered) {
							buffered.pinned = pinned;
						}

						const stored = await loadSession(sessionId);
						if (!stored) {
							return { success: false, error: "Session not found" };
						}
						stored.pinned = pinned;
						await saveSession(stored);
						broadcastSessionsChanged(sessionId);

						return { success: true };
					}

					case "UPDATE_SESSION_SUMMARY": {
						const { sessionId, aiSummary } = message.payload;

						const buffered = sessionBuffer.get(sessionId);
						if (buffered) {
							buffered.aiSummary = aiSummary;
						}

						const stored = await loadSession(sessionId);
						if (!stored) {
							return { success: false, error: "Session not found" };
						}
						stored.aiSummary = aiSummary;
						await saveSession(stored);
						broadcastSessionsChanged(sessionId);

						return { success: true };
					}

					case "KEEPALIVE": {
						return { success: true };
					}

					default:
						return { error: "Unknown message type" };
				}
			};

			// Execute async handler and send response
			handleMessage()
				.then(sendResponse)
				.catch((err) => {
					console.error("Background message handler error:", err);
					sendResponse({ error: String(err) });
				});

			// Return true to indicate async sendResponse usage
			return true;
		},
	);

	// Periodic persistence via alarms
	browser.alarms.onAlarm.addListener(async (alarm) => {
		if (!alarm.name.startsWith("persist-")) return;

		const sessionId = alarm.name.replace("persist-", "");
		const session = sessionBuffer.get(sessionId);
		if (session) {
			await saveSession(session);
			console.log(`Auto-saved session ${sessionId}`);
		}
	});

	// Tab close protection
	browser.tabs.onRemoved.addListener(async (tabId: number) => {
		const sessionId = tabToSession.get(tabId);
		if (!sessionId) return;

		console.log(`Tab ${tabId} closed, flushing session ${sessionId}`);
		await flushAndEndSession(sessionId);
	});

	console.log("Background script initialized", { id: browser.runtime.id });
});
