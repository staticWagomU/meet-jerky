import "./style.css";
import { summarizeTranscript } from "@/utils/ai-client";
import { authenticate, getAuthToken } from "@/utils/google-auth";
import {
	createDocument,
	DocsApiError,
	writeDocumentContent,
} from "@/utils/google-docs";
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
	} else {
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
      <div class="toolbar-formats">
        <button class="format-btn" id="export-md" title="Markdownでエクスポート">MD</button>
        <button class="format-btn" id="export-json" title="JSONでエクスポート">JSON</button>
        <button class="format-btn" id="export-txt" title="テキストでエクスポート">TXT</button>
        <button class="format-btn" id="export-raw" title="生の字幕ログをエクスポート">RAW</button>
        <button class="format-btn" id="export-minutes" title="議事録テンプレートでエクスポート">議事録</button>
        <button class="format-btn docs-btn" id="export-docs" title="Google Docsにエクスポート">Docs</button>
      </div>
      <div class="toolbar-actions">
        <button class="action-btn ai-btn" id="ai-summary-btn" title="AIで要約を生成">AI要約</button>
        <button class="action-btn copy-btn" id="copy-button">全文コピー</button>
      </div>
    </div>
    <div class="ai-memo-section">
      <textarea class="ai-memo-input" id="ai-memo-input" placeholder="メモを入力（任意）：会議中に気づいたこと、補足情報など" rows="3"></textarea>
    </div>
    <div class="ai-summary-result" style="display:none">
      <div class="ai-summary-header">
        <span class="ai-summary-title">AI要約</span>
        <button class="ai-summary-copy">コピー</button>
        <button class="ai-summary-close">&#10005;</button>
      </div>
      <div class="ai-summary-content"></div>
    </div>
    <div class="transcript-list">${transcriptHtml}</div>
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

	attachExportHandlers(session);
}

// --- Google Docs export handler ---

async function handleDocsExport(session: MeetingSession): Promise<void> {
	const docsBtn = document.getElementById(
		"export-docs",
	) as HTMLButtonElement | null;
	if (!docsBtn) return;

	let token = await getAuthToken();
	if (!token) {
		// Token missing or expired — try to re-authenticate inline
		try {
			token = await authenticate();
		} catch {
			showTemporaryButtonState(
				docsBtn,
				"要ログイン",
				"export-docs-error",
				2000,
				"Docs",
			);
			if (
				confirm(
					"Googleアカウントでのログインが必要です。設定画面を開きますか？",
				)
			) {
				browser.runtime.openOptionsPage();
			}
			return;
		}
	}

	try {
		docsBtn.disabled = true;
		docsBtn.textContent = "作成中...";
		docsBtn.classList.add("export-docs-loading");

		const settings = await loadSettings();
		const title = getSessionDisplayTitle(session);

		// Generate minutes from template
		const minutes = generateMinutes(session, settings.template.minutesTemplate);

		// Build document content
		let content = "";

		// Check if AI summary exists in the popup
		const summaryText =
			document.querySelector(".ai-summary-content")?.textContent ?? "";
		if (summaryText) {
			content += "AI 要約\n";
			content += `${"━".repeat(40)}\n\n`;
			content += `${summaryText}\n\n`;
			content += `${"━".repeat(40)}\n\n`;
		}

		// Add the minutes content (template-expanded transcript)
		content += minutes;

		// Create document and write content — retry once on 401
		const exportToDocs = async (authToken: string) => {
			const { documentId, documentUrl } = await createDocument(
				authToken,
				`${title} - 議事録`,
			);
			await writeDocumentContent(authToken, documentId, content);
			return documentUrl;
		};

		let documentUrl: string;
		try {
			documentUrl = await exportToDocs(token);
		} catch (err) {
			if (err instanceof DocsApiError && err.status === 401) {
				// Token was revoked server-side — re-authenticate and retry once
				token = await authenticate();
				documentUrl = await exportToDocs(token);
			} else {
				throw err;
			}
		}

		// Success state with link — uses innerHTML so not suitable for showTemporaryButtonState
		docsBtn.classList.remove("export-docs-loading");
		docsBtn.classList.add("export-docs-success");
		docsBtn.disabled = false;
		docsBtn.innerHTML = `<a href="${documentUrl}" target="_blank" style="color:white;text-decoration:none;">開く</a>`;

		setTimeout(() => {
			docsBtn.textContent = "Docs";
			docsBtn.classList.remove("export-docs-success");
		}, 5000);
	} catch (err) {
		console.error("Docs export error:", err);
		docsBtn.disabled = false;
		docsBtn.classList.remove("export-docs-loading");
		showTemporaryButtonState(
			docsBtn,
			"エラー",
			"export-docs-error",
			3000,
			"Docs",
		);
	}
}

// --- Export handlers ---

function attachExportHandlers(session: MeetingSession): void {
	// Copy button
	document
		.getElementById("copy-button")
		?.addEventListener("click", async () => {
			const text = formatTranscriptAsText(session.transcript);
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

	document
		.getElementById("export-docs")
		?.addEventListener("click", () => handleDocsExport(session));

	// AI Summary button
	const aiBtn = document.getElementById(
		"ai-summary-btn",
	) as HTMLButtonElement | null;
	if (aiBtn) {
		aiBtn.addEventListener("click", async () => {
			const settings = await loadSettings();

			if (!settings.ai.apiKey) {
				if (confirm("APIキーが設定されていません。設定画面を開きますか？")) {
					browser.runtime.openOptionsPage();
				}
				return;
			}

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
					settings.ai.provider,
					settings.ai.apiKey,
					settings.template.customPrompt,
					transcriptText,
					settings.ai.model,
					memo,
				);

				if (resultContainer && contentEl) {
					contentEl.textContent = result;
					resultContainer.style.display = "block";
				}

				aiBtn.classList.remove("loading");
				showTemporaryButtonState(
					aiBtn,
					"生成完了",
					"success",
					2000,
					"AI要約",
					() => {
						aiBtn.disabled = false;
					},
				);
			} catch (err) {
				aiBtn.classList.remove("loading");
				console.error("AI summary error:", err);

				if (resultContainer && contentEl) {
					contentEl.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
					resultContainer.style.display = "block";
				}

				showTemporaryButtonState(
					aiBtn,
					"エラー",
					"error",
					3000,
					"AI要約",
					() => {
						aiBtn.disabled = false;
					},
				);
			}
		});
	}

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
