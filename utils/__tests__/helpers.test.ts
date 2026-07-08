import { describe, expect, it } from "vitest";
import {
	computeTranscriptDiffs,
	determineCaptionAction,
	escapeHtml,
	extractMeetingCodeFromPath,
	extractParticipants,
	formatBytes,
	formatSessionCopyText,
	formatTranscriptAsText,
	isSystemMessage,
	trimAccumulatedPrefix,
} from "../helpers";

describe("extractMeetingCodeFromPath", () => {
	it("extracts meeting code from standard Meet URL path", () => {
		expect(extractMeetingCodeFromPath("/abc-defg-hij")).toBe("abc-defg-hij");
	});

	it("extracts meeting code from path with trailing segments", () => {
		expect(extractMeetingCodeFromPath("/abc-defg-hij?authuser=0")).toBe(
			"abc-defg-hij",
		);
	});

	it("returns empty string for non-matching paths", () => {
		expect(extractMeetingCodeFromPath("/")).toBe("");
		expect(extractMeetingCodeFromPath("/landing")).toBe("");
	});

	it("returns empty string for empty path", () => {
		expect(extractMeetingCodeFromPath("")).toBe("");
	});

	it("handles paths with additional segments before the code", () => {
		expect(extractMeetingCodeFromPath("/some/path/abc-defg-hij")).toBe(
			"abc-defg-hij",
		);
	});

	it("does not match codes with wrong format", () => {
		// Too many chars in first segment
		expect(extractMeetingCodeFromPath("/abcd-defg-hij")).toBe("");
		// Numbers instead of letters
		expect(extractMeetingCodeFromPath("/123-4567-890")).toBe("");
		// Uppercase letters
		expect(extractMeetingCodeFromPath("/ABC-DEFG-HIJ")).toBe("");
	});
});

describe("isSystemMessage", () => {
	it("detects English system messages", () => {
		expect(isSystemMessage("you left the meeting")).toBe(true);
		expect(isSystemMessage("John is presenting")).toBe(true);
		expect(isSystemMessage("Recording has started")).toBe(true);
		expect(isSystemMessage("Alice joined the meeting")).toBe(true);
	});

	it("detects Japanese system messages", () => {
		expect(isSystemMessage("あなたは退出しました")).toBe(true);
		expect(isSystemMessage("画面を共有しています")).toBe(true);
		expect(isSystemMessage("録画が開始されました")).toBe(true);
		expect(isSystemMessage("田中さんが参加しました")).toBe(true);
	});

	it("returns false for normal caption text", () => {
		expect(isSystemMessage("Hello, how are you?")).toBe(false);
		expect(isSystemMessage("今日の議題について話しましょう")).toBe(false);
		expect(isSystemMessage("")).toBe(false);
	});

	it("is case-insensitive for English", () => {
		expect(isSystemMessage("YOU LEFT THE MEETING")).toBe(true);
		expect(isSystemMessage("Recording Has Started")).toBe(true);
	});
});

describe("escapeHtml", () => {
	it("escapes ampersands", () => {
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	it("escapes angle brackets", () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);
	});

	it("escapes quotes", () => {
		expect(escapeHtml("\"hello\" & 'world'")).toBe(
			"&quot;hello&quot; &amp; &#039;world&#039;",
		);
	});

	it("returns empty string for empty input", () => {
		expect(escapeHtml("")).toBe("");
	});

	it("does not modify safe text", () => {
		expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
	});
});

