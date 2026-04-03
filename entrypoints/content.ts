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
import {
  findCaptionButton,
  findCaptionRegion,
  isInMeeting,
  findLeaveButton,
} from '@/utils/selectors';

// ─── Constants ───────────────────────────────────────────────────────────────

const POLLING_INTERVAL_MS = 2_000;
const CAPTION_RETRY_INTERVAL_MS = 1_500;
const CAPTION_MAX_RETRIES = 20;
const IDLE_COMMIT_MS = 2_000;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 10;
const CAPTION_REGION_TIMEOUT_MS = 30_000;

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
let captionLayoutContainer: HTMLElement | null = null;
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
    bottom: '80px',
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

/**
 * Walk up from the caption region to find the layout container that
 * actually reserves space in Meet's flex/grid layout.
 * This is the first ancestor whose parent has more than one child
 * (i.e., the element that sits alongside the video area).
 */
function findLayoutContainer(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent || parent === document.body) return current;
    if (parent.children.length > 1) return current;
    current = parent;
  }
  return null;
}

function applyCaptionVisibility(): void {
  if (!captionRegion) return;

  if (!captionLayoutContainer) {
    captionLayoutContainer = findLayoutContainer(captionRegion);
  }

  if (captionHidden) {
    // IMPORTANT: Do NOT use display:none — Google Meet may stop updating
    // caption text in the DOM for elements removed from the render tree,
    // which means MutationObserver never fires.
    // Instead, move the caption region off-screen so it remains "alive"
    // and Google Meet continues to push text updates.
    Object.assign(captionRegion.style, {
      opacity: '0',
      pointerEvents: 'none',
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
    });
    // Collapse the layout container so the video area reclaims the space.
    if (captionLayoutContainer) {
      Object.assign(captionLayoutContainer.style, {
        height: '0',
        minHeight: '0',
        maxHeight: '0',
        overflow: 'hidden',
      });
    }
  } else {
    Object.assign(captionRegion.style, {
      opacity: '',
      pointerEvents: '',
      position: '',
      top: '',
      left: '',
    });
    if (captionLayoutContainer) {
      Object.assign(captionLayoutContainer.style, {
        height: '',
        minHeight: '',
        maxHeight: '',
        overflow: '',
      });
    }
  }
}

// ─── Notification ───────────────────────────────────────────────────────────

function showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info', durationMs: number = 5000): void {
  const notification = document.createElement('div');
  notification.textContent = message;

  const bgColors = {
    info: '#1a73e8',
    warning: '#f9ab00',
    error: '#d93025',
  };

  Object.assign(notification.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99999',
    padding: '8px 20px',
    borderRadius: '8px',
    backgroundColor: bgColors[type],
    color: '#fff',
    fontSize: '13px',
    fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    transition: 'opacity 0.3s',
    opacity: '1',
  });

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, durationMs);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractMeetingCode(): string {
  return extractMeetingCodeFromPath(window.location.pathname);
}

function extractMeetingTitle(): string {
  const titleEl = document.querySelector('.u6vdEc');
  return titleEl?.textContent?.trim() || extractMeetingCode();
}

function isSystemMessage(text: string): boolean {
  return checkSystemMessage(text);
}

// ─── Block Management ────────────────────────────────────────────────────────

