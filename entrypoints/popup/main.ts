import "./style.css";
import {
	type ChatMessage,
	chatAboutTranscript,
	summarizeTranscript,
} from "@/utils/ai-client";
import {
	computeTranscriptDiffs,
	escapeHtml,
	extractParticipants,
	formatDate,
	formatRawTranscriptAsText,
	formatTimeOnly,
	formatTranscriptAsText,
	getSessionDisplayTitle,
} from "@/utils/helpers";
import { loadSettings } from "@/utils/settings";
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

// このUIはpopupとサイドパネルで共有する。出力HTML名で実行文脈を判別し、
// サイドパネル内では「サイドパネルで開く」ボタンを出さない。
// AI機能（要約・チャット）はサイドパネル文脈でのみ表示する。
const IS_SIDE_PANEL = location.pathname.includes("sidepanel");
// sidePanel.open は Chrome のみ。未対応ブラウザ(Firefox等)ではボタンを隠す。
const CAN_OPEN_SIDE_PANEL = typeof browser.sidePanel?.open === "function";
const SHOW_SIDE_PANEL_BUTTON = !IS_SIDE_PANEL && CAN_OPEN_SIDE_PANEL;

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

// --- Temporary button state helper ---

function showTemporaryButtonState(
	btn: HTMLButtonElement,
	text: string,
	className: string,
	duration: number,
	originalText: string,
	onRevert?: () => void,
): void {
	if (className) {
		btn.classList.add(className);
	}
	btn.textContent = text;
	setTimeout(() => {
		if (className) {
			btn.classList.remove(className);
		}
		btn.textContent = originalText;
		onRevert?.();
	}, duration);
}

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
          <span>記録データはお使いのブラウザ内にのみ保存されます（AI機能を使用した場合のみOpenAIに送信されます）</span>
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
	const sidePanelButton = SHOW_SIDE_PANEL_BUTTON
		? `<button id="open-side-panel" class="settings-link" title="サイドパネルで開く">&#9707;</button>`
		: "";
	const header = `
    <div class="header">
      <div class="header-icon">MJ</div>
      <div class="header-title">ミートジャーキー</div>
      ${sidePanelButton}
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
	} else {
		const listItems = sessions
			.map(
				(session) => `
    <div class="session-item" data-session-id="${escapeHtml(session.sessionId)}">
      <div class="session-info">
        <div class="session-title-row">
          <span class="session-title">${escapeHtml(getSessionDisplayTitle(session))}</span>
          ${session.endTimestamp === "" ? '<span class="recording-badge"><span class="recording-dot"></span>記録中</span>' : ""}
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

				const titleSpan = titleRow.querySelector(
					".session-title",
				) as HTMLElement;
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
	}

	document.getElementById("settings-link")?.addEventListener("click", () => {
		browser.runtime.openOptionsPage();
	});

	document
		.getElementById("open-side-panel")
		?.addEventListener("click", async () => {
			// sidePanel.open はユーザー操作起点でしか呼べないため、
			// background経由にせずクリックハンドラ内で完結させる。
			try {
				const win = await browser.windows.getCurrent();
				if (win.id != null) {
					await browser.sidePanel.open({ windowId: win.id });
					window.close();
				}
			} catch (error) {
				console.error("サイドパネルを開けませんでした", error);
			}
		});
}

// --- Transcript detail sub-functions ---

function buildTranscriptHtml(session: MeetingSession): {
	html: string;
	participants: string[];
	speakerColors: Map<string, number>;
} {
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

	const html = groups
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

	return { html, participants, speakerColors };
}

