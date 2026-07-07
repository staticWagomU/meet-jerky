import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// .direnv/ 配下にnixが作るソースのスナップショットを拾わないよう、
		// テスト対象をリポジトリ本体のテストディレクトリに限定する。
		include: ["utils/__tests__/**/*.test.ts"],
	},
});
