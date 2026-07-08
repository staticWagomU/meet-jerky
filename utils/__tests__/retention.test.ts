import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionPolicyDeps, SessionIndexEntry } from "../retention";
import {
	deleteEmptyEndedSessions,
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

function makeEntry(
	id: string,
	startTimestamp: string,
	endTimestamp = "",
	pinned = false,
): SessionIndexEntry {
	return {
		sessionId: id,
		meetingCode: `code-${id}`,
		meetingTitle: `title-${id}`,
		startTimestamp,
		endTimestamp,
		pinned,
	};
}

function makeDeps(
	entries: SessionIndexEntry[],
	transcriptCounts: Record<string, number | null> = {},
): RetentionPolicyDeps & { deleted: string[] } {
	const deleted: string[] = [];
	return {
		deleted,
		loadSessionIndex: vi.fn().mockResolvedValue(entries),
		deleteSessionFromStorage: vi.fn(async (sessionId: string) => {
			deleted.push(sessionId);
		}),
		getTranscriptCount: vi.fn(async (sessionId: string) =>
			// null = セッション欠損を表すため ?? ではなく in で判定する
			sessionId in transcriptCounts ? transcriptCounts[sessionId] : 1,
		),
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

	it("ピン留めされたセッションは削除されず、上限の数にも含まれない", async () => {
		// pinned な最古2件を除いた未ピン3件に上限2が適用される
		const deps = makeDeps([
			makeEntry("pin1", "2026-01-01T00:00:00Z", "", true),
			makeEntry("pin2", "2026-01-02T00:00:00Z", "", true),
			makeEntry("a", "2026-01-03T00:00:00Z"),
			makeEntry("b", "2026-01-04T00:00:00Z"),
			makeEntry("c", "2026-01-05T00:00:00Z"),
		]);

		await enforceSessionLimit(2, deps);

		expect(deps.deleted).toEqual(["a"]);
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

	it("ピン留めされたセッションは期限超過でも削除されない", async () => {
		const now = new Date();
		const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
		const deps = makeDeps([
			makeEntry("pinned-old", old.toISOString(), "", true),
			makeEntry("unpinned-old", old.toISOString()),
		]);

		await enforceRetentionByDays(30, deps);

		expect(deps.deleted).toEqual(["unpinned-old"]);
	});
});

// --- deleteEmptyEndedSessions ---

describe("deleteEmptyEndedSessions", () => {
	it("終了済みかつ文字起こし0件のセッションが削除される", async () => {
		const deps = makeDeps(
			[makeEntry("empty", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z")],
			{ empty: 0 },
		);

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual(["empty"]);
	});

	it("終了済みでも文字起こしがあるセッションは削除されない", async () => {
		const deps = makeDeps(
			[makeEntry("full", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z")],
			{ full: 5 },
		);

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual([]);
	});

	it("文字起こし0件でも終了していないセッションは削除されない", async () => {
		// endTimestamp が空 = 記録中のセッション
		const deps = makeDeps([makeEntry("active", "2026-07-01T00:00:00Z")], {
			active: 0,
		});

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual([]);
		expect(deps.getTranscriptCount).not.toHaveBeenCalled();
	});

	it("終了済みでセッション本体が存在しない場合、インデックスから削除される", async () => {
		const deps = makeDeps(
			[makeEntry("dangling", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z")],
			{ dangling: null },
		);

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual(["dangling"]);
	});

	it("ピン留めされたセッションは空の終了済みでも削除されない", async () => {
		const deps = makeDeps(
			[
				makeEntry(
					"pinned-empty",
					"2026-07-01T00:00:00Z",
					"2026-07-01T01:00:00Z",
					true,
				),
			],
			{ "pinned-empty": 0 },
		);

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual([]);
	});

	it("混在する場合、空の終了済みセッションのみ削除される", async () => {
		const deps = makeDeps(
			[
				makeEntry("empty", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z"),
				makeEntry("full", "2026-07-02T00:00:00Z", "2026-07-02T01:00:00Z"),
				makeEntry("active", "2026-07-03T00:00:00Z"),
			],
			{ empty: 0, full: 3, active: 0 },
		);

		await deleteEmptyEndedSessions(deps);

		expect(deps.deleted).toEqual(["empty"]);
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

	it("デフォルト設定が使われる場合、days モードで maxDays=10 が適用される", async () => {
		// loadSettings returns defaults when storage is empty
		mockGet.mockResolvedValue({});

		const now = new Date();
		const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
		const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

		const deps = makeDeps([
			makeEntry("old", fifteenDaysAgo.toISOString()),
			makeEntry("recent", fiveDaysAgo.toISOString()),
		]);

		await enforceRetentionPolicy(deps);

		// Default is days mode with maxDays=10 => only "old" is deleted
		expect(deps.deleted).toEqual(["old"]);
	});

	it("モードに関わらず、空の終了済みセッションが削除される", async () => {
		mockGet.mockResolvedValue({
			"user-settings": {
				retention: { mode: "count", maxCount: 10, maxDays: 30 },
			},
		});

		const deps = makeDeps(
			[
				makeEntry("empty", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z"),
				makeEntry("full", "2026-07-02T00:00:00Z", "2026-07-02T01:00:00Z"),
			],
			{ empty: 0, full: 3 },
		);

		await enforceRetentionPolicy(deps);

		// Only 2 sessions (within maxCount) but "empty" is ended with 0 transcripts
		expect(deps.deleted).toEqual(["empty"]);
	});
});
