import "./style.css";
import { DEFAULT_CUSTOM_PROMPT, DEFAULT_MODELS } from "@/utils/ai-client";
import { authenticate, getAuthToken, revokeToken } from "@/utils/google-auth";
import { showNotification } from "@/utils/notification";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "@/utils/settings";
import {
	DEFAULT_MINUTES_TEMPLATE,
	expandTemplate,
	type TemplateContext,
} from "@/utils/template";
import type { AIProvider, UserSettings } from "@/utils/types";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("#app element not found");
const app = appElement;

let currentSettings: UserSettings = { ...DEFAULT_SETTINGS };

function render(): void {
	app.innerHTML = "";

	// Header
	const header = document.createElement("div");
	header.className = "header";
	header.innerHTML = `
		<div class="header-icon">MJ</div>
		<div class="header-title">ミートジャーキー - 設定</div>
	`;
	app.appendChild(header);

	// Session management card
	app.appendChild(buildRetentionCard());

	// Google integration card
	app.appendChild(buildGoogleCard());

	// Template editing card
	app.appendChild(buildTemplateCard());

	// AI integration card
	app.appendChild(buildAICard());

	// Save button
	const footer = document.createElement("div");
	footer.className = "footer";
	const saveBtn = document.createElement("button");
	saveBtn.className = "save-button";
	saveBtn.textContent = "設定を保存";
	saveBtn.addEventListener("click", handleSave);
	footer.appendChild(saveBtn);
	app.appendChild(footer);
}

function buildRetentionCard(): HTMLDivElement {
	const card = document.createElement("div");
	card.className = "card";

	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = "セッション管理";
	card.appendChild(title);

	const formGroup = document.createElement("div");
	formGroup.className = "form-group";

	const label = document.createElement("div");
	label.className = "form-label";
	label.textContent = "保持方式";
	formGroup.appendChild(label);

	const radioGroup = document.createElement("div");
	radioGroup.className = "radio-group";

	// Count option
	const countItem = buildRadioItem(
		"retention-mode",
		"count",
		"件数で管理",
		"最新の指定件数のセッションを保持します",
		currentSettings.retention.mode === "count",
	);
	radioGroup.appendChild(countItem.wrapper);

	// Count input
	const countInputGroup = buildNumberInput(
		"retention-count",
		currentSettings.retention.maxCount,
		1,
		100,
		"件",
		currentSettings.retention.mode !== "count",
	);
	radioGroup.appendChild(countInputGroup.wrapper);

	// Days option
	const daysItem = buildRadioItem(
		"retention-mode",
		"days",
		"日数で管理",
		"指定日数以内のセッションを保持します",
		currentSettings.retention.mode === "days",
	);
	radioGroup.appendChild(daysItem.wrapper);

	// Days input
	const daysInputGroup = buildNumberInput(
		"retention-days",
		currentSettings.retention.maxDays,
		1,
		365,
		"日",
		currentSettings.retention.mode !== "days",
	);
	radioGroup.appendChild(daysInputGroup.wrapper);

	// Radio change handlers
	countItem.radio.addEventListener("change", () => {
		if (countItem.radio.checked) {
			currentSettings.retention.mode = "count";
			countItem.wrapper.classList.add("selected");
			daysItem.wrapper.classList.remove("selected");
			countInputGroup.input.disabled = false;
			countInputGroup.suffix.classList.remove("disabled");
			daysInputGroup.input.disabled = true;
			daysInputGroup.suffix.classList.add("disabled");
		}
	});

	daysItem.radio.addEventListener("change", () => {
		if (daysItem.radio.checked) {
			currentSettings.retention.mode = "days";
			daysItem.wrapper.classList.add("selected");
			countItem.wrapper.classList.remove("selected");
			daysInputGroup.input.disabled = false;
			daysInputGroup.suffix.classList.remove("disabled");
			countInputGroup.input.disabled = true;
			countInputGroup.suffix.classList.add("disabled");
		}
	});

	// Input change handlers
	countInputGroup.input.addEventListener("input", () => {
		const value = Number.parseInt(countInputGroup.input.value, 10);
		if (!Number.isNaN(value) && value >= 1 && value <= 100) {
			currentSettings.retention.maxCount = value;
		}
	});

	daysInputGroup.input.addEventListener("input", () => {
		const value = Number.parseInt(daysInputGroup.input.value, 10);
		if (!Number.isNaN(value) && value >= 1 && value <= 365) {
			currentSettings.retention.maxDays = value;
		}
	});

	formGroup.appendChild(radioGroup);
	card.appendChild(formGroup);

	return card;
}

