/**
 * DOM utility functions for Google Meet caption elements.
 * All functions are stateless — they accept DOM elements as arguments
 * and return results without accessing any module-level state.
 */

/**
 * Check if an element is a UI control (button, scroll indicator, etc.)
 * rather than a caption text block.
 */
export function isUIElement(el: HTMLElement): boolean {
	if (el.tagName === "BUTTON" || el.getAttribute("role") === "button")
		return true;
	if (el.querySelector(".google-symbols")) return true;
	if (el.classList.contains("google-symbols")) return true;
	return false;
}

/**
 * Extract the current speaker name and caption text from the caption region.
 * Returns null when the region is empty or contains only UI controls.
 */
export function extractCaptionData(
	region: HTMLElement,
): { personName: string; text: string } | null {
	const allChildren = Array.from(region.children);
	const children = allChildren.filter((el) => !isUIElement(el as HTMLElement));
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

	const blockChildren = (
		Array.from(lastBlock.children) as HTMLElement[]
	).filter((el) => !isUIElement(el));

	if (blockChildren.length === 0) {
		const text = lastBlock.textContent?.trim() || "";
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

/** CSS properties to zero out on the layout container when collapsing */
export const COLLAPSE_PROPS = [
	"height",
	"min-height",
	"max-height",
	"padding",
	"margin",
	"border",
	"flex-basis",
	"flex-grow",
	"flex-shrink",
] as const;
