import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionDeps, SessionIndexEntry } from "../retention";
import {
	enforceRetentionByDays,
	enforceRetentionPolicy,
	enforceSessionLimit,
} from "../retention";

// --- Mock browser.storage.local for loadSettings ---

const mockGet = vi.fn();

beforeEach(() => {
	vi.stubGlobal("browser", {
		storage: { local: { get: mockGet, set: vi.fn() } },
	});
	mockGet.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// --- Helpers ---

function makeEntry(id: string, startTimestamp: string): SessionIndexEntry {
	return {
		sessionId: id,
		meetingCode: `code-${id}`,
		meetingTitle: `title-${id}`,
		startTimestamp,
		endTimestamp: "",
	};
}

function makeDeps(
	entries: SessionIndexEntry[],
): RetentionDeps & { deleted: string[] } {
	const deleted: string[] = [];
	return {
		deleted,
		loadSessionIndex: vi.fn().mockResolvedValue(entries),
		deleteSessionFromStorage: vi.fn(async (sessionId: string) => {
			deleted.push(sessionId);
		}),
	};
}

// --- enforceSessionLimit ---

describe("enforceSessionLimit", () => {
	it("セッション数が上限以下の場合、何も削除されない", async () => {
		const deps = makeDeps([
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
		]);

		await enforceSessionLimit(5, deps);

		expect(deps.deleted).toEqual([]);
		expect(deps.deleteSessionFromStorage).not.toHaveBeenCalled();
	});

	it("ちょうど上限の場合、削除されない", async () => {
		const deps = makeDeps([
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
			makeEntry("c", "2026-01-03T00:00:00Z"),
		]);

		await enforceSessionLimit(3, deps);

		expect(deps.deleted).toEqual([]);
	});

	it("セッション数が上限を超えた場合、最古のセッションから削除される", async () => {
		const deps = makeDeps([
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
			makeEntry("c", "2026-01-03T00:00:00Z"),
			makeEntry("d", "2026-01-04T00:00:00Z"),
			makeEntry("e", "2026-01-05T00:00:00Z"),
		]);

		await enforceSessionLimit(3, deps);

		// oldest 2 should be deleted
		expect(deps.deleted).toEqual(["a", "b"]);
	});

	it("セッション数が上限を1つ超えた場合、最古の1件のみ削除される", async () => {
		const deps = makeDeps([
			makeEntry("x", "2026-03-01T00:00:00Z"),
			makeEntry("y", "2026-01-01T00:00:00Z"),
			makeEntry("z", "2026-02-01T00:00:00Z"),
		]);

		await enforceSessionLimit(2, deps);

		// "y" is the oldest
		expect(deps.deleted).toEqual(["y"]);
	});

	it("ソート順に関係なく最古のセッションが削除される", async () => {
		// entries passed in non-chronological order
		const deps = makeDeps([
			makeEntry("c", "2026-01-03T00:00:00Z"),
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
		]);

		await enforceSessionLimit(1, deps);

		expect(deps.deleted).toEqual(["a", "b"]);
	});
});

// --- enforceRetentionByDays ---

describe("enforceRetentionByDays", () => {
	it("全セッションが期限内の場合、何も削除されない", async () => {
		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
		const deps = makeDeps([
			makeEntry("a", oneDayAgo.toISOString()),
			makeEntry("b", now.toISOString()),
		]);

		await enforceRetentionByDays(7, deps);

		expect(deps.deleted).toEqual([]);
	});

	it("期限超過のセッションのみ削除される", async () => {
		const now = new Date();
		const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
		const deps = makeDeps([
			makeEntry("old", tenDaysAgo.toISOString()),
			makeEntry("recent", fiveDaysAgo.toISOString()),
			makeEntry("now", now.toISOString()),
		]);

		await enforceRetentionByDays(7, deps);

		expect(deps.deleted).toEqual(["old"]);
	});

	it("期限ちょうどのセッションは削除されない", async () => {
		const now = new Date();
		// Exactly 7 days ago — age === cutoff, not > cutoff
		const exactBoundary = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
		const deps = makeDeps([makeEntry("boundary", exactBoundary.toISOString())]);

		await enforceRetentionByDays(7, deps);

		expect(deps.deleted).toEqual([]);
	});

	it("期限を1ミリ秒超過したセッションは削除される", async () => {
		const now = new Date();
		const justOver = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 - 1);
		const deps = makeDeps([makeEntry("over", justOver.toISOString())]);

		await enforceRetentionByDays(7, deps);

		expect(deps.deleted).toEqual(["over"]);
	});

	it("全セッションが期限超過の場合、全て削除される", async () => {
		const now = new Date();
		const old1 = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
		const old2 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
		const deps = makeDeps([
			makeEntry("a", old1.toISOString()),
			makeEntry("b", old2.toISOString()),
		]);

		await enforceRetentionByDays(30, deps);

		expect(deps.deleted).toEqual(["a", "b"]);
	});
});

// --- enforceRetentionPolicy ---

describe("enforceRetentionPolicy", () => {
	it('mode が "count" の場合、enforceSessionLimit が呼ばれる', async () => {
		mockGet.mockResolvedValue({
			"user-settings": {
				retention: { mode: "count", maxCount: 2, maxDays: 30 },
				google: { authenticated: false },
				template: { minutesTemplate: "", customPrompt: "" },
			},
		});

		const deps = makeDeps([
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
			makeEntry("c", "2026-01-03T00:00:00Z"),
		]);

		await enforceRetentionPolicy(deps);

		// maxCount=2, so oldest 1 session should be deleted
		expect(deps.deleted).toEqual(["a"]);
	});

	it('mode が "days" の場合、enforceRetentionByDays が呼ばれる', async () => {
		const now = new Date();
		const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
		const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

		mockGet.mockResolvedValue({
			"user-settings": {
				retention: { mode: "days", maxCount: 10, maxDays: 7 },
				google: { authenticated: false },
				template: { minutesTemplate: "", customPrompt: "" },
			},
		});

		const deps = makeDeps([
			makeEntry("old", fifteenDaysAgo.toISOString()),
			makeEntry("recent", twoDaysAgo.toISOString()),
		]);

		await enforceRetentionPolicy(deps);

		// maxDays=7, so "old" (15 days ago) should be deleted
		expect(deps.deleted).toEqual(["old"]);
	});

	it("デフォルト設定が使われる場合、count モードで maxCount=10 が適用される", async () => {
		// loadSettings returns defaults when storage is empty
		mockGet.mockResolvedValue({});

		const deps = makeDeps([
			makeEntry("a", "2026-01-01T00:00:00Z"),
			makeEntry("b", "2026-01-02T00:00:00Z"),
		]);

		await enforceRetentionPolicy(deps);

		// Default is count mode with maxCount=10, only 2 sessions => no deletion
		expect(deps.deleted).toEqual([]);
	});
});