function buildGoogleCard(): HTMLDivElement {
	const card = document.createElement("div");
	card.className = "card";

	const titleEl = document.createElement("div");
	titleEl.className = "card-title";
	titleEl.innerHTML = "&#128279; Google 連携";
	card.appendChild(titleEl);

	const statusRow = document.createElement("div");
	statusRow.className = "google-status-row";
	statusRow.id = "google-status-row";

	const statusIndicator = document.createElement("span");
	statusIndicator.className = "google-status";
	statusIndicator.id = "google-status";
	statusIndicator.textContent = "確認中...";
	statusRow.appendChild(statusIndicator);
	card.appendChild(statusRow);

	const actionsRow = document.createElement("div");
	actionsRow.className = "google-actions";

	const loginBtn = document.createElement("button");
	loginBtn.className = "google-login-button";
	loginBtn.id = "google-login-btn";
	loginBtn.textContent = "Google アカウントでログイン";
	loginBtn.style.display = "none";
	actionsRow.appendChild(loginBtn);

	const logoutBtn = document.createElement("button");
	logoutBtn.className = "google-logout-button";
	logoutBtn.id = "google-logout-btn";
	logoutBtn.textContent = "連携解除";
	logoutBtn.style.display = "none";
	actionsRow.appendChild(logoutBtn);

	card.appendChild(actionsRow);

	// Check auth status and update UI
	checkAndUpdateGoogleStatus();

	loginBtn.addEventListener("click", async () => {
		try {
			loginBtn.disabled = true;
			loginBtn.textContent = "認証中...";
			await authenticate();
			currentSettings.google.authenticated = true;
			await saveSettings(currentSettings);
			updateGoogleStatusUI(true);
			showNotification("Google アカウントを連携しました", "info");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("Google OAuth error:", msg);
			showNotification(`Google 認証に失敗しました: ${msg}`, "error");
			loginBtn.disabled = false;
			loginBtn.textContent = "Google アカウントでログイン";
		}
	});

	logoutBtn.addEventListener("click", async () => {
		try {
			logoutBtn.disabled = true;
			logoutBtn.textContent = "解除中...";
			const token = await getAuthToken();
			if (token) {
				await revokeToken(token);
			}
			currentSettings.google.authenticated = false;
			await saveSettings(currentSettings);
			updateGoogleStatusUI(false);
			showNotification("Google 連携を解除しました", "info");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("Google logout error:", msg);
			showNotification(`Google 連携の解除に失敗しました: ${msg}`, "error");
			logoutBtn.disabled = false;
			logoutBtn.textContent = "連携解除";
		}
	});

	return card;
}

async function checkAndUpdateGoogleStatus(): Promise<void> {
	const token = await getAuthToken();
	const isAuthenticated = token !== null;
	if (isAuthenticated !== currentSettings.google.authenticated) {
		currentSettings.google.authenticated = isAuthenticated;
		await saveSettings(currentSettings);
	}
	updateGoogleStatusUI(isAuthenticated);
}

