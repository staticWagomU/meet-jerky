// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
	extractAllCaptionData,
	extractCaptionData,
	isUIElement,
} from "../caption-dom";

/**
 * Helper: build a caption block mimicking Google Meet's structure.
 * Structure: <div><div>[img + <div><span>name</span></div>]</div><div>text</div></div>
 */
function buildCaptionBlock(
	personName: string,
	text: string,
): HTMLElement {
	const block = document.createElement("div");

	// Speaker info container
	const speakerInfo = document.createElement("div");
	const avatar = document.createElement("img");
	avatar.alt = "";
	speakerInfo.appendChild(avatar);

	const nameContainer = document.createElement("div");
	const nameSpan = document.createElement("span");
	nameSpan.textContent = personName;
	nameContainer.appendChild(nameSpan);
	speakerInfo.appendChild(nameContainer);

	block.appendChild(speakerInfo);

	// Caption text
	const textDiv = document.createElement("div");
	textDiv.textContent = text;
	block.appendChild(textDiv);

	return block;
}

/**
 * Helper: build a scroll/navigation UI element (non-caption child of region).
 */
function buildScrollUI(): HTMLElement {
	const container = document.createElement("div");
	const btn = document.createElement("button");
	const icon = document.createElement("i");
	icon.className = "google-symbols";
	icon.textContent = "arrow_downward";
	btn.appendChild(icon);
	container.appendChild(btn);
	return container;
}

/**
 * Helper: build a hidden div (like the scroll indicator in Google Meet).
 */
function buildHiddenDiv(): HTMLElement {
	const outer = document.createElement("div");
	const inner = document.createElement("div");
	inner.style.display = "none";
	outer.appendChild(inner);
	return outer;
}

describe("isUIElement", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("identifies button elements", () => {
		const btn = document.createElement("button");
		btn.textContent = "click";
		expect(isUIElement(btn)).toBe(true);
	});

	it("identifies elements with role=button", () => {
		const div = document.createElement("div");
		div.setAttribute("role", "button");
		expect(isUIElement(div)).toBe(true);
	});

	it("identifies elements containing google-symbols", () => {
		const div = document.createElement("div");
		const icon = document.createElement("i");
		icon.className = "google-symbols";
		div.appendChild(icon);
		expect(isUIElement(div)).toBe(true);
	});

	it("identifies elements with display:none", () => {
		const div = document.createElement("div");
		div.style.display = "none";
		expect(isUIElement(div)).toBe(true);
	});

	it("does not flag normal content divs", () => {
		const div = document.createElement("div");
		div.textContent = "Hello world";
		expect(isUIElement(div)).toBe(false);
	});
});

describe("extractCaptionData (backward compatibility)", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("extracts speaker name and text from a single caption block", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello world"));

		const result = extractCaptionData(region);
		expect(result).toEqual({ personName: "Alice", text: "Hello world" });
	});

	it("returns the last block when multiple exist", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello"));
		region.appendChild(buildCaptionBlock("Bob", "Hi there"));

		const result = extractCaptionData(region);
		expect(result).toEqual({ personName: "Bob", text: "Hi there" });
	});

	it("ignores UI elements like scroll buttons", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello"));
		region.appendChild(buildScrollUI());

		const result = extractCaptionData(region);
		expect(result).toEqual({ personName: "Alice", text: "Hello" });
	});

	it("returns null for an empty region", () => {
		const region = document.createElement("div");
		expect(extractCaptionData(region)).toBeNull();
	});
});

describe("extractAllCaptionData", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("returns all caption blocks from the region", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello world"));
		region.appendChild(buildCaptionBlock("Bob", "Hi there"));

		const result = extractAllCaptionData(region);
		expect(result).toEqual([
			{ personName: "Alice", text: "Hello world" },
			{ personName: "Bob", text: "Hi there" },
		]);
	});

	it("filters out scroll button UI elements", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello"));
		region.appendChild(buildScrollUI());
		region.appendChild(buildCaptionBlock("Bob", "World"));

		const result = extractAllCaptionData(region);
		expect(result).toEqual([
			{ personName: "Alice", text: "Hello" },
			{ personName: "Bob", text: "World" },
		]);
	});

	it("filters out hidden divs", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello"));
		region.appendChild(buildHiddenDiv());

		const result = extractAllCaptionData(region);
		expect(result).toEqual([{ personName: "Alice", text: "Hello" }]);
	});

	it("skips blocks with empty text content", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Hello"));

		const emptyBlock = document.createElement("div");
		region.appendChild(emptyBlock);

		const result = extractAllCaptionData(region);
		expect(result).toEqual([{ personName: "Alice", text: "Hello" }]);
	});

	it("returns empty array when region has no caption blocks", () => {
		const region = document.createElement("div");
		region.appendChild(buildScrollUI());
		region.appendChild(buildHiddenDiv());

		const result = extractAllCaptionData(region);
		expect(result).toEqual([]);
	});

	it("returns single block as an array", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "Solo speaker"));

		const result = extractAllCaptionData(region);
		expect(result).toEqual([{ personName: "Alice", text: "Solo speaker" }]);
	});

	it("handles blocks mixed with various UI elements", () => {
		const region = document.createElement("div");
		region.appendChild(buildCaptionBlock("Alice", "First"));
		region.appendChild(buildHiddenDiv());
		region.appendChild(buildCaptionBlock("Bob", "Second"));
		region.appendChild(buildScrollUI());
		region.appendChild(buildCaptionBlock("Charlie", "Third"));

		const result = extractAllCaptionData(region);
		expect(result).toEqual([
			{ personName: "Alice", text: "First" },
			{ personName: "Bob", text: "Second" },
			{ personName: "Charlie", text: "Third" },
		]);
	});
});