function commitCurrentBlock(): void {
  console.log('[MTC:DEBUG] commitCurrentBlock called, currentBlock:', currentBlock);
  if (!currentBlock || !currentBlock.text.trim()) return;
  if (isSystemMessage(currentBlock.text)) {
    console.log('[MTC:DEBUG] Filtered system message:', currentBlock.text);
    currentBlock = null;
    return;
  }

  const block: TranscriptBlock = {
    personName: currentBlock.personName,
    timestamp: new Date().toISOString(),
    transcriptText: currentBlock.text.trim(),
  };

  pendingBlocks.push(block);
  console.log('[MTC:DEBUG] Block committed:', block.personName, block.transcriptText.slice(0, 50), '| pendingBlocks:', pendingBlocks.length);
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
  console.log('[MTC:DEBUG] flushPendingBlocks called, pendingBlocks:', pendingBlocks.length, 'sessionId:', sessionId);
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
    console.log('[MTC:DEBUG] Sending TRANSCRIPT_UPDATE, blocks:', blocksToSend.length, blocksToSend.map(b => `${b.personName}: ${b.transcriptText.slice(0, 30)}`));
    const response = await browser.runtime.sendMessage(message);
    console.log('[MTC:DEBUG] TRANSCRIPT_UPDATE response:', response);
  } catch (e) {
    console.warn('[MTC] Failed to flush pending blocks:', e);
    // Put blocks back for retry
    pendingBlocks = [...blocksToSend, ...pendingBlocks];
  }
}

// ─── Caption Observation ─────────────────────────────────────────────────────

/**
 * Check if an element is a UI control (button, scroll indicator, etc.)
 * rather than a caption text block.
 */
function isUIElement(el: HTMLElement): boolean {
  // Button elements or elements with button role
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return true;
  // Elements containing Google Material Symbol icons (e.g. "arrow_downward")
  if (el.querySelector('.google-symbols')) return true;
  // Elements that are themselves Material Symbol icons
  if (el.classList.contains('google-symbols')) return true;
  return false;
}

function extractCaptionData(region: HTMLElement): { personName: string; text: string } | null {
  // The caption region contains block containers as direct children.
  // Each block container has a speaker name (in a nested element) and caption text.
  // Filter out UI elements (scroll buttons, etc.) that are also children of the region.
  const children = Array.from(region.children).filter(
    (el) => !isUIElement(el as HTMLElement),
  );
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
  // Filter out any UI elements (buttons, icons) that may be nested inside the block.
  const blockChildren = (Array.from(lastBlock.children) as HTMLElement[]).filter(
    (el) => !isUIElement(el),
  );
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

  console.log('[MTC:DEBUG] onCaptionMutation fired, region children:', captionRegion.children.length);

  const data = extractCaptionData(captionRegion);
  console.log('[MTC:DEBUG] extractCaptionData result:', data);
  if (!data) return;

  const result = determineCaptionAction(currentBlock, data);
  console.log('[MTC:DEBUG] determineCaptionAction:', result.action);

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
  console.log('[MTC:DEBUG] Caption region found:', region.tagName, region.getAttribute('aria-label'), 'children:', region.children.length);

  // Apply initial visibility (hidden by default)
  applyCaptionVisibility();
  createToggleButton();

  // Stop body observer since we found the region
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }

  captionObserver = new MutationObserver((mutations) => {
    console.log('[MTC:DEBUG] MutationObserver fired, mutations:', mutations.length);
    onCaptionMutation();
  });

  captionObserver.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function startBodyObserver(): void {
  // Check if caption region already exists
  const existing = findCaptionRegion();
  console.log('[MTC:DEBUG] startBodyObserver: existing region:', existing);
  if (existing) {
    observeCaptionRegion(existing);
    return;
  }

  console.log('[MTC:DEBUG] startBodyObserver: setting up MutationObserver on document.body');
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

/**
 * Check if captions are currently enabled by inspecting the icon state.
 * `closed_caption_off` = captions are OFF, `closed_caption` = captions are ON.
 */
function areCaptionsOn(): boolean {
  const symbols = document.querySelectorAll('.google-symbols');
  for (const el of symbols) {
    const text = el.textContent?.trim();
    if (text === 'closed_caption') return true;
    if (text === 'closed_caption_off') return false;
  }
  return false;
}

async function enableCaptions(): Promise<boolean> {
  for (let attempt = 0; attempt < CAPTION_MAX_RETRIES; attempt++) {
    // Check if captions are already on — don't toggle them off!
    if (areCaptionsOn()) {
      console.log('[MTC] Captions already enabled, skipping click');
      return true;
    }

    const btn = findCaptionButton();
    if (btn) {
      btn.click();
      console.log('[MTC] Captions enabled via caption button');
      return true;
    }

    // Wait and retry — Meet loads UI progressively
    await new Promise((resolve) => setTimeout(resolve, CAPTION_RETRY_INTERVAL_MS));
  }

  console.warn('[MTC] Could not find caption button after max retries');
  return false;
}

// ─── Exit Protection ─────────────────────────────────────────────────────────

function attachLeaveButtonListener(): void {
  const leaveBtn = findLeaveButton();
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

  console.log('[MTC:DEBUG] handleMeetingEnd called, sessionId:', sessionId, 'currentBlock:', currentBlock, 'pendingBlocks:', pendingBlocks.length);

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
      console.log('[MTC:DEBUG] Sending MEETING_ENDED for session:', sessionId);
      const response = await browser.runtime.sendMessage(message);
      console.log('[MTC:DEBUG] MEETING_ENDED response:', response);
    } catch (e) {
      console.warn('[MTC] Failed to send MEETING_ENDED:', e);
    }
  }

  cleanup();
}