function updateGoogleStatusUI(authenticated: boolean): void {
	const statusEl = document.getElementById("google-status");
	const loginBtn = document.getElementById(
		"google-login-btn",
	) as HTMLButtonElement | null;
	const logoutBtn = document.getElementById(
		"google-logout-btn",
	) as HTMLButtonElement | null;

	if (statusEl) {
		if (authenticated) {
			statusEl.textContent = "接続済み";
			statusEl.className = "google-status google-status-connected";
		} else {
			statusEl.textContent = "未接続";
			statusEl.className = "google-status google-status-disconnected";
		}
	}

	if (loginBtn) {
		loginBtn.style.display = authenticated ? "none" : "inline-flex";
		loginBtn.disabled = false;
		loginBtn.textContent = "Google アカウントでログイン";
	}

	if (logoutBtn) {
		logoutBtn.style.display = authenticated ? "inline-flex" : "none";
		logoutBtn.disabled = false;
		logoutBtn.textContent = "連携解除";
	}
}

interface RadioItemResult {
	wrapper: HTMLLabelElement;
	radio: HTMLInputElement;
}

function buildRadioItem(
	name: string,
	value: string,
	labelText: string,
	description: string,
	checked: boolean,
): RadioItemResult {
	const wrapper = document.createElement("label");
	wrapper.className = `radio-item${checked ? " selected" : ""}`;

	const radio = document.createElement("input");
	radio.type = "radio";
	radio.name = name;
	radio.value = value;
	radio.checked = checked;

	const content = document.createElement("div");
	content.className = "radio-item-content";

	const labelEl = document.createElement("div");
	labelEl.className = "radio-item-label";
	labelEl.textContent = labelText;

	const desc = document.createElement("div");
	desc.className = "radio-item-description";
	desc.textContent = description;

	content.appendChild(labelEl);
	content.appendChild(desc);

	wrapper.appendChild(radio);
	wrapper.appendChild(content);

	return { wrapper, radio };
}

interface NumberInputResult {
	wrapper: HTMLDivElement;
	input: HTMLInputElement;
	suffix: HTMLSpanElement;
}

function buildNumberInput(
	id: string,
	value: number,
	min: number,
	max: number,
	suffixText: string,
	disabled: boolean,
): NumberInputResult {
	const wrapper = document.createElement("div");
	wrapper.className = "number-input-group";

	const input = document.createElement("input");
	input.type = "number";
	input.id = id;
	input.className = "number-input";
	input.value = String(value);
	input.min = String(min);
	input.max = String(max);
	input.disabled = disabled;

	const suffix = document.createElement("span");
	suffix.className = `number-input-suffix${disabled ? " disabled" : ""}`;
	suffix.textContent = suffixText;

	wrapper.appendChild(input);
	wrapper.appendChild(suffix);

	return { wrapper, input, suffix };
}

function buildSampleContext(): TemplateContext {
	return {
		title: "週次定例ミーティング",
		code: "abc-defg-hij",
		date: "2026年4月14日",
		startTime: "10:00",
		endTime: "11:30",
		duration: "1時間30分",
		participants: "田中太郎, 鈴木花子, 佐藤一郎",
		participantCount: "3",
		transcriptCount: "42",
		transcript:
			"**田中太郎** (10:00:15)\nそれでは定例を始めます。\n\n**鈴木花子** (10:01:02)\n今週の進捗を報告します。",
	};
}

const TEMPLATE_VARIABLES: { name: string; description: string }[] = [
	{ name: "title", description: "会議タイトル" },
	{ name: "code", description: "Meet コード" },
	{ name: "date", description: "開始日（YYYY年MM月DD日）" },
	{ name: "startTime", description: "開始時刻（HH:MM）" },
	{ name: "endTime", description: "終了時刻（HH:MM）" },
	{ name: "duration", description: "所要時間" },
	{ name: "participants", description: "参加者（カンマ区切り）" },
	{ name: "participantCount", description: "参加者数" },
	{ name: "transcriptCount", description: "発言ブロック数" },
	{ name: "transcript", description: "書き起こし本文" },
];

