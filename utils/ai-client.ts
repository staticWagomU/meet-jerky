import type { AIProvider } from "./types";

export const DEFAULT_MODELS: Record<AIProvider, string> = {
	openai: "gpt-4o-mini",
	anthropic: "claude-sonnet-4-5-20250514",
	gemini: "gemini-2.5-flash",
};

export const DEFAULT_CUSTOM_PROMPT = `以下のミーティングの文字起こしを分析し、次の形式で出力してください：

## 要約
ミーティングの概要を3〜5文で簡潔にまとめてください。

## 決定事項
- 決定された事項をリストで記載

## TODO
- アクションアイテムを記載（担当者がわかれば併記）`;

export function buildUserContent(
	transcriptText: string,
	memo?: string,
): string {
	if (!memo) return transcriptText;
	return `${transcriptText}\n\n---\n\nユーザーメモ:\n${memo}`;
}

export async function summarizeTranscript(
	provider: AIProvider,
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
	const effectiveModel = model || DEFAULT_MODELS[provider];
	const userContent = buildUserContent(transcriptText, memo);

	switch (provider) {
		case "openai":
			return callOpenAI(apiKey, effectivePrompt, userContent, effectiveModel);
		case "anthropic":
			return callAnthropic(
				apiKey,
				effectivePrompt,
				userContent,
				effectiveModel,
			);
		case "gemini":
			return callGemini(apiKey, effectivePrompt, userContent, effectiveModel);
	}
}

interface ProviderConfig {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	extractText: (data: unknown) => string | undefined;
	errorPrefix: string;
}

async function callProvider(config: ProviderConfig): Promise<string> {
	const response = await fetch(config.url, {
		method: "POST",
		headers: config.headers,
		body: JSON.stringify(config.body),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`${config.errorPrefix} API error (${response.status}): ${text}`,
		);
	}
	const data = await response.json();
	const text = config.extractText(data);
	if (!text) {
		throw new Error(`${config.errorPrefix}: レスポンスが不正です`);
	}
	return text;
}

async function callOpenAI(
	apiKey: string,
	prompt: string,
	transcript: string,
	model: string,
): Promise<string> {
	return callProvider({
		url: "https://api.openai.com/v1/chat/completions",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: {
			model,
			messages: [
				{ role: "system", content: prompt },
				{ role: "user", content: transcript },
			],
		},
		// biome-ignore lint/suspicious/noExplicitAny: provider-specific JSON response
		extractText: (data: any) => data.choices?.[0]?.message?.content,
		errorPrefix: "OpenAI",
	});
}

async function callAnthropic(
	apiKey: string,
	prompt: string,
	transcript: string,
	model: string,
): Promise<string> {
	return callProvider({
		url: "https://api.anthropic.com/v1/messages",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: {
			model,
			max_tokens: 4096,
			system: prompt,
			messages: [{ role: "user", content: transcript }],
		},
		// biome-ignore lint/suspicious/noExplicitAny: provider-specific JSON response
		extractText: (data: any) => data.content?.[0]?.text,
		errorPrefix: "Anthropic",
	});
}

async function callGemini(
	apiKey: string,
	prompt: string,
	transcript: string,
	model: string,
): Promise<string> {
	return callProvider({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
		headers: {
			"Content-Type": "application/json",
		},
		body: {
			systemInstruction: { parts: [{ text: prompt }] },
			contents: [{ parts: [{ text: transcript }] }],
		},
		// biome-ignore lint/suspicious/noExplicitAny: provider-specific JSON response
		extractText: (data: any) => data.candidates?.[0]?.content?.parts?.[0]?.text,
		errorPrefix: "Gemini",
	});
}