function setupExitProtection(): void {
  // Leave button click listener
  attachLeaveButtonListener();

  // Visibility change — flush but do NOT end meeting
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Before unload
  window.addEventListener('beforeunload', onBeforeUnload);
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden' && inMeeting) {
    // Tab became hidden — flush pending blocks as a safety measure,
    // but do NOT end the meeting. Users frequently switch tabs during meetings.
    console.log('[MTC:DEBUG] visibilitychange: hidden, flushing pending blocks (NOT ending meeting)');
    commitCurrentBlock();
    flushPendingBlocks();
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

  // NOTE: meetingDetectionTimer is intentionally NOT cleared here
  // so that re-entry into a meeting (e.g. after network reconnection) can be detected.

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
  captionLayoutContainer = null;
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
  const captionsEnabled = await enableCaptions();
  if (!captionsEnabled) {
    showNotification(
      'Meet Transcript Clipper: 字幕ボタンが見つかりませんでした。ホストが字幕を無効にしている可能性があります。',
      'warning',
      8000
    );
  }

  // Start observing for caption region
  startBodyObserver();

  // DEBUG: Periodically dump DOM state to find caption region
  const debugInterval = setInterval(() => {
    if (!inMeeting || captionRegion) {
      clearInterval(debugInterval);
      return;
    }
    // Check all role="region" elements
    const regions = document.querySelectorAll('div[role="region"]');
    console.log('[MTC:DEBUG] All div[role="region"]:', regions.length, [...regions].map(r => ({
      ariaLabel: r.getAttribute('aria-label'),
      tabindex: r.getAttribute('tabindex'),
      children: r.children.length,
      text: (r.textContent || '').slice(0, 80),
    })));
    // Also check for any element that might contain captions
    const possibleCaptions = document.querySelectorAll('[aria-label*="caption" i], [aria-label*="字幕"], [aria-label*="subtitle" i]');
    console.log('[MTC:DEBUG] Elements with caption-like aria-label:', possibleCaptions.length, [...possibleCaptions].map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent || '').slice(0, 80),
    })));
  }, 3000);

  // Warn if caption region doesn't appear
  setTimeout(() => {
    if (!captionRegion && inMeeting && !meetingEnded) {
      showNotification(
        'Meet Transcript Clipper: 字幕領域が検出されませんでした。字幕が有効になっているか確認してください。',
        'warning',
        8000
      );
    }
  }, CAPTION_REGION_TIMEOUT_MS);

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
  }

  // Poll periodically — keeps running to detect re-entry after disconnection
  meetingDetectionTimer = setInterval(() => {
    const currentlyInMeeting = isInMeeting();

    if (!inMeeting && currentlyInMeeting) {
      // User entered/re-entered the meeting
      onMeetingDetected();
    } else if (inMeeting && !currentlyInMeeting && !meetingEnded) {
      // User left the meeting (call_end icon disappeared)
      handleMeetingEnd();
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
