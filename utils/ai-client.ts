export const DEFAULT_MODEL = "gpt-5.4-mini-2026-03-17";

export const DEFAULT_CUSTOM_PROMPT = `以下のミーティングの文字起こしを分析し、次の形式で出力してください：

## 要約
ミーティングの概要を3〜5文で簡潔にまとめてください。

## 決定事項
- 決定された事項をリストで記載

## TODO
- アクションアイテムを記載（担当者がわかれば併記）`;

const CHAT_SYSTEM_PROMPT = `あなたは会議の文字起こしについて質問に答えるアシスタントです。
以下の文字起こしの内容を踏まえて、日本語で簡潔かつ正確に回答してください。
文字起こしから判断できないことは、推測せずその旨を伝えてください。`;

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export function buildUserContent(
	transcriptText: string,
	memo?: string,
): string {
	if (!memo) return transcriptText;
	return `${transcriptText}\n\n---\n\nユーザーメモ:\n${memo}`;
}

interface OpenAIRequestMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

async function callOpenAI(
	apiKey: string,
	model: string,
	messages: OpenAIRequestMessage[],
): Promise<string> {
	const response = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model, messages }),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${text}`);
	}
	const data = await response.json();
	const text = data.choices?.[0]?.message?.content;
	if (!text) {
		throw new Error("OpenAI: レスポンスが不正です");
	}
	return text;
}

export async function summarizeTranscript(
	apiKey: string,
	prompt: string,
	transcriptText: string,
	model: string,
	memo?: string,
): Promise<string> {
	if (!apiKey) {
		throw new Error("APIキーが設定されていません");
	}
	const effectivePrompt = prompt || DEFAULT_CUSTOM_PROMPT;
	const effectiveModel = model || DEFAULT_MODEL;
	const userContent = buildUserContent(transcriptText, memo);

	return callOpenAI(apiKey, effectiveModel, [
		{ role: "system", content: effectivePrompt },
		{ role: "user", content: userContent },
	]);
}

/**
 * Ask questions about a transcript in a multi-turn chat.
 * The transcript is embedded in the system prompt; `messages` is the
 * user/assistant conversation history including the latest user question.
 */
export async function chatAboutTranscript(
	apiKey: string,
	model: string,
	transcriptText: string,
	messages: ChatMessage[],
): Promise<string> {
	if (!apiKey) {
		throw new Error("APIキーが設定されていません");
	}
	const effectiveModel = model || DEFAULT_MODEL;

	return callOpenAI(apiKey, effectiveModel, [
		{
			role: "system",
			content: `${CHAT_SYSTEM_PROMPT}\n\n[文字起こし]\n${transcriptText}`,
		},
		...messages,
	]);
}
