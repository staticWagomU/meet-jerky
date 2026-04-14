import "./style.css";
import {
	buildExportFilename,
	computeTranscriptDiffs,
	escapeHtml,
	extractParticipants,
	formatDate,
	formatRawTranscriptAsText,
	formatSessionAsJson,
	formatSessionAsMarkdown,
	formatTimeOnly,
	formatTranscriptAsText,
	getSessionDisplayTitle,
} from "@/utils/helpers";
import { loadSettings } from "@/utils/settings";
import { generateMinutes } from "@/utils/template";
import type { MeetingSession } from "@/utils/types";

interface SessionSummary {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
	transcriptCount: number;
}

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("#app element not found");
const app = appElement;

const ONBOARDING_KEY = "onboarding-completed";

// State

// --- Message helpers ---

async function sendMsg<T>(
	type: string,
	payload?: Record<string, unknown>,
): Promise<T> {
	return browser.runtime.sendMessage({
		type,
		...(payload && { payload }),
	}) as Promise<T>;
}

async function getSessions(): Promise<{ sessions: SessionSummary[] }> {
	return sendMsg("GET_SESSIONS");
}

async function getTranscript(
	sessionId: string,
): Promise<{ session: MeetingSession }> {
	return sendMsg("GET_TRANSCRIPT", { sessionId });
}

async function deleteSession(sessionId: string): Promise<{ success: boolean }> {
	return sendMsg("DELETE_SESSION", { sessionId });
}

async function updateSessionTitle(
	sessionId: string,
	meetingTitle: string,
): Promise<{ success: boolean }> {
	return sendMsg("UPDATE_SESSION_TITLE", { sessionId, meetingTitle });
}

// --- Inline title edit ---

function startInlineEdit(
	container: HTMLElement,
	currentTitle: string,
	onSave: (newTitle: string) => Promise<void>,
): void {
	const originalHtml = container.innerHTML;

	const input = document.createElement("input");
	input.type = "text";
	input.value = currentTitle;
	input.className = "edit-title-input";

	const saveBtn = document.createElement("button");
	saveBtn.textContent = "OK";
	saveBtn.className = "edit-title-save";

	const cancelBtn = document.createElement("button");
	cancelBtn.textContent = "Cancel";
	cancelBtn.className = "edit-title-cancel";

	container.innerHTML = "";
	container.appendChild(input);
	container.appendChild(saveBtn);
	container.appendChild(cancelBtn);

	input.focus();
	input.select();

	let saved = false;

	const save = async () => {
		if (saved) return;
		saved = true;
		const newTitle = input.value.trim();
		if (newTitle && newTitle !== currentTitle) {
			await onSave(newTitle);
		} else {
			container.innerHTML = originalHtml;
		}
	};

	const cancel = () => {
		if (saved) return;
		saved = true;
		container.innerHTML = originalHtml;
	};

	saveBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		save();
	});

	cancelBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		cancel();
	});

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			save();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancel();
		}
	});

	input.addEventListener("click", (e) => e.stopPropagation());
}

// --- Download helper ---

function downloadFile(
	content: string,
	filename: string,
	mimeType: string,
): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

// --- Formatting helpers ---

// --- Onboarding ---

function renderOnboarding(): void {
	app.innerHTML = `
    <div class="onboarding">
      <div class="onboarding-icon">MJ</div>
      <h1 class="onboarding-title">ミートジャーキー</h1>
      <p class="onboarding-description">
        この拡張機能は、Google Meetの字幕を自動的に記録・保存します。
      </p>
      <div class="onboarding-points">
        <div class="onboarding-point">
          <span class="onboarding-point-icon">&#128196;</span>
          <span>会議中の字幕テキストと発言者名を自動で記録します</span>
        </div>
        <div class="onboarding-point">
          <span class="onboarding-point-icon">&#128274;</span>
          <span>記録データはお使いのブラウザ内にのみ保存され、外部に送信されることはありません</span>
        </div>
        <div class="onboarding-point">
          <span class="onboarding-point-icon">&#9888;&#65039;</span>
          <span>ご利用の際は、会議の参加者に字幕を記録していることを事前にお伝えください</span>
        </div>
      </div>
      <button class="onboarding-button" id="onboarding-accept">理解しました</button>
    </div>
  `;

	document
		.getElementById("onboarding-accept")
		?.addEventListener("click", async () => {
			await browser.storage.local.set({ [ONBOARDING_KEY]: true });
			renderLoading();
			const response = await getSessions();
			renderSessionList(response.sessions);
		});
}

// --- Render functions ---

function renderLoading(): void {
	app.innerHTML = `<div class="loading">読み込み中...</div>`;
}

