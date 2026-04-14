import { describe, expect, it } from "vitest";
import {
	buildTemplateContext,
	expandTemplate,
	formatDuration,
	generateMinutes,
	type TemplateContext,
} from "../template";
import type { MeetingSession } from "../types";

// --- Test data helper ---

function createTestSession(
	overrides?: Partial<MeetingSession>,
): MeetingSession {
	return {
		sessionId: "test-session-1",
		meetingCode: "abc-defg-hij",
		meetingTitle: "週次定例",
		startTimestamp: "2026-04-14T10:00:00.000Z",
		endTimestamp: "2026-04-14T11:30:00.000Z",
		transcript: [
			{
				personName: "田中",
				timestamp: "2026-04-14T10:05:00.000Z",
				transcriptText: "今日の議題を確認します",
			},
			{
				personName: "鈴木",
				timestamp: "2026-04-14T10:06:00.000Z",
				transcriptText: "了解です",
			},
			{
				personName: "田中",
				timestamp: "2026-04-14T10:07:00.000Z",
				transcriptText: "では始めましょう",
			},
		],
		rawTranscript: [],
		...overrides,
	};
}

/** Compute expected "YYYY年MM月DD日" for an ISO string, matching the implementation. */
function expectedDate(isoString: string): string {
	const d = new Date(isoString);
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Compute expected "HH:MM" for an ISO string, matching the implementation. */
function expectedTimeHHMM(isoString: string): string {
	const d = new Date(isoString);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

// --- expandTemplate ---

describe("expandTemplate", () => {
	const baseContext: TemplateContext = {
		title: "テスト会議",
		code: "abc-defg-hij",
		date: "2026年4月14日",
		startTime: "19:00",
		endTime: "20:30",
		duration: "1時間30分",
		participants: "田中, 鈴木",
		participantCount: "2",
		transcriptCount: "3",
		transcript: "テスト議事録",
	};

	it("基本的な変数置換: {{title}} が値に置き換わる", () => {
		const result = expandTemplate("会議名: {{title}}", baseContext);
		expect(result).toBe("会議名: テスト会議");
	});

	it("1つのテンプレートで複数の変数が置き換わる", () => {
		const result = expandTemplate(
			"{{title}} ({{date}} {{startTime}}〜{{endTime}})",
			baseContext,
		);
		expect(result).toBe("テスト会議 (2026年4月14日 19:00〜20:30)");
	});

	it("同じ変数が複数回使われた場合、すべて置き換わる", () => {
		const result = expandTemplate(
			"{{title}} - {{title}} - {{title}}",
			baseContext,
		);
		expect(result).toBe("テスト会議 - テスト会議 - テスト会議");
	});

	it("未知の変数 {{unknown}} は空文字列に置き換わる", () => {
		const result = expandTemplate("前{{unknown}}後", baseContext);
		expect(result).toBe("前後");
	});

	it("変数を含まないテンプレートはそのまま返される", () => {
		const result = expandTemplate("変数なしのテキスト", baseContext);
		expect(result).toBe("変数なしのテキスト");
	});

	it("空テンプレートは空文字列を返す", () => {
		const result = expandTemplate("", baseContext);
		expect(result).toBe("");
	});

	it("特殊文字を含むコンテキスト値はエスケープされない（プレーンテキスト）", () => {
		const contextWithSpecial: TemplateContext = {
			...baseContext,
			title: '<script>alert("xss")</script> & "引用符"',
		};
		const result = expandTemplate("タイトル: {{title}}", contextWithSpecial);
		expect(result).toBe('タイトル: <script>alert("xss")</script> & "引用符"');
	});
});

// --- formatDuration ---

describe("formatDuration", () => {
	it("時間と分: 1時間30分", () => {
		const result = formatDuration(
			"2026-04-14T10:00:00.000Z",
			"2026-04-14T11:30:00.000Z",
		);
		expect(result).toBe("1時間30分");
	});

	it("ちょうどの時間: 2時間", () => {
		const result = formatDuration(
			"2026-04-14T10:00:00.000Z",
			"2026-04-14T12:00:00.000Z",
		);
		expect(result).toBe("2時間");
	});

	it("分のみ: 45分", () => {
		const result = formatDuration(
			"2026-04-14T10:00:00.000Z",
			"2026-04-14T10:45:00.000Z",
		);
		expect(result).toBe("45分");
	});

	it("ゼロ時間: 同じ開始・終了 → 0分", () => {
		const result = formatDuration(
			"2026-04-14T10:00:00.000Z",
			"2026-04-14T10:00:00.000Z",
		);
		expect(result).toBe("0分");
	});

	it("長時間の会議: 3時間15分", () => {
		const result = formatDuration(
			"2026-04-14T10:00:00.000Z",
			"2026-04-14T13:15:00.000Z",
		);
		expect(result).toBe("3時間15分");
	});
});

// --- buildTemplateContext ---

describe("buildTemplateContext", () => {
	it("meetingTitle がある場合、title に meetingTitle が使われる", () => {
		const session = createTestSession({ meetingTitle: "カスタムタイトル" });
		const ctx = buildTemplateContext(session);
		expect(ctx.title).toBe("カスタムタイトル");
	});

	it("meetingTitle が空の場合、title に meetingCode がフォールバックされる", () => {
		const session = createTestSession({ meetingTitle: "" });
		const ctx = buildTemplateContext(session);
		expect(ctx.title).toBe("abc-defg-hij");
	});

	it("code に meetingCode が設定される", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.code).toBe("abc-defg-hij");
	});

	it('date が "YYYY年MM月DD日" 形式でフォーマットされる', () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.date).toBe(expectedDate("2026-04-14T10:00:00.000Z"));
	});

	it('startTime が "HH:MM" 形式（秒なし）でフォーマットされる', () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.startTime).toBe(expectedTimeHHMM("2026-04-14T10:00:00.000Z"));
	});

	it('endTime が "HH:MM" 形式（秒なし）でフォーマットされる', () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.endTime).toBe(expectedTimeHHMM("2026-04-14T11:30:00.000Z"));
	});

	it("duration が正しく計算される", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.duration).toBe("1時間30分");
	});

	it("participants がカンマ区切りの参加者名になる", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.participants).toBe("田中, 鈴木");
	});

	it("participantCount が正しくカウントされる", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.participantCount).toBe("2");
	});

	it("transcriptCount が正しくカウントされる", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.transcriptCount).toBe("3");
	});

	it("transcript に話者名とタイムスタンプが含まれる", () => {
		const session = createTestSession();
		const ctx = buildTemplateContext(session);
		expect(ctx.transcript).toContain("**田中**");
		expect(ctx.transcript).toContain("**鈴木**");
		expect(ctx.transcript).toContain("今日の議題を確認します");
		expect(ctx.transcript).toContain("了解です");
		expect(ctx.transcript).toContain("では始めましょう");
	});

	it("startTimestamp が空の場合、date と startTime は空文字列になる", () => {
		const session = createTestSession({ startTimestamp: "" });
		const ctx = buildTemplateContext(session);
		expect(ctx.date).toBe("");
		expect(ctx.startTime).toBe("");
	});

	it("endTimestamp が空の場合、endTime は空文字列で duration は 0分", () => {
		const session = createTestSession({ endTimestamp: "" });
		const ctx = buildTemplateContext(session);
		expect(ctx.endTime).toBe("");
		expect(ctx.duration).toBe("0分");
	});

	it("transcript が空の場合、participants は空文字列で participantCount は 0", () => {
		const session = createTestSession({ transcript: [] });
		const ctx = buildTemplateContext(session);
		expect(ctx.participants).toBe("");
		expect(ctx.participantCount).toBe("0");
		expect(ctx.transcriptCount).toBe("0");
		expect(ctx.transcript).toBe("");
	});
});

