import { defineConfig } from "wxt";

export default defineConfig({
	manifest: {
		name: "ミートジャーキー",
		description: "Google Meetの文字起こしを自動取得・保存するChrome拡張機能",
		permissions: ["storage", "alarms"],
	},
});
