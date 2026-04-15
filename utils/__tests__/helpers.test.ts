import { describe, expect, it } from "vitest";
import {
	computeTranscriptDiffs,
	determineCaptionAction,
	escapeHtml,
	extractMeetingCodeFromPath,
	extractParticipants,
	formatSessionAsJson,
	formatSessionAsMarkdown,
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

describe("formatSessionAsJson", () => {
	it("formats a session as pretty-printed JSON", () => {
		const session = {
			sessionId: "test-id",
			meetingCode: "abc-defg-hij",
			meetingTitle: "Test Meeting",
			startTimestamp: "2026-04-03T14:30:00Z",
			endTimestamp: "2026-04-03T15:30:00Z",
			transcript: [
				{
					personName: "Alice",
					timestamp: "2026-04-03T14:30:00Z",
					transcriptText: "Hello",
				},
			],
			rawTranscript: [],
		};
		const result = formatSessionAsJson(session);
		const parsed = JSON.parse(result);
		expect(parsed.sessionId).toBe("test-id");
		expect(parsed.transcript).toHaveLength(1);
	});
});

describe("formatSessionAsMarkdown", () => {
	it("includes meeting title as h1 and participants", () => {
		const session = {
			sessionId: "test-id",
			meetingCode: "abc-defg-hij",
			meetingTitle: "Test Meeting",
			startTimestamp: "2026-04-03T14:30:00Z",
			endTimestamp: "2026-04-03T15:30:00Z",
			transcript: [
				{
					personName: "Alice",
					timestamp: "2026-04-03T14:30:00Z",
					transcriptText: "Hello",
				},
			],
			rawTranscript: [],
		};
		const mockFormatTime = () => "14:30";
		const result = formatSessionAsMarkdown(session, mockFormatTime);
		expect(result).toContain("# Test Meeting");
		expect(result).toContain("**参加者**: Alice");
		expect(result).toContain("**Alice** (14:30)");
		expect(result).toContain("Hello");
	});

	it("falls back to meeting code when no title", () => {
		const session = {
			sessionId: "test-id",
			meetingCode: "abc-defg-hij",
			meetingTitle: "",
			startTimestamp: "2026-04-03T14:30:00Z",
			endTimestamp: "",
			transcript: [],
			rawTranscript: [],
		};
		const result = formatSessionAsMarkdown(session);
		expect(result).toContain("# abc-defg-hij");
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

	it("resets diff tracking after speaker change", () => {
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
		expect(result[2].transcriptText).toBe("Hello again");
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

	it("does not absorb across non-consecutive same-speaker groups", () => {
		const blocks = [
			{ personName: "A", timestamp: t, transcriptText: "Hello" },
			{ personName: "B", timestamp: t, transcriptText: "Interjection" },
			{ personName: "A", timestamp: t, transcriptText: "Hello world" },
		];
		const result = computeTranscriptDiffs(blocks);
		expect(result).toHaveLength(3);
		expect(result[0].transcriptText).toBe("Hello");
		expect(result[2].transcriptText).toBe("Hello world");
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
});
