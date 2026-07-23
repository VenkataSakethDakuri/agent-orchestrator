import { defineConfig } from "vite";

// Keep the Daytona SDK external. Bundling its dual CJS/ESM dependency graph
// corrupts tslib's default export in the Electron main bundle at runtime.
// Electron can load the SDK's declared CommonJS export directly from node_modules.
export default defineConfig({
	build: {
		rollupOptions: {
			external: ["@daytona/sdk"],
		},
	},
});