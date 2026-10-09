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
function buildCaptionBlock(personName: string, text: string): HTMLElement {
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

describe("self speaker name", () => {
	const avatar = "https://lh3.googleusercontent.com/a/test-profile";

	beforeEach(() => {
		document.body.innerHTML = "";
	});

	function addParticipant(id: string, name: string, listItem = false): void {
		const participant = document.createElement("div");
		participant.setAttribute("data-participant-id", id);
		if (listItem) {
			participant.setAttribute("role", "listitem");
			participant.setAttribute("aria-label", name);
		} else {
			const label = document.createElement("span");
			label.className = "notranslate";
			label.textContent = name;
			participant.appendChild(label);
		}
		const img = document.createElement("img");
		img.src = `${avatar}=s50-p-k-no-mo?theming`;
		participant.appendChild(img);
		document.body.appendChild(participant);
	}

	function selfRegion(label = "あなた"): HTMLElement {
		const region = document.createElement("div");
		const block = buildCaptionBlock(label, "あなたの意見を聞かせてください");
		const img = block.querySelector("img");
		if (img) img.src = `${avatar}=s192-c-mo`;
		region.appendChild(block);
		return region;
	}

	it.each([
		"あなた",
		"You",
	])("resolves %s for automatic and manual capture", (label) => {
		addParticipant("self", "田中太郎");
		const region = selfRegion(label);
		const expected = {
			personName: "田中太郎",
			text: "あなたの意見を聞かせてください",
		};
		expect(extractCaptionData(region)).toEqual(expected);
		expect(extractAllCaptionData(region)).toEqual([expected]);
	});

	it("uses the participant list name even without a self tile", () => {
		addParticipant("self", "田中太郎", true);
		expect(extractCaptionData(selfRegion())?.personName).toBe("田中太郎");
	});

	it("treats the same participant in a tile and list as one match", () => {
		addParticipant("self", "田中太郎");
		addParticipant("self", "田中太郎", true);
		expect(extractCaptionData(selfRegion())?.personName).toBe("田中太郎");
	});

	it("keeps the label if multiple participants share an avatar", () => {
		addParticipant("self", "田中太郎");
		addParticipant("other", "佐藤花子");
		expect(extractCaptionData(selfRegion())?.personName).toBe("あなた");
	});

	it.each([
		"",
		"あなた",
		"You",
	])("keeps the label when the participant name is %j", (name) => {
		addParticipant("self", name);
		expect(extractCaptionData(selfRegion())?.personName).toBe("あなた");
	});

	it("keeps the label without a matching avatar", () => {
		addParticipant("self", "田中太郎");
		const region = selfRegion();
		region
			.querySelector("img")
			?.setAttribute("src", "https://lh3.googleusercontent.com/a/other=s192");
		expect(extractCaptionData(region)?.personName).toBe("あなた");
	});

	it("keeps the label when the caption has no image", () => {
		addParticipant("self", "田中太郎");
		const region = selfRegion();
		region.querySelector("img")?.remove();
		expect(extractCaptionData(region)?.personName).toBe("あなた");
	});

	it("preserves other speakers and their caption text", () => {
		addParticipant("self", "田中太郎");
		expect(extractCaptionData(selfRegion("佐藤花子"))).toEqual({
			personName: "佐藤花子",
			text: "あなたの意見を聞かせてください",
		});
	});
});
