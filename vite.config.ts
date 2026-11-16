import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// ⚠️ DEV-ONLY：浏览器 mock 注入插件。apply:'serve' 保证只在 `pnpm dev` 生效，
// `vite build` / `tauri build` 完全跳过 → 生产 APK 不会包含任何 mock。
// 它把 mockInvoke.ts 垫到入口最前，在真实 invoke 发生前装好假的 __TAURI_INTERNALS__。
function browserMockInvoke(): Plugin {
  return {
    name: "hghub-browser-mock-invoke",
    apply: "serve",
    enforce: "pre",
    transform(code, id) {
      // 只垫真正的应用入口（index.html 引的 src/main.tsx），避免污染其它模块
      if (!id.endsWith("src/main.tsx")) return null;
      return {
        code: 'import "./dev/mockInvoke.js";\n' + code,
        map: null,
      };
    },
  };
}

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss(), browserMockInvoke()],
  clearScreen: false,
  // 版本号只维护 package.json（CI 会按 tag 改写它），界面里的版本由这里注入，避免写死后漂移
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
