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
function extractBlockData(
	block: HTMLElement,
): CaptionData | null {
	const blockChildren = (
		Array.from(block.children) as HTMLElement[]
	).filter((el) => !isUIElement(el));

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
export function extractCaptionData(
	region: HTMLElement,
): CaptionData | null {
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
export function extractAllCaptionData(
	region: HTMLElement,
): CaptionData[] {
	const blocks = getCaptionBlocks(region);
	const results: CaptionData[] = [];

	for (const block of blocks) {
		const data = extractBlockData(block);
		if (data) results.push(data);
	}

	return results;
}

/**
 * Walk up from the caption region to find the layout container that
 * actually reserves space in Meet's flex/grid layout.
 * This is the first ancestor whose parent has more than one child
 * (i.e., the element that sits alongside the video area).
 */
export function findLayoutContainer(el: HTMLElement): HTMLElement | null {
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
export function findCaptionOverlayPanel(el: HTMLElement): HTMLElement | null {
	let current: HTMLElement | null = el.parentElement;
	let found: HTMLElement | null = null;
	while (current && current !== document.body) {
		const style = getComputedStyle(current);
		if (style.position === "absolute" && current.offsetHeight > 50) {
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

/**
 * Collect ancestor elements between the caption region and the layout
 * boundary. The layout boundary is where the caption-specific container
 * tree joins the main layout — i.e., the first ancestor whose parent
 * has multiple children (the video area is one of those siblings).
 *
 * By stopping at this boundary (inclusive), we collapse all caption-only
 * wrappers without affecting shared containers that also hold the video.
 */
export function findCaptionAncestors(el: HTMLElement): HTMLElement[] {
	const ancestors: HTMLElement[] = [];
	let current: HTMLElement | null = el.parentElement;
	while (current && current !== document.body) {
		ancestors.push(current);
		const parent = current.parentElement;
		if (!parent || parent === document.body) break;
		// Stop after the element whose parent has multiple children —
		// that parent is shared with the video area and must not be touched.
		if (parent.children.length > 1) break;
		current = parent;
	}
	return ancestors;
}

/** CSS properties to zero out on caption ancestors when collapsing */
export const COLLAPSE_PROPS = [
	"height",
	"min-height",
	"max-height",
	"width",
	"min-width",
	"max-width",
	"padding",
	"margin",
	"border",
	"flex-basis",
	"flex-grow",
	"flex-shrink",
] as const;
