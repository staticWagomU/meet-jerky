/**
 * Locale-aware selectors for Google Meet UI elements.
 * Google Meet changes aria-label values based on the browser's language setting.
 */

/** Known aria-label values for the caption button across locales */
const CAPTION_BUTTON_LABELS = [
  '字幕をオンにする',      // Japanese
  '字幕をオフにする',      // Japanese (when already on)
  'Turn on captions',      // English
  'Turn off captions',     // English (when already on)
  'Activar subtítulos',    // Spanish
  'Sous-titres activés',   // French
];

/** Known aria-label values for the caption region */
const CAPTION_REGION_LABELS = [
  'Captions',   // English
  '字幕',       // Japanese
  'Subtítulos', // Spanish
  'Sous-titres',// French
];

/** Known aria-label values for the leave button */
const LEAVE_BUTTON_LABELS = [
  'Leave call',   // English
  '通話から退出', // Japanese
];

/**
 * Find a Google Material Symbol by its text content.
 */
export function findGoogleSymbolByText(text: string): Element | null {
  const symbols = document.querySelectorAll('.google-symbols');
  for (const el of symbols) {
    if (el.textContent?.trim() === text) {
      return el;
    }
  }
  return null;
}

/**
 * Find the caption toggle button.
 * Strategy: google-symbols icon text (most stable) → aria-label fallback
 */
export function findCaptionButton(): HTMLButtonElement | null {
  // Primary: Material icon text
  const symbols = document.querySelectorAll('.google-symbols');
  for (const el of symbols) {
    const text = el.textContent?.trim();
    if (text === 'closed_caption_off' || text === 'closed_caption') {
      const btn = el.closest('button');
      if (btn) return btn as HTMLButtonElement;
    }
  }

  // Fallback: aria-label based (multi-locale)
  for (const label of CAPTION_BUTTON_LABELS) {
    const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (btn) return btn;
  }

  // Ultra-fallback: partial match
  const partialBtn =
    document.querySelector<HTMLButtonElement>('button[aria-label*="caption" i]') ||
    document.querySelector<HTMLButtonElement>('button[aria-label*="字幕"]') ||
    document.querySelector<HTMLButtonElement>('button[aria-label*="subtítulo" i]');
  return partialBtn;
}

/**
 * Find the caption region element.
 */
export function findCaptionRegion(): HTMLElement | null {
  // Try each known locale label
  for (const label of CAPTION_REGION_LABELS) {
    const region = document.querySelector<HTMLElement>(`div[role="region"][aria-label="${label}"]`);
    if (region) return region;
  }

  // Fallback: tabindex-based
  return document.querySelector<HTMLElement>('div[role="region"][tabindex="0"]');
}

/**
 * Check if the user is currently in a meeting.
 */
export function isInMeeting(): boolean {
  return findGoogleSymbolByText('call_end') !== null;
}

/**
 * Find the leave/end call button.
 */
export function findLeaveButton(): HTMLButtonElement | null {
  // Primary: google-symbols icon
  const icon = findGoogleSymbolByText('call_end');
  if (icon) {
    const btn = icon.closest('button');
    if (btn) return btn as HTMLButtonElement;
  }

  // Fallback: aria-label
  for (const label of LEAVE_BUTTON_LABELS) {
    const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (btn) return btn;
  }

  return (
    document.querySelector<HTMLButtonElement>('button[aria-label*="Leave" i]') ||
    document.querySelector<HTMLButtonElement>('button[aria-label*="退出"]')
  );
}

/**
 * Check if captions are currently enabled by inspecting the icon state.
 * `closed_caption_off` = captions are OFF, `closed_caption` = captions are ON.
 */
export function areCaptionsOn(): boolean {
  const symbols = document.querySelectorAll('.google-symbols');
  for (const el of symbols) {
    const text = el.textContent?.trim();
    if (text === 'closed_caption') return true;
    if (text === 'closed_caption_off') return false;
  }
  return false;
}

/**
 * Attempt to enable captions by clicking the caption button.
 * Retries up to maxRetries times with retryIntervalMs between attempts
 * to handle Google Meet's progressive UI loading.
 */
export async function enableCaptions(
  maxRetries: number,
  retryIntervalMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }

  console.warn('[MTC] Could not find caption button after max retries');
  return false;
}