describe("determineCaptionAction", () => {
	it("returns start action when no current block exists", () => {
		const result = determineCaptionAction(null, {
			personName: "Alice",
			text: "Hello",
		});
		expect(result).toEqual({
			action: "start",
			block: { personName: "Alice", text: "Hello" },
		});
	});

	it("returns update action when same speaker and text changes", () => {
		const current = { personName: "Alice", text: "Hello" };
		const result = determineCaptionAction(current, {
			personName: "Alice",
			text: "Hello world",
		});
		expect(result).toEqual({
			action: "update",
			block: { personName: "Alice", text: "Hello world" },
		});
	});

	it("returns commit_and_start when speaker changes", () => {
		const current = { personName: "Alice", text: "Hello" };
		const result = determineCaptionAction(current, {
			personName: "Bob",
			text: "Hi there",
		});
		expect(result).toEqual({
			action: "commit_and_start",
			commitBlock: { personName: "Alice", text: "Hello" },
			newBlock: { personName: "Bob", text: "Hi there" },
		});
	});

	it("returns commit_and_start when text decreases by threshold", () => {
		const longText = "a".repeat(300);
		const current = { personName: "Alice", text: longText };
		const result = determineCaptionAction(current, {
			personName: "Alice",
			text: "Short",
		});
		expect(result.action).toBe("commit_and_start");
	});

	it("returns update when text decreases but below threshold", () => {
		const current = {
			personName: "Alice",
			text: "Hello world, this is a test",
		};
		const result = determineCaptionAction(current, {
			personName: "Alice",
			text: "Hello world",
		});
		expect(result.action).toBe("update");
	});

	it("preserves current person name when new data has empty name", () => {
		const current = { personName: "Alice", text: "Hello" };
		const result = determineCaptionAction(current, {
			personName: "",
			text: "Hello world",
		});
		expect(result).toEqual({
			action: "update",
			block: { personName: "Alice", text: "Hello world" },
		});
	});

	it("does not treat empty-name data as a speaker change", () => {
		const current = { personName: "Alice", text: "Hello" };
		const result = determineCaptionAction(current, {
			personName: "",
			text: "Hello updated",
		});
		expect(result.action).toBe("update");
	});
});

describe("formatTranscriptAsText", () => {
	it("formats transcript blocks as plain text with participant header", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
			{
				personName: "Bob",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Hi there",
			},
		];
		// Use a mock time formatter for deterministic output
		const mockFormatTime = (iso: string) => {
			const d = new Date(iso);
			return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
		};
		const result = formatTranscriptAsText(blocks, mockFormatTime);
		expect(result).toBe(
			"参加者: Alice, Bob\n\nAlice (14:30)\nHello\n\nBob (14:31)\nHi there",
		);
	});

	it("returns empty string for empty transcript", () => {
		expect(formatTranscriptAsText([])).toBe("");
	});
});

describe("formatSessionCopyText", () => {
	const mockFormatTime = (iso: string) => {
		const d = new Date(iso);
		return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
	};

	it("prefers the deduplicated transcript even when raw entries exist", () => {
		const transcript = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "おはようございます。",
			},
		];
		const rawTranscript = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				text: "おはようござい。",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:01Z",
				text: "おはようございます。",
			},
		];
		expect(
			formatSessionCopyText(transcript, rawTranscript, mockFormatTime),
		).toBe("参加者: Alice\n\nAlice (14:30)\nおはようございます。");
	});

	it("falls back to the raw log when the transcript is empty", () => {
		const rawTranscript = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				text: "おはようございます。",
			},
		];
		expect(formatSessionCopyText([], rawTranscript, mockFormatTime)).toBe(
			"[14:30] Alice: おはようございます。",
		);
	});

	it("returns empty string when both are empty", () => {
		expect(formatSessionCopyText([], [], mockFormatTime)).toBe("");
	});
});

describe("computeTranscriptDiffs", () => {
	it("returns first entry as-is", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result[0].transcriptText).toBe("Hello");
	});

	it("absorbs prefix-chain entries, keeping only the longest version", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "いやー、まだ消えてないなぁ。",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText:
					"いやー、まだ消えてないなぁ。 うまくいってない気がするなぁ。",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText:
					"いやー、まだ消えてないなぁ。 うまくいってない気がするなぁ。 まだ消えてないね。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		// All shorter entries are absorbed by the longest accumulated version
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe(
			"いやー、まだ消えてないなぁ。 うまくいってない気がするなぁ。 まだ消えてないね。",
		);
	});

	it("does not strip when speaker changes", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello world",
			},
			{
				personName: "Bob",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Hello world and more",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result[1].transcriptText).toBe("Hello world and more");
	});

	it("does not strip when text does not start with previous text", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "First sentence.",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Completely different.",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result[1].transcriptText).toBe("Completely different.");
	});

	it("removes exact duplicate same-speaker entries (absorption)", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Hello",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe("Hello");
	});

	it("returns empty array for empty input", () => {
		expect(computeTranscriptDiffs([])).toEqual([]);
	});

	it("absorbs interleaved same-speaker accumulation and keeps full text", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
			{
				personName: "Bob",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Hi",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:32:00Z",
				transcriptText: "Hello again",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		// Alice's first fragment is absorbed by her later accumulated entry;
		// the surviving entry keeps its full text (no cross-speaker diffing)
		expect(result).toHaveLength(2);
		expect(result[0].transcriptText).toBe("Hi");
		expect(result[1].transcriptText).toBe("Hello again");
	});
});

