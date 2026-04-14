import type { ExtensionMessage } from "@/utils/messaging";
import type { MeetingSession } from "@/utils/types";
import {
	idbDeleteSession,
	idbLoadSession,
	idbSaveSession,
} from "@/utils/idb";

// --- Storage helper types ---

interface SessionIndexEntry {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
}

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

async function enforceSessionLimit(maxSessions: number): Promise<void> {
	const index = await loadSessionIndex();
	if (index.length <= maxSessions) return;

	// Sort by startTimestamp ascending (oldest first)
	const sorted = [...index].sort(
		(a, b) =>
			new Date(a.startTimestamp).getTime() -
			new Date(b.startTimestamp).getTime(),
	);

	const toDelete = sorted.slice(0, sorted.length - maxSessions);
	for (const entry of toDelete) {
		await deleteSessionFromStorage(entry.sessionId);
	}
}

const MAX_STORED_SESSIONS = 10;

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

// --- Helper to flush and end a session ---

async function flushAndEndSession(sessionId: string): Promise<void> {
	const session = sessionBuffer.get(sessionId);
	if (!session) return;

	session.endTimestamp = new Date().toISOString();
	await saveSession(session);
	await browser.alarms.clear(`persist-${sessionId}`);
	sessionBuffer.delete(sessionId);
	removeTabMapping(sessionId);

	await enforceSessionLimit(MAX_STORED_SESSIONS);
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
						return { success: true };
					}

					case "MEETING_ENDED": {
						const { sessionId } = message.payload;
						endedSessions.add(sessionId);
						await ensureSessionInBuffer(
							sessionId,
							sender.tab?.id ?? undefined,
						);
						await flushAndEndSession(sessionId);
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
								const { transcript, rawTranscript, ...metadata } = session;
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