function renderSessionList(sessions: SessionSummary[]): void {
	const header = `
    <div class="header">
      <div class="header-icon">MJ</div>
      <div class="header-title">ミートジャーキー</div>
      <button id="settings-link" class="settings-link" title="設定">&#9881;</button>
    </div>
  `;

	if (sessions.length === 0) {
		app.innerHTML = `
      ${header}
      <div class="empty-state">
        <div class="empty-state-icon">&#128196;</div>
        <div class="empty-state-text">保存されたセッションはありません</div>
      </div>
    `;
		document.getElementById("settings-link")?.addEventListener("click", () => {
			browser.runtime.openOptionsPage();
		});
		return;
	}

	const listItems = sessions
		.map(
			(session) => `
    <div class="session-item" data-session-id="${escapeHtml(session.sessionId)}">
      <div class="session-info">
        <div class="session-title-row">
          <span class="session-title">${escapeHtml(getSessionDisplayTitle(session))}</span>
          <button class="edit-title-button" data-edit-id="${escapeHtml(session.sessionId)}" title="タイトルを編集">&#9998;</button>
        </div>
        <div class="session-meta">
          <span class="session-date">${formatDate(session.startTimestamp)}</span>
          <span class="session-count">${session.transcriptCount}件の発言</span>
        </div>
      </div>
      <button class="delete-button" data-delete-id="${escapeHtml(session.sessionId)}" title="削除">削除</button>
    </div>
  `,
		)
		.join("");

	app.innerHTML = `
    ${header}
    <div class="session-list">${listItems}</div>
  `;

	// Attach event listeners
	document.querySelectorAll(".session-item").forEach((item) => {
		item.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			// Don't navigate when clicking the delete or edit button
			if (
				target.closest(".delete-button") ||
				target.closest(".edit-title-button")
			)
				return;

			const sessionId = (item as HTMLElement).dataset.sessionId;
			if (sessionId) {
				navigateToDetail(sessionId);
			}
		});
	});

	document.querySelectorAll(".edit-title-button").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const sessionId = (btn as HTMLElement).dataset.editId;
			if (!sessionId) return;

			const titleRow = btn.closest(".session-title-row");
			if (!titleRow) return;

			const titleSpan = titleRow.querySelector(".session-title") as HTMLElement;
			if (!titleSpan) return;

			const currentTitle = titleSpan.textContent ?? "";
			startInlineEdit(
				titleRow as HTMLElement,
				currentTitle,
				async (newTitle) => {
					await updateSessionTitle(sessionId, newTitle);
					const response = await getSessions();
					renderSessionList(response.sessions);
				},
			);
		});
	});

	document.querySelectorAll(".delete-button").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const sessionId = (btn as HTMLElement).dataset.deleteId;
			if (!sessionId) return;

			const confirmed = confirm("このセッションを削除しますか？");
			if (!confirmed) return;

			await deleteSession(sessionId);
			const response = await getSessions();
			renderSessionList(response.sessions);
		});
	});

	document.getElementById("settings-link")?.addEventListener("click", () => {
		browser.runtime.openOptionsPage();
	});
}

