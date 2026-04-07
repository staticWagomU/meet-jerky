// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showNotification } from "../notification";

describe("showNotification", () => {
	beforeEach(() => {
		// Clean up any existing notifications
		document.body.innerHTML = "";
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a notification element in the DOM", () => {
		showNotification("テスト通知", "info", 5000);
		const notifications = document.body.querySelectorAll("div");
		expect(notifications.length).toBe(1);
		expect(notifications[0].textContent).toBe("テスト通知");
	});

	it("removes duplicate notification when same message is shown again", () => {
		showNotification("同じメッセージ", "info", 5000);
		showNotification("同じメッセージ", "info", 5000);
		const notifications = document.body.querySelectorAll("div");
		expect(notifications.length).toBe(1);
	});

	it("allows multiple different notifications simultaneously", () => {
		showNotification("メッセージ1", "info", 5000);
		showNotification("メッセージ2", "warning", 5000);
		const notifications = document.body.querySelectorAll("div");
		expect(notifications.length).toBe(2);
	});

	it("removes notification from DOM after duration expires", () => {
		showNotification("消える通知", "info", 3000);
		expect(document.body.querySelectorAll("div").length).toBe(1);

		// Advance past duration + fade time
		vi.advanceTimersByTime(3300);
		expect(document.body.querySelectorAll("div").length).toBe(0);
	});

	it("applies correct background color for each type", () => {
		showNotification("info", "info", 5000);
		const el = document.body.querySelector("div");
		expect(el?.style.backgroundColor).toBe("#1a73e8");
	});
});