// AI要約・メモ・チャットはサイドパネル文脈でのみ表示する
function buildAiSectionHtml(): string {
	return `
    <div class="ai-section">
      <div class="ai-section-header">
        <span class="ai-section-title">✨ AI</span>
        <button class="action-btn ai-btn" id="ai-summary-btn" title="AIで要約を生成">AI要約</button>
      </div>
      <textarea class="ai-memo-input" id="ai-memo-input" placeholder="メモを入力（任意）：要約に反映したい補足情報など" rows="2"></textarea>
      <div class="ai-summary-result" style="display:none">
        <div class="ai-summary-header">
          <span class="ai-summary-title">AI要約</span>
          <button class="ai-summary-copy">コピー</button>
          <button class="ai-summary-close">&#10005;</button>
        </div>
        <div class="ai-summary-content"></div>
      </div>
      <div class="ai-chat">
        <div class="ai-chat-messages" id="ai-chat-messages"></div>
        <div class="ai-chat-input-row">
          <textarea class="ai-chat-input" id="ai-chat-input" placeholder="文字起こしについて質問（Enterで送信）" rows="2"></textarea>
          <button class="action-btn ai-btn" id="ai-chat-send">送信</button>
        </div>
      </div>
    </div>
  `;
}

function buildDetailPageHtml(
	session: MeetingSession,
	transcriptHtml: string,
	participants: string[],
	speakerColors: Map<string, number>,
): string {
	return `
    <div class="detail-header">
      <button class="back-button" id="back-button">&larr; セッション一覧</button>
      <div class="detail-title-row">
        <span class="detail-title" id="detail-title">${escapeHtml(getSessionDisplayTitle(session))}</span>
        <button class="edit-title-button" id="edit-detail-title" title="タイトルを編集">&#9998;</button>
      </div>
      <div class="detail-meta">${formatDate(session.startTimestamp)}</div>
      ${session.meetingCode ? `<div class="detail-code">${escapeHtml(session.meetingCode)}</div>` : ""}
    </div>
    <div class="detail-content">
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
      <button class="action-btn copy-btn" id="copy-button">全文コピー</button>
    </div>
    ${IS_SIDE_PANEL ? buildAiSectionHtml() : ""}
    <div class="transcript-list">${transcriptHtml}</div>
    </div>
  `;
}

function renderTranscriptDetail(session: MeetingSession): void {
	const {
		html: transcriptHtml,
		participants,
		speakerColors,
	} = buildTranscriptHtml(session);

	app.innerHTML = buildDetailPageHtml(
		session,
		transcriptHtml,
		participants,
		speakerColors,
	);

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

	attachCopyHandler(session);

	if (IS_SIDE_PANEL) {
		attachAiHandlers(session);
	}
}

// --- Copy handler ---

/**
 * Copy the raw caption log to the clipboard. Sessions recorded before
 * rawTranscript existed fall back to the deduplicated transcript.
 */
function attachCopyHandler(session: MeetingSession): void {
	document
		.getElementById("copy-button")
		?.addEventListener("click", async () => {
			const raw = session.rawTranscript ?? [];
			const text =
				raw.length > 0
					? formatRawTranscriptAsText(raw)
					: formatTranscriptAsText(session.transcript);
			try {
				await navigator.clipboard.writeText(text);
				const copyBtn = document.getElementById(
					"copy-button",
				) as HTMLButtonElement | null;
				if (copyBtn) {
					showTemporaryButtonState(
						copyBtn,
						"コピーしました!",
						"copied",
						2000,
						"全文コピー",
					);
				}
			} catch {
				// Fallback: should rarely happen in extension popup
				alert("コピーに失敗しました");
			}
		});
}

// --- AI handlers (side panel only) ---

async function confirmApiKeySetup(): Promise<boolean> {
	const settings = await loadSettings();
	if (settings.ai.apiKey) return true;

	if (confirm("APIキーが設定されていません。設定画面を開きますか？")) {
		browser.runtime.openOptionsPage();
	}
	return false;
}

function attachAiHandlers(session: MeetingSession): void {
	attachSummaryHandlers(session);
	attachChatHandlers(session);
}

