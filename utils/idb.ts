import type { MeetingSession } from "./types";

const DB_NAME = "meet-jerky";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";

let dbInstance: IDBDatabase | null = null;

function getDB(): Promise<IDBDatabase> {
	if (dbInstance) return Promise.resolve(dbInstance);

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
				db.createObjectStore(STORE_SESSIONS, { keyPath: "sessionId" });
			}
		};

		request.onsuccess = () => {
			dbInstance = request.result;
			// Reset cached instance if the connection is unexpectedly closed
			// (e.g. browser garbage-collects the DB during SW idle)
			dbInstance.onclose = () => {
				dbInstance = null;
			};
			resolve(dbInstance);
		};

		request.onerror = () => {
			reject(request.error);
		};
	});
}

export async function idbSaveSession(session: MeetingSession): Promise<void> {
	const db = await getDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_SESSIONS, "readwrite");
		tx.objectStore(STORE_SESSIONS).put(session);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function idbLoadSession(
	sessionId: string,
): Promise<MeetingSession | null> {
	const db = await getDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_SESSIONS, "readonly");
		const request = tx.objectStore(STORE_SESSIONS).get(sessionId);
		request.onsuccess = () =>
			resolve((request.result as MeetingSession) ?? null);
		request.onerror = () => reject(request.error);
	});
}

export async function idbDeleteSession(sessionId: string): Promise<void> {
	const db = await getDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_SESSIONS, "readwrite");
		tx.objectStore(STORE_SESSIONS).delete(sessionId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
