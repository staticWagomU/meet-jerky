import type { TranscriptBlock } from '@/utils/types';
import type {
  MeetingStartedMessage,
  TranscriptUpdateMessage,
  MeetingEndedMessage,
} from '@/utils/messaging';
import {
  extractMeetingCodeFromPath,
  isSystemMessage as checkSystemMessage,
  determineCaptionAction,
} from '@/utils/helpers';

// ─── Constants ───────────────────────────────────────────────────────────────

const POLLING_INTERVAL_MS = 2_000;
const CAPTION_RETRY_INTERVAL_MS = 1_500;
const CAPTION_MAX_RETRIES = 20;
const IDLE_COMMIT_MS = 2_000;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 10;

// ─── State ───────────────────────────────────────────────────────────────────

let sessionId: string | null = null;
let inMeeting = false;
let meetingDetectionTimer: ReturnType<typeof setInterval> | null = null;

let currentBlock: { personName: string; text: string } | null = null;
let pendingBlocks: TranscriptBlock[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

let bodyObserver: MutationObserver | null = null;
let captionObserver: MutationObserver | null = null;
let captionRegion: HTMLElement | null = null;
let captionHidden = true;

let meetingEnded = false;

// ─── Toggle Button ───────────────────────────────────────────────────────────

let toggleButton: HTMLButtonElement | null = null;

function createToggleButton(): void {
  if (toggleButton) return;

  toggleButton = document.createElement('button');
  toggleButton.textContent = '字幕: 非表示';
  Object.assign(toggleButton.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '99999',
    padding: '8px 16px',
    borderRadius: '20px',
    border: 'none',
    backgroundColor: '#1a73e8',
    color: '#fff',
    fontSize: '13px',
    fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    transition: 'opacity 0.2s',
    opacity: '0.85',
  });

  toggleButton.addEventListener('mouseenter', () => {
    if (toggleButton) toggleButton.style.opacity = '1';
  });
  toggleButton.addEventListener('mouseleave', () => {
    if (toggleButton) toggleButton.style.opacity = '0.85';
  });

  toggleButton.addEventListener('click', () => {
    captionHidden = !captionHidden;
    applyCaptionVisibility();
    if (toggleButton) {
      toggleButton.textContent = captionHidden ? '字幕: 非表示' : '字幕: 表示';
    }
  });

  document.body.appendChild(toggleButton);
}

function removeToggleButton(): void {
  if (toggleButton) {
    toggleButton.remove();
    toggleButton = null;
  }
}

// ─── Caption Visibility ──────────────────────────────────────────────────────

