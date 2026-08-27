import { describe, expect, it } from "vitest";
import {
	buildDownloadPath,
	buildSessionDownload,
	formatSessionForDownload,
	sanitizeFileNamePart,
	sanitizeSubfolder,
	shouldAutoDownload,
} from "../download";
import type {
	AutoDownloadSettings,
	MeetingSession,
	TranscriptBlock,
} from "../types";

// --- Helpers ---

function makeBlock(
	personName: string,
	timestamp: string,
	transcriptText: string,
): TranscriptBlock {
	return { personName, timestamp, transcriptText };
}

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
	return {
		sessionId: "s1",
		meetingCode: "abc-defg-hij",
		meetingTitle: "定例MTG",
		startTimestamp: "2026-08-27T01:00:12.000Z",
		endTimestamp: "2026-08-27T01:30:00.000Z",
		transcript: [
			makeBlock("田中", "2026-08-27T01:00:12.000Z", "今日の議題は三つあります"),
			makeBlock("佐藤", "2026-08-27T01:00:30.000Z", "了解です"),
		],
		rawTranscript: [],
		...overrides,
	};
}

function makeSettings(
	overrides: Partial<AutoDownloadSettings> = {},
): AutoDownloadSettings {
	return {
		enabled: true,
		format: "txt",
		subfolder: "meet-jerky",
		saveAs: false,
		...overrides,
	};
}

// --- sanitizeFileNamePart ---

describe("sanitizeFileNamePart", () => {
	it("ファイル名に使えない文字をアンダースコアに置き換える", () => {
		expect(sanitizeFileNamePart('a/b\\c:d*e?f"g<h>i|j')).toBe(
			"a_b_c_d_e_f_g_h_i_j",
		);
	});

	it("前後の空白とドットを取り除く", () => {
		expect(sanitizeFileNamePart("  ..定例MTG.. ")).toBe("定例MTG");
	});

	it("連続する空白を1つにまとめる", () => {
		expect(sanitizeFileNamePart("定例   MTG")).toBe("定例 MTG");
	});

	it("長すぎる名前を切り詰める", () => {
		const result = sanitizeFileNamePart("あ".repeat(200));
		expect(result.length).toBeLessThanOrEqual(80);
	});

	it("使える文字が残らない場合は空文字を返す", () => {
		expect(sanitizeFileNamePart("///")).toBe("");
	});
});

// --- sanitizeSubfolder ---

describe("sanitizeSubfolder", () => {
	it("素の相対パスをそのまま通す", () => {
		expect(sanitizeSubfolder("meet-jerky/2026")).toBe("meet-jerky/2026");
	});

	it("先頭と末尾のスラッシュを取り除く", () => {
		expect(sanitizeSubfolder("/meet-jerky/")).toBe("meet-jerky");
	});

	it("バックスラッシュをスラッシュに正規化する", () => {
		expect(sanitizeSubfolder("meet-jerky\\2026")).toBe("meet-jerky/2026");
	});

	it("ダウンロードフォルダの外に出る親参照を捨てる", () => {
		expect(sanitizeSubfolder("../../etc/meet-jerky")).toBe("etc/meet-jerky");
	});

	it("絶対パスをダウンロードフォルダ配下の相対パスに落とす", () => {
		// Chrome の downloads.download はダウンロードフォルダ外への保存を許さないため、
		// 絶対パス指定は拒否せず相対パスとして扱う
		expect(sanitizeSubfolder("/Users/me/Documents")).toBe("Users/me/Documents");
	});

	it("空文字や空白のみならサブフォルダなしとする", () => {
		expect(sanitizeSubfolder("   ")).toBe("");
	});
});

// --- buildDownloadPath ---

describe("buildDownloadPath", () => {
	it("サブフォルダ + 日時 + タイトル + 拡張子 の相対パスを作る", () => {
		const path = buildDownloadPath(makeSession(), makeSettings());
		expect(path).toMatch(/^meet-jerky\/\d{8}-\d{4}_定例MTG\.txt$/);
	});

	it("形式に応じて拡張子を変える", () => {
		const md = buildDownloadPath(makeSession(), makeSettings({ format: "md" }));
		expect(md).toMatch(/\.md$/);

		const json = buildDownloadPath(
			makeSession(),
			makeSettings({ format: "json" }),
		);
		expect(json).toMatch(/\.json$/);
	});

	it("サブフォルダ未指定ならファイル名だけを返す", () => {
		const path = buildDownloadPath(
			makeSession(),
			makeSettings({ subfolder: "" }),
		);
		expect(path).toMatch(/^\d{8}-\d{4}_定例MTG\.txt$/);
	});

	it("タイトルが空なら会議コードを使う", () => {
		const path = buildDownloadPath(
			makeSession({ meetingTitle: "" }),
			makeSettings(),
		);
		expect(path).toContain("abc-defg-hij");
	});

	it("タイトルも会議コードも無ければ既定名を使う", () => {
		const path = buildDownloadPath(
			makeSession({ meetingTitle: "", meetingCode: "" }),
			makeSettings(),
		);
		expect(path).toMatch(/_meeting\.txt$/);
	});
});

