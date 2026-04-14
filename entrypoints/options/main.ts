import "./style.css";
import { showNotification } from "@/utils/notification";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "@/utils/settings";
import type { UserSettings } from "@/utils/types";

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

	// Google integration placeholder
	app.appendChild(
		buildPlaceholderCard("Google 連携", "今後のアップデートで追加予定"),
	);

	// Template placeholder
	app.appendChild(
		buildPlaceholderCard("テンプレート設定", "今後のアップデートで追加予定"),
	);

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

function buildPlaceholderCard(
	titleText: string,
	message: string,
): HTMLDivElement {
	const card = document.createElement("div");
	card.className = "card";

	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = titleText;
	card.appendChild(title);

	const placeholder = document.createElement("div");
	placeholder.className = "placeholder-content";
	placeholder.innerHTML = `
		<span class="placeholder-icon">🔒</span>
		<span>${message}</span>
	`;
	card.appendChild(placeholder);

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
