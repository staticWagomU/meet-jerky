import type { TranscriptBlock, RawCaptionEntry } from '@/utils/types';
import type {
  MeetingStartedMessage,
  TranscriptUpdateMessage,
  MeetingEndedMessage,
} from '@/utils/messaging';
import {
  extractMeetingCodeFromPath,
  isSystemMessage,
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
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 10;
const CAPTION_REGION_TIMEOUT_MS = 30_000;
const REJOIN_GRACE_PERIOD_MS = 120_000; // 2 minutes grace period for rejoin

// ─── State ───────────────────────────────────────────────────────────────────

// Session lifecycle
let sessionId: string | null = null;
let inMeeting = false;
let meetingEnded = false;
let meetingDetectionTimer: ReturnType<typeof setInterval> | null = null;
let rejoinGraceTimer: ReturnType<typeof setTimeout> | null = null;

// Transcript buffer
let currentBlock: { personName: string; text: string } | null = null;
let pendingBlocks: TranscriptBlock[] = [];
let pendingRawEntries: RawCaptionEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let totalRawCount = 0; // Total raw entries captured in this session (sent + pending)

// Caption observation
let bodyObserver: MutationObserver | null = null;
let captionObserver: MutationObserver | null = null;
let captionRegion: HTMLElement | null = null;
let captionLayoutContainer: HTMLElement | null = null;
let captionOverlayPanel: HTMLElement | null = null;
let captionHidden = true;

// Caption guard
let captionGuardActive = false;
let captionGuardBypass = false;
let captionConfirmDialog: HTMLElement | null = null;

// ─── Toggle Button & Recording Indicator ────────────────────────────────────

let toggleButton: HTMLButtonElement | null = null;
let indicatorPanel: HTMLElement | null = null;
let indicatorDot: HTMLElement | null = null;
let indicatorCount: HTMLElement | null = null;
let manualCaptureButton: HTMLButtonElement | null = null;

const INDICATOR_STYLES = {
  panel: {
    position: 'fixed',
    bottom: '120px',
    right: '24px',
    zIndex: '99999',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: '20px',
    backgroundColor: 'rgba(32, 33, 36, 0.85)',
    color: '#fff',
    fontSize: '12px',
    fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#aaa',
    flexShrink: '0',
  },
  manualBtn: {
    padding: '2px 8px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.4)',
    backgroundColor: 'transparent',
    color: '#fff',
    fontSize: '11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
} as const;

function createIndicatorPanel(): void {
  if (indicatorPanel) return;

  indicatorPanel = document.createElement('div');
  Object.assign(indicatorPanel.style, INDICATOR_STYLES.panel);

  // Recording dot
  indicatorDot = document.createElement('span');
  Object.assign(indicatorDot.style, INDICATOR_STYLES.dot);
  indicatorPanel.appendChild(indicatorDot);

  // Count label
  indicatorCount = document.createElement('span');
  indicatorCount.textContent = 'RAW: 0';
  indicatorPanel.appendChild(indicatorCount);

  // Manual capture button
  manualCaptureButton = document.createElement('button');
  manualCaptureButton.textContent = '手動記録';
  Object.assign(manualCaptureButton.style, INDICATOR_STYLES.manualBtn);
  manualCaptureButton.addEventListener('click', manualCapture);
  indicatorPanel.appendChild(manualCaptureButton);

  document.body.appendChild(indicatorPanel);
  updateIndicator();
}

function removeIndicatorPanel(): void {
  if (indicatorPanel) {
    indicatorPanel.remove();
    indicatorPanel = null;
    indicatorDot = null;
    indicatorCount = null;
    manualCaptureButton = null;
  }
}

function updateIndicator(): void {
  if (!indicatorDot || !indicatorCount) return;

  const isRecording = captionObserver !== null && captionRegion !== null;
  indicatorDot.style.backgroundColor = isRecording ? '#34a853' : '#d93025';
  indicatorCount.textContent = `RAW: ${totalRawCount}`;
}

function manualCapture(): void {
  if (!captionRegion) {
    // Try to find it again — it may have been recreated by Meet
    const region = findCaptionRegion();
    if (region) {
      observeCaptionRegion(region);
    } else {
      showNotification('字幕領域が見つかりません', 'warning', 3000);
      return;
    }
  }

  const data = extractCaptionData(captionRegion!);
  if (!data) {
    showNotification('字幕テキストが空です', 'info', 2000);
    return;
  }

  pendingRawEntries.push({
    timestamp: new Date().toISOString(),
    personName: data.personName,
    text: data.text,
  });
  totalRawCount++;
  updateIndicator();

  // Brief flash feedback on the button
  if (manualCaptureButton) {
    manualCaptureButton.textContent = '記録済';
    setTimeout(() => {
      if (manualCaptureButton) manualCaptureButton.textContent = '手動記録';
    }, 800);
  }
}

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
  removeIndicatorPanel();
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

/**
 * Walk up from the caption region to find the outermost caption overlay panel.
 * In Google Meet's layout, this is a position:absolute container that wraps
 * the entire caption area (e.g., the div with class "fJsklc").
 */
function findCaptionOverlayPanel(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el.parentElement;
  let found: HTMLElement | null = null;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (style.position === 'absolute' && current.offsetHeight > 50) {
      found = current;
    }
    // Stop if we reach a very large container (the main viewport)
    if (current.offsetHeight > window.innerHeight * 0.8) {
      break;
    }
    current = current.parentElement;
  }
  return found;
}

/** CSS properties to zero out on the layout container when collapsing */
const COLLAPSE_PROPS = [
  'height', 'min-height', 'max-height',
  'padding', 'margin', 'border',
  'flex-basis', 'flex-grow', 'flex-shrink',
] as const;

function applyCaptionVisibility(): void {
  if (!captionRegion) return;

  if (!captionLayoutContainer) {
    captionLayoutContainer = findLayoutContainer(captionRegion);
  }
  if (!captionOverlayPanel) {
    captionOverlayPanel = findCaptionOverlayPanel(captionRegion);
  }

  if (captionHidden) {
    // IMPORTANT: Do NOT use display:none — Google Meet may stop updating
    // caption text in the DOM for elements removed from the render tree,
    // which means MutationObserver never fires.
    // Instead, move the caption region off-screen so it remains "alive"
    // and Google Meet continues to push text updates.
    const rs = captionRegion.style;
    rs.setProperty('opacity', '0', 'important');
    rs.setProperty('pointer-events', 'none', 'important');
    rs.setProperty('position', 'fixed', 'important');
    rs.setProperty('top', '-9999px', 'important');
    rs.setProperty('left', '-9999px', 'important');

    // Collapse the inner layout container
    if (captionLayoutContainer) {
      const cs = captionLayoutContainer.style;
      cs.setProperty('position', 'absolute', 'important');
      for (const prop of COLLAPSE_PROPS) {
        cs.setProperty(prop, '0', 'important');
      }
      cs.setProperty('overflow', 'hidden', 'important');
    }

    // Collapse the outer overlay panel (position:absolute div wrapping entire caption area)
    if (captionOverlayPanel) {
      const ps = captionOverlayPanel.style;
      ps.setProperty('height', '0', 'important');
      ps.setProperty('min-height', '0', 'important');
      ps.setProperty('max-height', '0', 'important');
      ps.setProperty('overflow', 'hidden', 'important');
    }
  } else {
    for (const prop of ['opacity', 'pointer-events', 'position', 'top', 'left']) {
      captionRegion.style.removeProperty(prop);
    }
    if (captionLayoutContainer) {
      captionLayoutContainer.style.removeProperty('position');
      for (const prop of COLLAPSE_PROPS) {
        captionLayoutContainer.style.removeProperty(prop);
      }
      captionLayoutContainer.style.removeProperty('overflow');
    }
    if (captionOverlayPanel) {
      for (const prop of ['height', 'min-height', 'max-height', 'overflow']) {
        captionOverlayPanel.style.removeProperty(prop);
      }
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
  if (pendingBlocks.length === 0 && pendingRawEntries.length === 0) return;
  if (!sessionId) return;

  const blocksToSend = [...pendingBlocks];
  const rawToSend = [...pendingRawEntries];
  pendingBlocks = [];
  pendingRawEntries = [];

  try {
    const message: TranscriptUpdateMessage = {
      type: 'TRANSCRIPT_UPDATE',
      payload: {
        sessionId: sessionId,
        blocks: blocksToSend,
        rawEntries: rawToSend,
      },
    };
    await browser.runtime.sendMessage(message);
  } catch (e) {
    console.warn('[MTC] Failed to flush pending blocks:', e);
    // Put blocks back for retry
    pendingBlocks = [...blocksToSend, ...pendingBlocks];
    pendingRawEntries = [...rawToSend, ...pendingRawEntries];
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
  const allChildren = Array.from(region.children);

  const children = allChildren.filter(
    (el) => !isUIElement(el as HTMLElement),
  );
  if (children.length === 0) return null;

  // Find the last block that actually has text content.
  // Google Meet may append empty container divs after the caption blocks.
  let lastBlock: HTMLElement | null = null;
  for (let i = children.length - 1; i >= 0; i--) {
    const el = children[i] as HTMLElement;
    if (el.textContent?.trim()) {
      lastBlock = el;
      break;
    }
  }
  if (!lastBlock) return null;

  const blockChildren = (Array.from(lastBlock.children) as HTMLElement[]).filter(
    (el) => !isUIElement(el),
  );

  if (blockChildren.length === 0) {
    const text = lastBlock.textContent?.trim() || '';
    return text ? { personName: '', text } : null;
  }

  let personName = '';
  let captionText = '';

  if (blockChildren.length >= 2) {
    personName = blockChildren[0].textContent?.trim() || '';
    const textParts: string[] = [];
    for (let i = 1; i < blockChildren.length; i++) {
      const t = blockChildren[i].textContent?.trim();
      if (t) textParts.push(t);
    }
    captionText = textParts.join(' ');
  } else {
    captionText = blockChildren[0].textContent?.trim() || '';
  }

  if (!captionText) return null;

  return { personName, text: captionText };
}

function onCaptionMutation(): void {
  if (!captionRegion) return;

  const data = extractCaptionData(captionRegion);
  if (!data) return;

  // Record raw caption observation before any processing
  pendingRawEntries.push({
    timestamp: new Date().toISOString(),
    personName: data.personName,
    text: data.text,
  });
  totalRawCount++;
  updateIndicator();

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
  createIndicatorPanel();

  // Stop body observer since we found the region
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }

  // Disconnect previous observer if re-attaching
  if (captionObserver) {
    captionObserver.disconnect();
  }

  captionObserver = new MutationObserver(() => {
    onCaptionMutation();
  });

  captionObserver.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  updateIndicator();
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

// ─── Caption Guard (click interception) ─────────────────────────────────────

/**
 * Check if a click target is inside the caption toggle button.
 */
function isCaptionButtonClick(target: HTMLElement): boolean {
  const btn = target.closest('button');
  if (!btn) return false;
  const symbol = btn.querySelector('.google-symbols');
  if (!symbol) return false;
  const text = symbol.textContent?.trim();
  return text === 'closed_caption' || text === 'closed_caption_off';
}

function dismissConfirmDialog(): void {
  if (captionConfirmDialog) {
    captionConfirmDialog.remove();
    captionConfirmDialog = null;
  }
}

/**
 * Capturing-phase click handler on document.
 * Intercepts clicks on the caption button when captions are ON,
 * preventing accidental turn-off.
 */
function onCaptionGuardClick(e: MouseEvent): void {
  if (!inMeeting || meetingEnded) return;
  if (captionGuardBypass) return;
  if (!areCaptionsOn()) return;

  const target = e.target as HTMLElement;
  if (!isCaptionButtonClick(target)) return;

  // Block the click
  e.stopPropagation();
  e.preventDefault();

  console.log('[MTC] Caption off click intercepted — showing confirmation');
  showCaptionGuardConfirm();
}

function showCaptionGuardConfirm(): void {
  if (captionConfirmDialog) return;

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99999',
    padding: '12px 20px',
    borderRadius: '8px',
    backgroundColor: '#d93025',
    color: '#fff',
    fontSize: '13px',
    fontFamily: '"Google Sans", Roboto, Arial, sans-serif',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  });

  const msg = document.createElement('span');
  msg.textContent = '字幕をOFFにすると録音が停止します。OFFにしますか？';
  container.appendChild(msg);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'OFFにする';
  Object.assign(confirmBtn.style, {
    padding: '4px 12px',
    borderRadius: '4px',
    border: '1px solid #fff',
    backgroundColor: 'transparent',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  confirmBtn.addEventListener('click', () => {
    dismissConfirmDialog();
    // Bypass the guard for this one click
    captionGuardBypass = true;
    const btn = findCaptionButton();
    if (btn) btn.click();
    captionGuardBypass = false;
  });
  container.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'キャンセル';
  Object.assign(cancelBtn.style, {
    padding: '4px 12px',
    borderRadius: '4px',
    border: 'none',
    backgroundColor: 'rgba(255,255,255,0.2)',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  cancelBtn.addEventListener('click', dismissConfirmDialog);
  container.appendChild(cancelBtn);

  document.body.appendChild(container);
  captionConfirmDialog = container;
}

function startCaptionGuard(): void {
  if (captionGuardActive) return;
  captionGuardActive = true;
  document.addEventListener('click', onCaptionGuardClick, true);
}

function stopCaptionGuard(): void {
  if (!captionGuardActive) return;
  captionGuardActive = false;
  document.removeEventListener('click', onCaptionGuardClick, true);
  dismissConfirmDialog();
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

  // Cancel grace period timer if active (e.g. explicit leave button click)
  if (rejoinGraceTimer !== null) {
    clearTimeout(rejoinGraceTimer);
    rejoinGraceTimer = null;
  }

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

  // Visibility change — flush but do NOT end meeting
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Before unload
  window.addEventListener('beforeunload', onBeforeUnload);
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden' && inMeeting) {
    // Tab became hidden — flush pending blocks as a safety measure,
    // but do NOT end the meeting. Users frequently switch tabs during meetings.
    commitCurrentBlock();
    flushPendingBlocks();
  }
}

function onBeforeUnload(): void {
  // Cancel grace period — page is closing, no rejoin possible
  if (rejoinGraceTimer !== null) {
    clearTimeout(rejoinGraceTimer);
    rejoinGraceTimer = null;
  }

  if (inMeeting || sessionId) {
    // Best-effort flush — synchronous context, so we use sendMessage fire-and-forget
    commitCurrentBlock();

    if ((pendingBlocks.length > 0 || pendingRawEntries.length > 0) && sessionId) {
      const message: TranscriptUpdateMessage = {
        type: 'TRANSCRIPT_UPDATE',
        payload: {
          sessionId,
          blocks: [...pendingBlocks],
          rawEntries: [...pendingRawEntries],
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

/** Pause observers and timers but keep sessionId and counts for possible rejoin. */
function suspendSession(): void {
  inMeeting = false;

  stopCaptionGuard();

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
  captionOverlayPanel = null;
  currentBlock = null;

  removeToggleButton();
  removeIndicatorPanel();

  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('beforeunload', onBeforeUnload);
}

/** Fully end the session and reset all state. */
function cleanup(): void {
  suspendSession();

  pendingBlocks = [];
  pendingRawEntries = [];
  totalRawCount = 0;
  sessionId = null;
}

// ─── Rejoin Grace Period ────────────────────────────────────────────────────

function startRejoinGracePeriod(): void {
  // Flush current data before suspending
  commitCurrentBlock();
  flushPendingBlocks();

  suspendSession();

  rejoinGraceTimer = setTimeout(() => {
    rejoinGraceTimer = null;
    handleMeetingEnd();
  }, REJOIN_GRACE_PERIOD_MS);
}

// ─── Meeting Session Setup ───────────────────────────────────────────────────

/**
 * Common setup after entering (or re-entering) a meeting:
 * enable captions, start the guard, begin observing, and arm timers.
 * Called by both onMeetingDetected (new session) and onMeetingResumed (rejoin).
 */
async function setupMeetingSession(notFoundMessage: string): Promise<void> {
  const captionsEnabled = await enableCaptions();
  if (!captionsEnabled) {
    showNotification(notFoundMessage, 'warning', 8000);
  }

  startCaptionGuard();
  startBodyObserver();

  flushTimer = setInterval(() => {
    commitCurrentBlock();
    flushPendingBlocks();
  }, FLUSH_INTERVAL_MS);

  setupExitProtection();
}

async function onMeetingResumed(): Promise<void> {
  inMeeting = true;
  meetingEnded = false;

  await setupMeetingSession('Meet Transcript Clipper: 字幕ボタンが見つかりませんでした。');
}

// ─── Meeting Start ───────────────────────────────────────────────────────────

async function onMeetingDetected(): Promise<void> {
  if (inMeeting) return;
  inMeeting = true;
  meetingEnded = false;

  const meetingCode = extractMeetingCode();
  const meetingTitle = extractMeetingTitle();
  const startTimestamp = new Date().toISOString();

  sessionId = crypto.randomUUID();

  try {
    const message: MeetingStartedMessage = {
      type: 'MEETING_STARTED',
      payload: { sessionId, meetingCode, meetingTitle, startTimestamp },
    };
    await browser.runtime.sendMessage(message);
  } catch (e) {
    console.warn('[MTC] Failed to send MEETING_STARTED:', e);
  }

  await setupMeetingSession(
    'Meet Transcript Clipper: 字幕ボタンが見つかりませんでした。ホストが字幕を無効にしている可能性があります。',
  );

  // Warn if caption region doesn't appear within the timeout
  setTimeout(() => {
    if (!captionRegion && inMeeting && !meetingEnded) {
      showNotification(
        'Meet Transcript Clipper: 字幕領域が検出されませんでした。字幕が有効になっているか確認してください。',
        'warning',
        8000
      );
    }
  }, CAPTION_REGION_TIMEOUT_MS);
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
      if (rejoinGraceTimer !== null) {
        // Rejoined within grace period — resume existing session
        clearTimeout(rejoinGraceTimer);
        rejoinGraceTimer = null;
        console.log('[MTC] Rejoin detected within grace period, resuming session:', sessionId);
        onMeetingResumed();
      } else {
        // Fresh entry
        onMeetingDetected();
      }
    } else if (inMeeting && !currentlyInMeeting && !meetingEnded) {
      // User left the meeting — start grace period instead of ending immediately
      startRejoinGracePeriod();
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