function renderTranscriptDetail(session: MeetingSession): void {
	// Compute diffs to show only new text for same-speaker consecutive entries
	const diffedTranscript = computeTranscriptDiffs(session.transcript);

	// Build participant list and color map
	const participants = extractParticipants(session.transcript);
	const speakerColors = new Map<string, number>();
	participants.forEach((name, i) => {
		speakerColors.set(name, i % 8);
	});

	// Group consecutive entries by the same speaker
	const groups: { speaker: string; entries: typeof session.transcript }[] = [];
	for (const block of diffedTranscript) {
		const lastGroup = groups[groups.length - 1];
		if (lastGroup && lastGroup.speaker === block.personName) {
			lastGroup.entries.push(block);
		} else {
			groups.push({ speaker: block.personName, entries: [block] });
		}
	}

	const transcriptHtml = groups
		.map((group) => {
			const colorClass = `speaker-color-${speakerColors.get(group.speaker) ?? 0}`;
			const entriesHtml = group.entries
				.map(
					(entry) => `
        <div class="transcript-entry">
          <div class="transcript-timestamp">${escapeHtml(formatTimeOnly(entry.timestamp))}</div>
          <div class="transcript-text">${escapeHtml(entry.transcriptText)}</div>
        </div>
      `,
				)
				.join("");

			return `
        <div class="transcript-group ${colorClass}">
          <div class="transcript-speaker">${escapeHtml(group.speaker)}</div>
          ${entriesHtml}
        </div>
      `;
		})
		.join("");

	app.innerHTML = `
    <div class="detail-header">
      <button class="back-button" id="back-button">&larr; セッション一覧</button>
      <div class="detail-title-row">
        <span class="detail-title" id="detail-title">${escapeHtml(getSessionDisplayTitle(session))}</span>
        <button class="edit-title-button" id="edit-detail-title" title="タイトルを編集">&#9998;</button>
      </div>
      <div class="detail-meta">${formatDate(session.startTimestamp)}</div>
      ${session.meetingCode ? `<div class="detail-code">${escapeHtml(session.meetingCode)}</div>` : ""}
    </div>
    <div class="participants">
      <span class="participants-label">参加者:</span>
      ${participants
				.map((name) => {
					const colorClass = `speaker-color-${speakerColors.get(name) ?? 0}`;
					return `<span class="participant-tag ${colorClass}">${escapeHtml(name)}</span>`;
				})
				.join("")}
    </div>
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="export-button" id="export-md" title="Markdownでエクスポート">MD</button>
        <button class="export-button" id="export-json" title="JSONでエクスポート">JSON</button>
        <button class="export-button" id="export-txt" title="テキストでエクスポート">TXT</button>
        <button class="export-button" id="export-raw" title="生の字幕ログをエクスポート">RAW</button>
        <button class="export-button" id="export-minutes" title="議事録テンプレートでエクスポート">議事録</button>
      </div>
      <button class="copy-button" id="copy-button">&#128203; 全文コピー</button>
    </div>
    <div class="transcript-list">${transcriptHtml}</div>
  `;

	// Back button
	document
		.getElementById("back-button")
		?.addEventListener("click", async () => {
			renderLoading();
			const response = await getSessions();
			renderSessionList(response.sessions);
		});

	// Edit detail title
	document
		.getElementById("edit-detail-title")
		?.addEventListener("click", () => {
			const titleRow = document.querySelector(".detail-title-row");
			const titleSpan = document.getElementById("detail-title");
			if (!titleRow || !titleSpan) return;

			const currentTitle = titleSpan.textContent ?? "";
			startInlineEdit(
				titleRow as HTMLElement,
				currentTitle,
				async (newTitle) => {
					await updateSessionTitle(session.sessionId, newTitle);
					// Re-render detail with updated session
					const response = await getTranscript(session.sessionId);
					renderTranscriptDetail(response.session);
				},
			);
		});

	attachExportHandlers(session);
}

function attachExportHandlers(session: MeetingSession): void {
	// Copy button
	document
		.getElementById("copy-button")
		?.addEventListener("click", async () => {
			const text = formatTranscriptAsText(session.transcript);
			try {
				await navigator.clipboard.writeText(text);
				const copyBtn = document.getElementById("copy-button");
				if (copyBtn) {
					copyBtn.classList.add("copied");
					copyBtn.textContent = "コピーしました!";
					setTimeout(() => {
						copyBtn.classList.remove("copied");
						copyBtn.innerHTML = "&#128203; 全文コピー";
					}, 2000);
				}
			} catch {
				// Fallback: should rarely happen in extension popup
				alert("コピーに失敗しました");
			}
		});

	// Export buttons
	document.getElementById("export-md")?.addEventListener("click", () => {
		const md = formatSessionAsMarkdown(session);
		const filename = buildExportFilename(session, "md");
		downloadFile(md, filename, "text/markdown");
	});

	document.getElementById("export-json")?.addEventListener("click", () => {
		const json = formatSessionAsJson(session);
		const filename = buildExportFilename(session, "json");
		downloadFile(json, filename, "application/json");
	});

	document.getElementById("export-txt")?.addEventListener("click", () => {
		const txt = formatTranscriptAsText(session.transcript);
		const filename = buildExportFilename(session, "txt");
		downloadFile(txt, filename, "text/plain");
	});

	document.getElementById("export-raw")?.addEventListener("click", () => {
		const raw = formatRawTranscriptAsText(session.rawTranscript ?? []);
		const filename = buildExportFilename(session, "txt", "raw");
		downloadFile(raw, filename, "text/plain");
	});

	document
		.getElementById("export-minutes")
		?.addEventListener("click", async () => {
			const settings = await loadSettings();
			const minutes = generateMinutes(
				session,
				settings.template.minutesTemplate,
			);
			const filename = buildExportFilename(session, "md", "minutes");
			downloadFile(minutes, filename, "text/markdown");
		});
}

// --- Navigation ---

async function navigateToDetail(sessionId: string): Promise<void> {
	renderLoading();
	const response = await getTranscript(sessionId);
	renderTranscriptDetail(response.session);
}

// --- Initialize ---

async function init(): Promise<void> {
	const result = await browser.storage.local.get(ONBOARDING_KEY);
	if (!result[ONBOARDING_KEY]) {
		renderOnboarding();
		return;
	}
	renderLoading();
	const response = await getSessions();
	renderSessionList(response.sessions);
}

init();