// --- generateMinutes ---

describe("generateMinutes", () => {
	it("テンプレート未指定の場合、デフォルトテンプレートが使われる", () => {
		const session = createTestSession();
		const result = generateMinutes(session);
		// デフォルトテンプレートの特徴的な見出しが含まれる
		expect(result).toContain("## 議事録");
		expect(result).toContain("## 決定事項");
		expect(result).toContain("## TODO");
	});

	it("空文字列を渡した場合、デフォルトテンプレートが使われる", () => {
		const session = createTestSession();
		const result = generateMinutes(session, "");
		expect(result).toContain("## 議事録");
		expect(result).toContain("## 決定事項");
	});

	it("カスタムテンプレートを指定した場合、そのテンプレートが使われる", () => {
		const session = createTestSession();
		const customTemplate = "# {{title}}\n参加者: {{participants}}";
		const result = generateMinutes(session, customTemplate);
		expect(result).toBe("# 週次定例\n参加者: 田中, 鈴木");
	});

	it("デフォルトテンプレートの出力にセッション情報が含まれる", () => {
		const session = createTestSession();
		const result = generateMinutes(session);
		expect(result).toContain("# 週次定例");
		expect(result).toContain("田中, 鈴木");
		expect(result).toContain("2名");
		expect(result).toContain("1時間30分");
		expect(result).toContain("今日の議題を確認します");
	});
});