function applyCaptionVisibility(): void {
  if (!captionRegion) return;
  if (captionHidden) {
    Object.assign(captionRegion.style, {
      position: 'absolute',
      left: '-9999px',
      opacity: '0',
    });
  } else {
    Object.assign(captionRegion.style, {
      position: '',
      left: '',
      opacity: '',
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractMeetingCode(): string {
  return extractMeetingCodeFromPath(window.location.pathname);
}

function extractMeetingTitle(): string {
  const titleEl = document.querySelector('.u6vdEc');
  return titleEl?.textContent?.trim() || extractMeetingCode();
}

function findGoogleSymbolByText(text: string): Element | null {
  const symbols = document.querySelectorAll('.google-symbols');
  for (const el of symbols) {
    if (el.textContent?.trim() === text) {
      return el;
    }
  }
  return null;
}

function isInMeeting(): boolean {
  return findGoogleSymbolByText('call_end') !== null;
}

function isSystemMessage(text: string): boolean {
  return checkSystemMessage(text);
}

// ─── Block Management ────────────────────────────────────────────────────────

function commitCurrentBlock(): void {
  if (!currentBlock || !currentBlock.text.trim()) return;
  if (isSystemMessage(currentBlock.text)) {
    currentBlock = null;
    return;
  }

  const block: TranscriptBlock = {
    personName: currentBlock.personName,
    timestamp: new Date().toISOString(),
    transcriptText: currentBlock.text.trim(),
  };

  pendingBlocks.push(block);
  currentBlock = null;

  if (pendingBlocks.length >= FLUSH_THRESHOLD) {
    flushPendingBlocks();
  }
}

function resetIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    commitCurrentBlock();
  }, IDLE_COMMIT_MS);
}

async function flushPendingBlocks(): Promise<void> {
  if (pendingBlocks.length === 0 || !sessionId) return;

  const blocksToSend = [...pendingBlocks];
  pendingBlocks = [];

  try {
    const message: TranscriptUpdateMessage = {
      type: 'TRANSCRIPT_UPDATE',
      payload: {
        sessionId: sessionId,
        blocks: blocksToSend,
      },
    };
    await browser.runtime.sendMessage(message);
  } catch (e) {
    console.warn('[MTC] Failed to flush pending blocks:', e);
    // Put blocks back for retry
    pendingBlocks = [...blocksToSend, ...pendingBlocks];
  }
}

// ─── Caption Observation ─────────────────────────────────────────────────────

function extractCaptionData(region: HTMLElement): { personName: string; text: string } | null {
  // The caption region contains block containers as direct children.
  // Each block container has a speaker name (in a nested element) and caption text.
  // We look at the LAST block in the region (the most recent utterance).
  const children = Array.from(region.children);
  if (children.length === 0) return null;

  const lastBlock = children[children.length - 1] as HTMLElement;
  if (!lastBlock) return null;

  // Walk through the block to find speaker name and text.
  // Typically the structure is:
  //   <div> (block container)
  //     <div> (speaker name wrapper)
  //       <span/div> speaker name text
  //     </div>
  //     <div> (caption text wrapper)
  //       <span/div> caption text
  //     </div>
  //   </div>
  // Since class names are obfuscated, we use structural position.
  const blockChildren = Array.from(lastBlock.children) as HTMLElement[];
  if (blockChildren.length === 0) {
    // Might be a flat structure, try textContent
    const text = lastBlock.textContent?.trim() || '';
    return text ? { personName: '', text } : null;
  }

  let personName = '';
  let captionText = '';

  if (blockChildren.length >= 2) {
    // First child(ren) might be the speaker name, last child is the text
    // The name element is usually smaller and comes first
    personName = blockChildren[0].textContent?.trim() || '';
    // Collect text from remaining children
    const textParts: string[] = [];
    for (let i = 1; i < blockChildren.length; i++) {
      const t = blockChildren[i].textContent?.trim();
      if (t) textParts.push(t);
    }
    captionText = textParts.join(' ');
  } else {
    // Single child - might contain both name and text
    captionText = blockChildren[0].textContent?.trim() || '';
  }

  if (!captionText) return null;

  return { personName, text: captionText };
}

function onCaptionMutation(): void {
  if (!captionRegion) return;

  const data = extractCaptionData(captionRegion);
  if (!data) return;

  const result = determineCaptionAction(currentBlock, data);

  switch (result.action) {
    case 'start':
      currentBlock = result.block;
      break;
    case 'commit_and_start':
      currentBlock = result.commitBlock;
      commitCurrentBlock();
      currentBlock = result.newBlock;
      break;
    case 'update':
      currentBlock = result.block;
      break;
  }

  resetIdleTimer();
}

function observeCaptionRegion(region: HTMLElement): void {
  captionRegion = region;

  // Apply initial visibility (hidden by default)
  applyCaptionVisibility();
  createToggleButton();

  // Stop body observer since we found the region
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }

  captionObserver = new MutationObserver(() => {
    onCaptionMutation();
  });

  captionObserver.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function findCaptionRegion(): HTMLElement | null {
  // Primary selector
  const primary = document.querySelector<HTMLElement>(
    'div[role="region"][aria-label="Captions"]'
  );
  if (primary) return primary;

  // Fallback
  const fallback = document.querySelector<HTMLElement>('div[role="region"][tabindex="0"]');
  return fallback;
}

function startBodyObserver(): void {
  // Check if caption region already exists
  const existing = findCaptionRegion();
  if (existing) {
    observeCaptionRegion(existing);
    return;
  }

  bodyObserver = new MutationObserver(() => {
    const region = findCaptionRegion();
    if (region) {
      observeCaptionRegion(region);
    }
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ─── Auto-enable Captions ────────────────────────────────────────────────────

async function enableCaptions(): Promise<void> {
  for (let attempt = 0; attempt < CAPTION_MAX_RETRIES; attempt++) {
    // Primary: find by google-symbols icon text
    const icon = findGoogleSymbolByText('closed_caption_off');
    if (icon) {
      const btn = icon.closest('button');
      if (btn) {
        btn.click();
        console.log('[MTC] Captions enabled via icon button');
        return;
      }
    }

    // Fallback: aria-label based
    const fallbackBtn =
      document.querySelector<HTMLButtonElement>('button[aria-label*="字幕"]') ||
      document.querySelector<HTMLButtonElement>('button[aria-label*="caption" i]');
    if (fallbackBtn) {
      fallbackBtn.click();
      console.log('[MTC] Captions enabled via aria-label button');
      return;
    }

    // Wait and retry — Meet loads UI progressively
    await new Promise((resolve) => setTimeout(resolve, CAPTION_RETRY_INTERVAL_MS));
  }

  console.warn('[MTC] Could not find caption button after max retries');
}

// ─── Exit Protection ─────────────────────────────────────────────────────────

function attachLeaveButtonListener(): void {
  const callEndIcon = findGoogleSymbolByText('call_end');
  if (!callEndIcon) return;

  const leaveBtn = callEndIcon.closest('button');
  if (!leaveBtn) return;

  leaveBtn.addEventListener(
    'click',
    () => {
      handleMeetingEnd();
    },
    { once: true }
  );
}

async function handleMeetingEnd(): Promise<void> {
  if (meetingEnded) return;
  meetingEnded = true;

  // Commit any in-progress block
  commitCurrentBlock();

  // Flush all pending blocks
  await flushPendingBlocks();

  // Send MEETING_ENDED
  if (sessionId) {
    try {
      const message: MeetingEndedMessage = {
        type: 'MEETING_ENDED',
        payload: { sessionId },
      };
      await browser.runtime.sendMessage(message);
    } catch (e) {
      console.warn('[MTC] Failed to send MEETING_ENDED:', e);
    }
  }

  cleanup();
}

function setupExitProtection(): void {
  // Leave button click listener
  attachLeaveButtonListener();

  // Visibility change
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Before unload
  window.addEventListener('beforeunload', onBeforeUnload);
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden' && inMeeting) {
    handleMeetingEnd();
  }
}

function onBeforeUnload(): void {
  if (inMeeting) {
    // Best-effort flush — synchronous context, so we use sendMessage fire-and-forget
    commitCurrentBlock();

    if (pendingBlocks.length > 0 && sessionId) {
      const message: TranscriptUpdateMessage = {
        type: 'TRANSCRIPT_UPDATE',
        payload: {
          sessionId,
          blocks: [...pendingBlocks],
        },
      };
      // Fire and forget — may or may not arrive
      try {
        browser.runtime.sendMessage(message);
      } catch {
        // Best effort
      }
    }

    if (sessionId) {
      const endMessage: MeetingEndedMessage = {
        type: 'MEETING_ENDED',
        payload: { sessionId },
      };
      try {
        browser.runtime.sendMessage(endMessage);
      } catch {
        // Best effort
      }
    }
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  inMeeting = false;

  if (meetingDetectionTimer !== null) {
    clearInterval(meetingDetectionTimer);
    meetingDetectionTimer = null;
  }

  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }

  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }

  captionRegion = null;
  currentBlock = null;
  pendingBlocks = [];
  sessionId = null;

  removeToggleButton();

  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('beforeunload', onBeforeUnload);
}

// ─── Meeting Start ───────────────────────────────────────────────────────────

async function onMeetingDetected(): Promise<void> {
  if (inMeeting) return;
  inMeeting = true;
  meetingEnded = false;

  const meetingCode = extractMeetingCode();
  const meetingTitle = extractMeetingTitle();
  const startTimestamp = new Date().toISOString();

  // Generate sessionId on the content script side
  sessionId = crypto.randomUUID();

  console.log('[MTC] Meeting detected:', { meetingCode, meetingTitle, sessionId });

  // Send MEETING_STARTED to background
  try {
    const message: MeetingStartedMessage = {
      type: 'MEETING_STARTED',
      payload: {
        sessionId,
        meetingCode,
        meetingTitle,
        startTimestamp,
      },
    };
    await browser.runtime.sendMessage(message);
  } catch (e) {
    console.warn('[MTC] Failed to send MEETING_STARTED:', e);
  }

  // Auto-enable captions
  await enableCaptions();

  // Start observing for caption region
  startBodyObserver();

  // Set up periodic flush
  flushTimer = setInterval(() => {
    commitCurrentBlock();
    flushPendingBlocks();
  }, FLUSH_INTERVAL_MS);

  // Set up exit protection
  setupExitProtection();
}

// ─── Meeting Detection Polling ───────────────────────────────────────────────

function startMeetingDetection(): void {
  // Check immediately
  if (isInMeeting()) {
    onMeetingDetected();
    return;
  }

  // Poll periodically
  meetingDetectionTimer = setInterval(() => {
    if (!inMeeting && isInMeeting()) {
      onMeetingDetected();
      // Stop polling once meeting is detected
      if (meetingDetectionTimer !== null) {
        clearInterval(meetingDetectionTimer);
        meetingDetectionTimer = null;
      }
    }
  }, POLLING_INTERVAL_MS);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    console.log('[MTC] Content script loaded');
    startMeetingDetection();
  },
});
