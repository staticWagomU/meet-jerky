import { loadSettings } from "./settings";

export interface SessionIndexEntry {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
	/** Pinned sessions are exempt from all retention cleanup. */
	pinned?: boolean;
}

/** Storage operations required by retention functions. */
export interface RetentionDeps {
	loadSessionIndex: () => Promise<SessionIndexEntry[]>;
	deleteSessionFromStorage: (sessionId: string) => Promise<void>;
}

/** Deps for the full retention policy, including empty-session cleanup. */
export interface RetentionPolicyDeps extends RetentionDeps {
	/** Transcript block count for a stored session, or null if not found. */
	getTranscriptCount: (sessionId: string) => Promise<number | null>;
}

/**
 * Delete oldest unpinned sessions so that at most `maxSessions` remain.
 * Pinned sessions are never deleted and do not count toward the limit.
 */
export async function enforceSessionLimit(
	maxSessions: number,
	deps: RetentionDeps,
): Promise<void> {
	const index = await deps.loadSessionIndex();
	const unpinned = index.filter((entry) => !entry.pinned);
	if (unpinned.length <= maxSessions) return;

	// Sort by startTimestamp ascending (oldest first)
	const sorted = [...unpinned].sort(
		(a, b) =>
			new Date(a.startTimestamp).getTime() -
			new Date(b.startTimestamp).getTime(),
	);

	const toDelete = sorted.slice(0, sorted.length - maxSessions);
	for (const entry of toDelete) {
		await deps.deleteSessionFromStorage(entry.sessionId);
	}
}

/**
 * Delete unpinned sessions older than `maxDays` days.
 */
export async function enforceRetentionByDays(
	maxDays: number,
	deps: RetentionDeps,
): Promise<void> {
	const index = await deps.loadSessionIndex();
	const now = Date.now();
	const cutoff = maxDays * 24 * 60 * 60 * 1000;

	for (const entry of index) {
		if (entry.pinned) continue;
		const age = now - new Date(entry.startTimestamp).getTime();
		if (age > cutoff) {
			await deps.deleteSessionFromStorage(entry.sessionId);
		}
	}
}

/**
 * Delete ended sessions (endTimestamp set) that have no transcript.
 * Sessions missing from storage are also removed to clean up the index.
 * Active sessions (empty endTimestamp) are never touched.
 */
export async function deleteEmptyEndedSessions(
	deps: RetentionPolicyDeps,
): Promise<void> {
	const index = await deps.loadSessionIndex();

	for (const entry of index) {
		if (!entry.endTimestamp || entry.pinned) continue;

		const count = await deps.getTranscriptCount(entry.sessionId);
		if (count === null || count === 0) {
			await deps.deleteSessionFromStorage(entry.sessionId);
		}
	}
}

/**
 * Apply retention policy based on user settings.
 * Empty ended sessions are always cleaned up first, regardless of mode.
 */
export async function enforceRetentionPolicy(
	deps: RetentionPolicyDeps,
): Promise<void> {
	await deleteEmptyEndedSessions(deps);

	const settings = await loadSettings();
	if (settings.retention.mode === "count") {
		await enforceSessionLimit(settings.retention.maxCount, deps);
	} else {
		await enforceRetentionByDays(settings.retention.maxDays, deps);
	}
}