function buildTemplateCard(): HTMLDivElement {
	const card = document.createElement("div");
	card.className = "card";

	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = "テンプレート設定";
	card.appendChild(title);

	// Description
	const desc = document.createElement("div");
	desc.className = "form-label";
	desc.textContent =
		"議事録エクスポート時に使用するテンプレートを編集できます。";
	card.appendChild(desc);

	// Variable reference
	const varsSection = document.createElement("div");
	varsSection.className = "template-variables";

	const varsTitle = document.createElement("div");
	varsTitle.className = "form-label";
	varsTitle.textContent = "利用可能な変数:";
	varsSection.appendChild(varsTitle);

	const varsList = document.createElement("ul");
	varsList.className = "template-variables-list";
	for (const v of TEMPLATE_VARIABLES) {
		const li = document.createElement("li");
		const code = document.createElement("code");
		code.textContent = `{{${v.name}}}`;
		li.appendChild(code);
		li.appendChild(document.createTextNode(` — ${v.description}`));
		varsList.appendChild(li);
	}
	varsSection.appendChild(varsList);
	card.appendChild(varsSection);

	// Textarea
	const formGroup = document.createElement("div");
	formGroup.className = "form-group";

	const textarea = document.createElement("textarea");
	textarea.className = "template-textarea";
	textarea.rows = 15;
	textarea.value = currentSettings.template.minutesTemplate;
	textarea.addEventListener("input", () => {
		currentSettings.template.minutesTemplate = textarea.value;
	});
	formGroup.appendChild(textarea);
	card.appendChild(formGroup);

	// Actions row
	const actions = document.createElement("div");
	actions.className = "template-actions";

	const resetBtn = document.createElement("button");
	resetBtn.className = "template-action-button";
	resetBtn.textContent = "デフォルトに戻す";
	resetBtn.addEventListener("click", () => {
		textarea.value = DEFAULT_MINUTES_TEMPLATE;
		currentSettings.template.minutesTemplate = DEFAULT_MINUTES_TEMPLATE;
	});
	actions.appendChild(resetBtn);

	const previewBtn = document.createElement("button");
	previewBtn.className = "template-action-button";
	previewBtn.textContent = "プレビュー";
	previewBtn.addEventListener("click", () => {
		const previewArea = card.querySelector(
			".template-preview",
		) as HTMLElement | null;
		if (previewArea) {
			if (previewArea.style.display === "none") {
				const context = buildSampleContext();
				const result = expandTemplate(textarea.value, context);
				previewArea.textContent = result;
				previewArea.style.display = "block";
				previewBtn.textContent = "プレビューを閉じる";
			} else {
				previewArea.style.display = "none";
				previewBtn.textContent = "プレビュー";
			}
		}
	});
	actions.appendChild(previewBtn);

	card.appendChild(actions);

	// Preview area (hidden by default)
	const preview = document.createElement("pre");
	preview.className = "template-preview";
	preview.style.display = "none";
	card.appendChild(preview);

	return card;
}

