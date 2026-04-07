// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areCaptionsOn, enableCaptions, findCaptionRegion } from "../selectors";

describe("enableCaptions", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns true immediately if captions are already on", async () => {
		// Setup: Create a .google-symbols element with text "closed_caption" (= captions ON)
		const span = document.createElement("span");
		span.className = "google-symbols";
		span.textContent = "closed_caption";
		document.body.appendChild(span);

		const promise = enableCaptions(3, 100);
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result).toBe(true);
	});

	it("clicks caption button and returns true when captions turn on after click", async () => {
		// Setup: Create a button with .google-symbols "closed_caption_off" (= captions OFF)
		const btn = document.createElement("button");
		const span = document.createElement("span");
		span.className = "google-symbols";
		span.textContent = "closed_caption_off";
		btn.appendChild(span);
		document.body.appendChild(btn);

		// Simulate: clicking the button toggles captions on
		btn.addEventListener("click", () => {
			span.textContent = "closed_caption";
		});

		const promise = enableCaptions(3, 100);
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result).toBe(true);
	});

	it("returns false when caption button is not found after max retries", async () => {
		// Setup: No caption button in DOM
		const promise = enableCaptions(2, 50);
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result).toBe(false);
	});

	it("retries when button click does not enable captions", async () => {
		// Setup: Button exists but clicking doesn't change icon state
		const btn = document.createElement("button");
		const span = document.createElement("span");
		span.className = "google-symbols";
		span.textContent = "closed_caption_off";
		btn.appendChild(span);
		document.body.appendChild(btn);

		// Don't add click handler — captions never turn on
		const promise = enableCaptions(2, 50);
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result).toBe(false);
	});
});

describe("findCaptionRegion", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("finds region by known aria-label", () => {
		const region = document.createElement("div");
		region.setAttribute("role", "region");
		region.setAttribute("aria-label", "字幕");
		document.body.appendChild(region);

		expect(findCaptionRegion()).toBe(region);
	});

	it("finds English caption region", () => {
		const region = document.createElement("div");
		region.setAttribute("role", "region");
		region.setAttribute("aria-label", "Captions");
		document.body.appendChild(region);

		expect(findCaptionRegion()).toBe(region);
	});

	it("returns null when no region exists", () => {
		expect(findCaptionRegion()).toBeNull();
	});

	it("does not match region with form controls in fallback", () => {
		// Create a region that would match the old broad fallback
		const region = document.createElement("div");
		region.setAttribute("role", "region");
		region.setAttribute("tabindex", "0");
		const input = document.createElement("input");
		region.appendChild(input);
		document.body.appendChild(region);

		expect(findCaptionRegion()).toBeNull();
	});

	it("matches fallback region with text-containing child divs", () => {
		const region = document.createElement("div");
		region.setAttribute("role", "region");
		region.setAttribute("tabindex", "0");
		const child = document.createElement("div");
		child.textContent = "Speaker: Hello world";
		region.appendChild(child);
		document.body.appendChild(region);

		expect(findCaptionRegion()).toBe(region);
	});

	it("does not match fallback region with empty children", () => {
		const region = document.createElement("div");
		region.setAttribute("role", "region");
		region.setAttribute("tabindex", "0");
		const child = document.createElement("div");
		// No text content
		region.appendChild(child);
		document.body.appendChild(region);

		expect(findCaptionRegion()).toBeNull();
	});
});

describe("areCaptionsOn", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("returns true when closed_caption icon exists", () => {
		const span = document.createElement("span");
		span.className = "google-symbols";
		span.textContent = "closed_caption";
		document.body.appendChild(span);

		expect(areCaptionsOn()).toBe(true);
	});

	it("returns false when closed_caption_off icon exists", () => {
		const span = document.createElement("span");
		span.className = "google-symbols";
		span.textContent = "closed_caption_off";
		document.body.appendChild(span);

		expect(areCaptionsOn()).toBe(false);
	});

	it("returns false when no google-symbols element exists", () => {
		expect(areCaptionsOn()).toBe(false);
	});
});