describe("extractParticipants", () => {
	it("extracts unique participants in order of appearance", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
			{
				personName: "Bob",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "Hi",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:32:00Z",
				transcriptText: "Bye",
			},
		];
		expect(extractParticipants(blocks)).toEqual(["Alice", "Bob"]);
	});

	it("returns empty array for empty transcript", () => {
		expect(extractParticipants([])).toEqual([]);
	});

	it("handles single participant", () => {
		const blocks = [
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:30:00Z",
				transcriptText: "Hello",
			},
			{
				personName: "Alice",
				timestamp: "2026-04-03T14:31:00Z",
				transcriptText: "World",
			},
		];
		expect(extractParticipants(blocks)).toEqual(["Alice"]);
	});
});

// ─── computeTranscriptDiffs: 重複除去強化テスト ─────────────────────────────

describe("computeTranscriptDiffs — absorption", () => {
	const t = "2026-04-03T14:30:00Z";

	it("removes exact duplicate consecutive entries for same speaker", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "Hello world" },
			{ personName: "A", timestamp: t, transcriptText: "Hello world" },
			{ personName: "A", timestamp: t, transcriptText: "Hello world" },
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe("Hello world");
	});

	it("removes entries whose text is a substring of a later same-speaker entry", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "先行状況としては？" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "返答待ちが今のところ3名います。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText:
					"先行状況としては？ 返答待ちが今のところ3名います。 引き続きやっていきます。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		// Short fragments absorbed by the accumulated version
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe(
			"先行状況としては？ 返答待ちが今のところ3名います。 引き続きやっていきます。",
		);
	});

	it("removes entries absorbed by LCP (speech recognition refined ending)", () => {
		// Speech recognition changes "です。" to "ですね。" in a later version
		const blocks = [
			{
				personName: "A",
				timestamp: t,
				transcriptText: "大阪のAWSとかコンテナの構築経験豊富な方です。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText:
					"大阪のAWSとかコンテナの構築経験豊富な方ですね。昨日オファーを出しました。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe(
			"大阪のAWSとかコンテナの構築経験豊富な方ですね。昨日オファーを出しました。",
		);
	});

	it("handles real-world pattern: fragments + accumulated versions", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "画面注意します。" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "早速最近教えてもらったノートブック。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText:
					"画面注意します。 早速最近教えてもらったノートブックめっちゃ対応してます。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText:
					"画面注意します。 早速最近教えてもらったノートブックめっちゃ対応してます。 ありがとうございます。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		// All shorter entries are absorbed; only longest remains
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toContain("ありがとうございます。");
	});

	it("does not absorb across speaker boundaries", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "Hello" },
			{ personName: "B", timestamp: t, transcriptText: "Hello world" },
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(2);
		expect(result[0].transcriptText).toBe("Hello");
		expect(result[1].transcriptText).toBe("Hello world");
	});

	it("absorbs accumulated text across another speaker's interjection", () => {
		// A・Bの字幕が同時表示されるとコミット順が交互になるため、
		// 別話者を1件挟んだ同一話者の蓄積テキストも吸収する
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "画面注意します。" },
			{ personName: "B", timestamp: t, transcriptText: "はい。" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "画面注意します。 早速ノートブックを開きます。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(2);
		expect(result[0].transcriptText).toBe("はい。");
		expect(result[1].transcriptText).toBe(
			"画面注意します。 早速ノートブックを開きます。",
		);
	});

	it("keeps genuinely different same-speaker content across interjections", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "最初の話題について。" },
			{ personName: "B", timestamp: t, transcriptText: "なるほど。" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "全く別の話題に移ります。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(3);
	});

	it("keeps entries that are genuinely different content from same speaker", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "最初の話題。" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "全く別の話題について。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(2);
	});

	it("combines absorption with prefix diff for remaining entries", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "Hello" },
			{ personName: "A", timestamp: t, transcriptText: "Hello world" },
			{
				personName: "A",
				timestamp: t,
				transcriptText: "Hello world and more",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		// [0] absorbed by [1] (prefix), [1] absorbed by [2] (prefix)
		// Only [2] remains
		expect(result).toHaveLength(1);
		expect(result[0].transcriptText).toBe("Hello world and more");
	});
});

// ─── computeTranscriptDiffs: 末尾オーバーラップ除去テスト ────────────────────