// --- formatSessionForDownload ---

describe("formatSessionForDownload", () => {
	it("txt はコピーと同じ整形テキストを返す", () => {
		const text = formatSessionForDownload(makeSession(), "txt");
		expect(text).toContain("参加者: 田中, 佐藤");
		expect(text).toContain("今日の議題は三つあります");
	});

	it("md は見出しとメタ情報を含む", () => {
		const md = formatSessionForDownload(makeSession(), "md");
		expect(md).toContain("# 定例MTG");
		expect(md).toContain("- 会議コード: abc-defg-hij");
		expect(md).toContain("- 参加者: 田中, 佐藤");
		expect(md).toContain("## 文字起こし");
		expect(md).toContain("**田中**");
		expect(md).toContain("今日の議題は三つあります");
	});

	it("md は AI 要約があれば含める", () => {
		const md = formatSessionForDownload(
			makeSession({
				aiSummary: {
					text: "要約本文",
					model: "gpt-x",
					generatedAt: "2026-08-27T02:00:00.000Z",
				},
			}),
			"md",
		);
		expect(md).toContain("## AI要約");
		expect(md).toContain("要約本文");
	});

	it("json は重複除去済みの文字起こしを構造化して返す", () => {
		const json = JSON.parse(formatSessionForDownload(makeSession(), "json"));
		expect(json.meetingTitle).toBe("定例MTG");
		expect(json.participants).toEqual(["田中", "佐藤"]);
		expect(json.transcript).toHaveLength(2);
		expect(json.transcript[0]).toMatchObject({
			personName: "田中",
			transcriptText: "今日の議題は三つあります",
		});
	});

	it("確定ブロックが無ければ raw ログにフォールバックする", () => {
		const session = makeSession({
			transcript: [],
			rawTranscript: [
				{
					timestamp: "2026-08-27T01:00:12.000Z",
					personName: "田中",
					text: "生ログ",
				},
			],
		});
		expect(formatSessionForDownload(session, "txt")).toContain("生ログ");
		expect(formatSessionForDownload(session, "md")).toContain("生ログ");
		const json = JSON.parse(formatSessionForDownload(session, "json"));
		expect(json.transcript[0].transcriptText).toBe("生ログ");
	});
});

// --- shouldAutoDownload ---

describe("shouldAutoDownload", () => {
	it("設定が有効で文字起こしがあれば true", () => {
		expect(shouldAutoDownload(makeSession(), makeSettings())).toBe(true);
	});

	it("設定が無効なら false", () => {
		expect(
			shouldAutoDownload(makeSession(), makeSettings({ enabled: false })),
		).toBe(false);
	});

	it("文字起こしが空なら false", () => {
		expect(
			shouldAutoDownload(
				makeSession({ transcript: [], rawTranscript: [] }),
				makeSettings(),
			),
		).toBe(false);
	});

	it("すでにダウンロード済みなら false", () => {
		expect(
			shouldAutoDownload(
				makeSession({ autoDownloadedAt: "2026-08-27T01:30:01.000Z" }),
				makeSettings(),
			),
		).toBe(false);
	});
});

// --- buildSessionDownload ---

describe("buildSessionDownload", () => {
	it("data URL とファイル名を返す", () => {
		const result = buildSessionDownload(makeSession(), makeSettings());
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.filename).toMatch(/^meet-jerky\/.+\.txt$/);
		expect(result.url).toMatch(/^data:text\/plain;charset=utf-8;base64,/);
	});

	it("data URL は UTF-8 の日本語を復元できる", () => {
		const result = buildSessionDownload(makeSession(), makeSettings());
		if (!result) throw new Error("result is null");
		const base64 = result.url.slice(result.url.indexOf(",") + 1);
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const decoded = new TextDecoder().decode(bytes);
		expect(decoded).toContain("今日の議題は三つあります");
	});

	it("形式ごとに MIME タイプを切り替える", () => {
		const md = buildSessionDownload(
			makeSession(),
			makeSettings({ format: "md" }),
		);
		expect(md?.url.startsWith("data:text/markdown;charset=utf-8;base64,")).toBe(
			true,
		);

		const json = buildSessionDownload(
			makeSession(),
			makeSettings({ format: "json" }),
		);
		expect(
			json?.url.startsWith("data:application/json;charset=utf-8;base64,"),
		).toBe(true);
	});

	it("ダウンロード対象でないセッションには null を返す", () => {
		expect(
			buildSessionDownload(
				makeSession({ transcript: [], rawTranscript: [] }),
				makeSettings(),
			),
		).toBeNull();
	});
});