function attachSummaryHandlers(session: MeetingSession): void {
	const aiBtn = document.getElementById(
		"ai-summary-btn",
	) as HTMLButtonElement | null;

	aiBtn?.addEventListener("click", async () => {
		if (!(await confirmApiKeySetup())) return;
		const settings = await loadSettings();

		aiBtn.textContent = "生成中...";
		aiBtn.classList.add("loading");
		aiBtn.disabled = true;

		const resultContainer = document.querySelector(
			".ai-summary-result",
		) as HTMLElement | null;
		const contentEl = document.querySelector(
			".ai-summary-content",
		) as HTMLElement | null;

		try {
			const transcriptText = formatTranscriptAsText(session.transcript);
			const memoInput = document.getElementById(
				"ai-memo-input",
			) as HTMLTextAreaElement | null;
			const memo = memoInput?.value.trim() || "";
			const result = await summarizeTranscript(
				settings.ai.apiKey,
				settings.ai.customPrompt,
				transcriptText,
				settings.ai.model,
				memo,
			);

			if (resultContainer && contentEl) {
				contentEl.textContent = result;
				resultContainer.style.display = "block";
			}

			aiBtn.classList.remove("loading");
			showTemporaryButtonState(aiBtn, "生成完了", "success", 2000, "AI要約", () => {
				aiBtn.disabled = false;
			});
		} catch (err) {
			aiBtn.classList.remove("loading");
			console.error("AI summary error:", err);

			if (resultContainer && contentEl) {
				contentEl.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
				resultContainer.style.display = "block";
			}

			showTemporaryButtonState(aiBtn, "エラー", "error", 3000, "AI要約", () => {
				aiBtn.disabled = false;
			});
		}
	});

	// AI Summary copy button
	document
		.querySelector(".ai-summary-copy")
		?.addEventListener("click", async () => {
			const contentEl = document.querySelector(
				".ai-summary-content",
			) as HTMLElement | null;
			const copyBtn = document.querySelector(
				".ai-summary-copy",
			) as HTMLButtonElement | null;
			if (!contentEl || !copyBtn) return;

			try {
				await navigator.clipboard.writeText(contentEl.textContent ?? "");
				showTemporaryButtonState(copyBtn, "コピー済み!", "", 1500, "コピー");
			} catch {
				alert("コピーに失敗しました");
			}
		});

	// AI Summary close button
	document.querySelector(".ai-summary-close")?.addEventListener("click", () => {
		const resultContainer = document.querySelector(
			".ai-summary-result",
		) as HTMLElement | null;
		if (resultContainer) {
			resultContainer.style.display = "none";
		}
	});
}

function attachChatHandlers(session: MeetingSession): void {
	const messagesEl = document.getElementById("ai-chat-messages");
	const input = document.getElementById(
		"ai-chat-input",
	) as HTMLTextAreaElement | null;
	const sendBtn = document.getElementById(
		"ai-chat-send",
	) as HTMLButtonElement | null;
	if (!messagesEl || !input || !sendBtn) return;

	// 会話履歴は詳細画面を表示している間だけ保持する（永続化しない）
	const history: ChatMessage[] = [];
	let pending = false;

	const renderMessages = (options?: { thinking?: boolean; error?: string }) => {
		const bubbles = history
			.map(
				(m) => `
        <div class="ai-chat-message ai-chat-${m.role}">
          ${escapeHtml(m.content)}
        </div>
      `,
			)
			.join("");
		const thinking = options?.thinking
			? `<div class="ai-chat-message ai-chat-assistant ai-chat-thinking">考え中...</div>`
			: "";
		const error = options?.error
			? `<div class="ai-chat-message ai-chat-error">${escapeHtml(options.error)}</div>`
			: "";
		messagesEl.innerHTML = bubbles + thinking + error;
		messagesEl.scrollTop = messagesEl.scrollHeight;
	};

	const send = async () => {
		if (pending) return;
		const question = input.value.trim();
		if (!question) return;
		if (!(await confirmApiKeySetup())) return;

		const settings = await loadSettings();
		pending = true;
		sendBtn.disabled = true;
		input.value = "";

		history.push({ role: "user", content: question });
		renderMessages({ thinking: true });

		try {
			const transcriptText = formatTranscriptAsText(session.transcript);
			const answer = await chatAboutTranscript(
				settings.ai.apiKey,
				settings.ai.model,
				transcriptText,
				history,
			);
			history.push({ role: "assistant", content: answer });
			renderMessages();
		} catch (err) {
			console.error("AI chat error:", err);
			renderMessages({
				error: `エラー: ${err instanceof Error ? err.message : String(err)}`,
			});
		} finally {
			pending = false;
			sendBtn.disabled = false;
			input.focus();
		}
	};

	sendBtn.addEventListener("click", send);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
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