describe("computeTranscriptDiffs — suffix overlap", () => {
	const t = "2026-04-03T14:30:00Z";

	it("strips the overlap when an entry starts with the previous entry's tail", () => {
		// Meetの字幕ウィンドウがスライドし、前ブロック末尾と次ブロック先頭が重なるケース
		const blocks = [
			{
				personName: "A",
				timestamp: t,
				transcriptText: "今日の議題は採用状況についてです。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText: "採用状況についてです。まず一次面接の通過率ですが。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(2);
		expect(result[1].transcriptText).toBe("まず一次面接の通過率ですが。");
	});

	it("does not strip short coincidental overlaps", () => {
		const blocks = [
			{
				personName: "A",
				timestamp: t,
				transcriptText: "承知しました了解です。",
			},
			{
				personName: "A",
				timestamp: t,
				transcriptText: "です。という返事をもらいました。",
			},
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(2);
		expect(result[1].transcriptText).toBe("です。という返事をもらいました。");
	});
});

// ─── trimAccumulatedPrefix テスト ────────────────────────────────────────────

describe("trimAccumulatedPrefix", () => {
	it("returns original text with skip=false when no lastDomText", () => {
		const result = trimAccumulatedPrefix("Hello world", undefined);
		expect(result).toEqual({ text: "Hello world", skip: false });
	});

	it("returns skip=true for exact match", () => {
		const result = trimAccumulatedPrefix("Hello world", "Hello world");
		expect(result).toEqual({ text: "Hello world", skip: true });
	});

	it("strips prefix and returns only new portion", () => {
		const result = trimAccumulatedPrefix(
			"Hello world more text",
			"Hello world",
		);
		expect(result).toEqual({ text: "more text", skip: false });
	});

	it("returns skip=true when new text is prefix with only whitespace diff", () => {
		const result = trimAccumulatedPrefix("Hello world ", "Hello world");
		expect(result).toEqual({ text: "Hello world ", skip: true });
	});

	it("passes through unrelated text unchanged", () => {
		const result = trimAccumulatedPrefix("Goodbye", "Hello world");
		expect(result).toEqual({ text: "Goodbye", skip: false });
	});

	it("handles Japanese text correctly", () => {
		const result = trimAccumulatedPrefix(
			"先行状況としては？ 返答待ちです。",
			"先行状況としては？",
		);
		expect(result).toEqual({ text: "返答待ちです。", skip: false });
	});

	it("strips prefix across long accumulated text", () => {
		const committed = "これは長い文章の最初の部分です。";
		const full = `${committed} そして続きがここにあります。`;
		const result = trimAccumulatedPrefix(full, committed);
		expect(result).toEqual({
			text: "そして続きがここにあります。",
			skip: false,
		});
	});

	it("strips prefix when trailing punctuation of committed text was revised", () => {
		// 音声認識が「〜です。」を「〜ですね。」に修正して蓄積を続けるケース
		const result = trimAccumulatedPrefix(
			"大阪の方ですね。昨日オファーを出しました。",
			"大阪の方です。",
		);
		expect(result).toEqual({
			text: "ね。昨日オファーを出しました。",
			skip: false,
		});
	});

	it("strips via LCP when recognition revised the tail of committed text", () => {
		// 語尾の1〜2文字が置き換わっても、共通プレフィックスが80%以上なら蓄積とみなす
		const result = trimAccumulatedPrefix(
			"本日の進捗を共有しますよ、まず最初に",
			"本日の進捗を共有しますね",
		);
		expect(result).toEqual({ text: "よ、まず最初に", skip: false });
	});

	it("does not strip unrelated text even when longer", () => {
		const result = trimAccumulatedPrefix(
			"まったく別の長い話をしています",
			"全然違う話",
		);
		expect(result).toEqual({
			text: "まったく別の長い話をしています",
			skip: false,
		});
	});
});

describe("formatBytes", () => {
	it("0バイトは '0 B' になる", () => {
		expect(formatBytes(0)).toBe("0 B");
	});

	it("1KB未満はバイト単位で表示される", () => {
		expect(formatBytes(512)).toBe("512 B");
	});

	it("KB単位に変換される", () => {
		expect(formatBytes(2048)).toBe("2.0 KB");
	});

	it("MB単位に変換され、小数第1位まで表示される", () => {
		expect(formatBytes(12.3 * 1024 * 1024)).toBe("12.3 MB");
	});

	it("GB単位に変換される", () => {
		expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
	});
});