function buildAICard(): HTMLDivElement {
	const card = document.createElement("div");
	card.className = "card";

	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = "✨ AI連携";
	card.appendChild(title);

	// Section 1: Provider selection
	const providerGroup = document.createElement("div");
	providerGroup.className = "form-group";

	const providerLabel = document.createElement("div");
	providerLabel.className = "form-label";
	providerLabel.textContent = "プロバイダ選択";
	providerGroup.appendChild(providerLabel);

	const radioGroup = document.createElement("div");
	radioGroup.className = "radio-group";

	const openaiItem = buildRadioItem(
		"ai-provider",
		"openai",
		"OpenAI (GPT-4o mini)",
		"OpenAIのGPT-4o miniモデルを使用します",
		currentSettings.ai.provider === "openai",
	);
	radioGroup.appendChild(openaiItem.wrapper);

	const anthropicItem = buildRadioItem(
		"ai-provider",
		"anthropic",
		"Anthropic (Claude)",
		"AnthropicのClaudeモデルを使用します",
		currentSettings.ai.provider === "anthropic",
	);
	radioGroup.appendChild(anthropicItem.wrapper);

	const geminiItem = buildRadioItem(
		"ai-provider",
		"gemini",
		"Google Gemini (Flash)",
		"Google GeminiのFlashモデルを使用します",
		currentSettings.ai.provider === "gemini",
	);
	radioGroup.appendChild(geminiItem.wrapper);

	const allItems = [openaiItem, anthropicItem, geminiItem];
	const providerValues: AIProvider[] = ["openai", "anthropic", "gemini"];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const providerValue = providerValues[i];
		item.radio.addEventListener("change", () => {
			if (item.radio.checked) {
				currentSettings.ai.provider = providerValue;
				currentSettings.ai.model = DEFAULT_MODELS[providerValue];
				const modelInput =
					card.querySelector<HTMLInputElement>("#ai-model-input");
				if (modelInput) {
					modelInput.value = DEFAULT_MODELS[providerValue];
				}
				for (const other of allItems) {
					other.wrapper.classList.remove("selected");
				}
				item.wrapper.classList.add("selected");
			}
		});
	}

	providerGroup.appendChild(radioGroup);
	card.appendChild(providerGroup);

	// Section 2: Model name
	const modelGroup = document.createElement("div");
	modelGroup.className = "form-group";

	const modelLabel = document.createElement("div");
	modelLabel.className = "form-label";
	modelLabel.textContent = "モデル名";
	modelGroup.appendChild(modelLabel);

	const modelInput = document.createElement("input");
	modelInput.type = "text";
	modelInput.id = "ai-model-input";
	modelInput.className = "api-key-input";
	modelInput.placeholder = "例: gemini-2.5-flash, gpt-4o-mini";
	modelInput.value = currentSettings.ai.model;
	modelInput.addEventListener("input", () => {
		currentSettings.ai.model = modelInput.value;
	});
	modelGroup.appendChild(modelInput);

	const modelHelp = document.createElement("div");
	modelHelp.className = "help-text";
	modelHelp.textContent =
		"使用するモデル名を指定できます。プロバイダ切替時はデフォルト値に戻ります。";
	modelGroup.appendChild(modelHelp);

	card.appendChild(modelGroup);

	// Section 3: API Key
	const apiKeyGroup = document.createElement("div");
	apiKeyGroup.className = "form-group";

	const apiKeyLabel = document.createElement("div");
	apiKeyLabel.className = "form-label";
	apiKeyLabel.textContent = "APIキー";
	apiKeyGroup.appendChild(apiKeyLabel);

	const apiKeyContainer = document.createElement("div");
	apiKeyContainer.className = "api-key-container";

	const apiKeyInput = document.createElement("input");
	apiKeyInput.type = "password";
	apiKeyInput.className = "api-key-input";
	apiKeyInput.placeholder = "sk-... / sk-ant-... / AIza...";
	apiKeyInput.value = currentSettings.ai.apiKey;
	apiKeyInput.addEventListener("input", () => {
		currentSettings.ai.apiKey = apiKeyInput.value;
	});
	apiKeyContainer.appendChild(apiKeyInput);

	const toggleBtn = document.createElement("button");
	toggleBtn.type = "button";
	toggleBtn.className = "api-key-toggle";
	toggleBtn.textContent = "👁";
	toggleBtn.addEventListener("click", () => {
		if (apiKeyInput.type === "password") {
			apiKeyInput.type = "text";
			toggleBtn.textContent = "👁‍🗨";
		} else {
			apiKeyInput.type = "password";
			toggleBtn.textContent = "👁";
		}
	});
	apiKeyContainer.appendChild(toggleBtn);

	apiKeyGroup.appendChild(apiKeyContainer);

	const apiKeyHelp = document.createElement("div");
	apiKeyHelp.className = "help-text";
	apiKeyHelp.textContent =
		"選択したプロバイダのAPIキーを入力してください。キーはローカルに保存され、外部に送信されません。";
	apiKeyGroup.appendChild(apiKeyHelp);

	card.appendChild(apiKeyGroup);

	// Section 4: Custom Prompt
	const promptGroup = document.createElement("div");
	promptGroup.className = "form-group";

	const promptLabel = document.createElement("div");
	promptLabel.className = "form-label";
	promptLabel.textContent = "カスタムプロンプト";
	promptGroup.appendChild(promptLabel);

	const promptTextarea = document.createElement("textarea");
	promptTextarea.className = "prompt-textarea";
	promptTextarea.rows = 10;
	promptTextarea.value = currentSettings.template.customPrompt;
	promptTextarea.addEventListener("input", () => {
		currentSettings.template.customPrompt = promptTextarea.value;
	});
	promptGroup.appendChild(promptTextarea);

	// Prompt actions
	const promptActions = document.createElement("div");
	promptActions.className = "prompt-actions";

	const previewBtn = document.createElement("button");
	previewBtn.type = "button";
	previewBtn.className = "template-action-button";
	previewBtn.textContent = "プレビュー";
	previewBtn.addEventListener("click", () => {
		const previewArea = card.querySelector(
			".prompt-preview",
		) as HTMLElement | null;
		if (previewArea) {
			if (previewArea.style.display === "none") {
				const sampleTranscript =
					"田中: 今日の議題について確認しましょう。\n鈴木: はい、プロジェクトの進捗報告をお願いします。\n田中: 了解です。まず開発チームの状況からお伝えします。";
				previewArea.textContent = `[システムプロンプト]\n${promptTextarea.value}\n\n[文字起こし（サンプル）]\n${sampleTranscript}`;
				previewArea.style.display = "block";
				previewBtn.textContent = "プレビューを閉じる";
			} else {
				previewArea.style.display = "none";
				previewBtn.textContent = "プレビュー";
			}
		}
	});
	promptActions.appendChild(previewBtn);

	const resetBtn = document.createElement("button");
	resetBtn.type = "button";
	resetBtn.className = "template-action-button";
	resetBtn.textContent = "リセット";
	resetBtn.addEventListener("click", () => {
		promptTextarea.value = DEFAULT_CUSTOM_PROMPT;
		currentSettings.template.customPrompt = DEFAULT_CUSTOM_PROMPT;
	});
	promptActions.appendChild(resetBtn);

	promptGroup.appendChild(promptActions);

	// Preview area (hidden by default)
	const preview = document.createElement("pre");
	preview.className = "prompt-preview";
	preview.style.display = "none";
	promptGroup.appendChild(preview);

	const promptHelp = document.createElement("div");
	promptHelp.className = "help-text";
	promptHelp.textContent =
		"AIに送信される指示プロンプトです。文字起こしテキストは自動的に追加されます。";
	promptGroup.appendChild(promptHelp);

	card.appendChild(promptGroup);

	return card;
}

async function handleSave(): Promise<void> {
	// Validate current values from inputs
	const countInput =
		document.querySelector<HTMLInputElement>("#retention-count");
	const daysInput = document.querySelector<HTMLInputElement>("#retention-days");

	if (countInput) {
		const value = Number.parseInt(countInput.value, 10);
		if (Number.isNaN(value) || value < 1 || value > 100) {
			showNotification("件数は1〜100の範囲で入力してください", "error");
			return;
		}
		currentSettings.retention.maxCount = value;
	}

	if (daysInput) {
		const value = Number.parseInt(daysInput.value, 10);
		if (Number.isNaN(value) || value < 1 || value > 365) {
			showNotification("日数は1〜365の範囲で入力してください", "error");
			return;
		}
		currentSettings.retention.maxDays = value;
	}

	try {
		await saveSettings(currentSettings);
		showNotification("設定を保存しました", "info");
	} catch {
		showNotification("設定の保存に失敗しました", "error");
	}
}

async function init(): Promise<void> {
	try {
		currentSettings = await loadSettings();
	} catch {
		currentSettings = { ...DEFAULT_SETTINGS };
	}
	render();
}

init();
