import { loadSettings } from "./settings";

export interface SessionIndexEntry {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
}

/** Storage operations required by retention functions. */
export interface RetentionDeps {
	loadSessionIndex: () => Promise<SessionIndexEntry[]>;
	deleteSessionFromStorage: (sessionId: string) => Promise<void>;
}

/**
 * Delete oldest sessions so that at most `maxSessions` remain.
 */
export async function enforceSessionLimit(
	maxSessions: number,
	deps: RetentionDeps,
): Promise<void> {
	const index = await deps.loadSessionIndex();
	if (index.length <= maxSessions) return;

	// Sort by startTimestamp ascending (oldest first)
	const sorted = [...index].sort(
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
 * Delete sessions older than `maxDays` days.
 */
export async function enforceRetentionByDays(
	maxDays: number,
	deps: RetentionDeps,
): Promise<void> {
	const index = await deps.loadSessionIndex();
	const now = Date.now();
	const cutoff = maxDays * 24 * 60 * 60 * 1000;

	for (const entry of index) {
		const age = now - new Date(entry.startTimestamp).getTime();
		if (age > cutoff) {
			await deps.deleteSessionFromStorage(entry.sessionId);
		}
	}
}

/**
 * Apply retention policy based on user settings.
 */
export async function enforceRetentionPolicy(
	deps: RetentionDeps,
): Promise<void> {
	const settings = await loadSettings();
	if (settings.retention.mode === "count") {
		await enforceSessionLimit(settings.retention.maxCount, deps);
	} else {
		await enforceRetentionByDays(settings.retention.maxDays, deps);
	}
}
