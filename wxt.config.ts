import { defineConfig } from "wxt";

export default defineConfig({
	manifest: {
		name: "ミートジャーキー",
		description: "Google Meetの文字起こしを自動取得・保存するChrome拡張機能",
		permissions: ["storage", "alarms", "identity"],
		oauth2: {
			// Set VITE_GOOGLE_OAUTH_CLIENT_ID in .env or replace with your Client ID
			client_id:
				process.env.VITE_GOOGLE_OAUTH_CLIENT_ID ??
				"YOUR_CLIENT_ID.apps.googleusercontent.com",
			scopes: ["https://www.googleapis.com/auth/spreadsheets"],
		},
		host_permissions: [
			"https://sheets.googleapis.com/*",
			"https://api.openai.com/*",
			"https://api.anthropic.com/*",
			"https://generativelanguage.googleapis.com/*",
		],
	},
});
