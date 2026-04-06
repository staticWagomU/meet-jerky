import "./style.css";
import {
	computeTranscriptDiffs,
	escapeHtml,
	extractParticipants,
	formatDate,
	formatRawTranscriptAsText,
	formatSessionAsJson,
	formatSessionAsMarkdown,
	formatTimeOnly,
	formatTranscriptAsText,
} from "@/utils/helpers";
import type { MeetingSession } from "@/utils/types";

interface SessionSummary {
	sessionId: string;
	meetingCode: string;
	meetingTitle: string;
	startTimestamp: string;
	endTimestamp: string;
	transcriptCount: number;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app element not found");

const ONBOARDING_KEY = "onboarding-completed";

// State

// --- Message helpers ---

async function getSessions(): Promise<{ sessions: SessionSummary[] }> {
	return browser.runtime.sendMessage({ type: "GET_SESSIONS" });
}

async function getTranscript(
	sessionId: string,
): Promise<{ session: MeetingSession }> {
	return browser.runtime.sendMessage({
		type: "GET_TRANSCRIPT",
		payload: { sessionId },
	});
}

async function deleteSession(sessionId: string): Promise<{ success: boolean }> {
	return browser.runtime.sendMessage({
		type: "DELETE_SESSION",
		payload: { sessionId },
	});
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
		return;
	}

	const listItems = sessions
		.map(
			(session) => `
    <div class="session-item" data-session-id="${escapeHtml(session.sessionId)}">
      <div class="session-info">
        <div class="session-title">${escapeHtml(session.meetingTitle || session.meetingCode)}</div>
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
			// Don't navigate when clicking the delete button
			if (target.closest(".delete-button")) return;

			const sessionId = (item as HTMLElement).dataset.sessionId;
			if (sessionId) {
				navigateToDetail(sessionId);
			}
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
      <div class="detail-title">${escapeHtml(session.meetingTitle || session.meetingCode)}</div>
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
		const filename = `${session.meetingTitle || session.meetingCode}_${session.startTimestamp.split("T")[0]}.md`;
		downloadFile(md, filename, "text/markdown");
	});

	document.getElementById("export-json")?.addEventListener("click", () => {
		const json = formatSessionAsJson(session);
		const filename = `${session.meetingTitle || session.meetingCode}_${session.startTimestamp.split("T")[0]}.json`;
		downloadFile(json, filename, "application/json");
	});

	document.getElementById("export-txt")?.addEventListener("click", () => {
		const txt = formatTranscriptAsText(session.transcript);
		const filename = `${session.meetingTitle || session.meetingCode}_${session.startTimestamp.split("T")[0]}.txt`;
		downloadFile(txt, filename, "text/plain");
	});

	document.getElementById("export-raw")?.addEventListener("click", () => {
		const raw = formatRawTranscriptAsText(session.rawTranscript ?? []);
		const filename = `${session.meetingTitle || session.meetingCode}_${session.startTimestamp.split("T")[0]}_raw.txt`;
		downloadFile(raw, filename, "text/plain");
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
