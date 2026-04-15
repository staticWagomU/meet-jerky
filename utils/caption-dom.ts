/**
 * DOM utility functions for Google Meet caption elements.
 * All functions are stateless — they accept DOM elements as arguments
 * and return results without accessing any module-level state.
 */

import type { CaptionData } from "./types";

/**
 * Check if an element is a UI control (button, scroll indicator, etc.)
 * rather than a caption text block.
 * Uses only stable signals: tag name, role, inline style, icon font class.
 */
export function isUIElement(el: HTMLElement): boolean {
	if (el.tagName === "BUTTON" || el.getAttribute("role") === "button")
		return true;
	if (el.querySelector(".google-symbols")) return true;
	if (el.classList.contains("google-symbols")) return true;
	if (el.style.display === "none") return true;
	return false;
}

/**
 * Extract speaker name and caption text from a single caption block element.
 * Returns null when the block has no meaningful text.
 */
function extractBlockData(block: HTMLElement): CaptionData | null {
	const blockChildren = (Array.from(block.children) as HTMLElement[]).filter(
		(el) => !isUIElement(el),
	);

	if (blockChildren.length === 0) {
		const text = block.textContent?.trim() || "";
		return text ? { personName: "", text } : null;
	}

	let personName = "";
	let captionText = "";

	if (blockChildren.length >= 2) {
		personName = blockChildren[0].textContent?.trim() || "";
		const textParts: string[] = [];
		for (let i = 1; i < blockChildren.length; i++) {
			const t = blockChildren[i].textContent?.trim();
			if (t) textParts.push(t);
		}
		captionText = textParts.join(" ");
	} else {
		captionText = blockChildren[0].textContent?.trim() || "";
	}

	if (!captionText) return null;

	return { personName, text: captionText };
}

/**
 * Filter the region's children to only those that look like caption blocks:
 * not a UI element, not hidden, and has meaningful text content.
 */
function getCaptionBlocks(region: HTMLElement): HTMLElement[] {
	return (Array.from(region.children) as HTMLElement[]).filter((el) => {
		if (isUIElement(el)) return false;
		if (!el.textContent?.trim()) return false;
		return true;
	});
}

/**
 * Extract the current speaker name and caption text from the caption region.
 * Returns null when the region is empty or contains only UI controls.
 * (Kept for backward compatibility — returns only the last block.)
 */
export function extractCaptionData(region: HTMLElement): CaptionData | null {
	const blocks = getCaptionBlocks(region);
	if (blocks.length === 0) return null;

	// Return the last block (preserves original behavior)
	for (let i = blocks.length - 1; i >= 0; i--) {
		const data = extractBlockData(blocks[i]);
		if (data) return data;
	}
	return null;
}

/**
 * Extract all caption blocks from the region as an array.
 * Each entry represents a visible speaker's current caption state.
 * When multiple people speak simultaneously, multiple entries are returned.
 */
export function extractAllCaptionData(region: HTMLElement): CaptionData[] {
	const blocks = getCaptionBlocks(region);
	const results: CaptionData[] = [];

	for (const block of blocks) {
		const data = extractBlockData(block);
		if (data) results.push(data);
	}

	return results;
}
