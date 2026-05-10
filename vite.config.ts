import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  build: {
    // 生产构建优化
    // ⚠️ macOS 12 Monterey 自带 WKWebView = Safari 15.6，不支持 ES2023
    // (Array.findLast / toSorted / toReversed 等)。esnext 不做任何转译，
    // 一旦项目依赖（tiptap 3 / antd 6 / lucide 等）输出 ES2023 语法就会
    // 抛 SyntaxError 让整个 chunk 加载失败 → 白屏。
    // 把 target 限到 safari15 让 esbuild 把 ES2023 降级到 ES2020 兼容代码。
    // chrome88/edge88/firefox88 是 antd 6 官方最低门槛，对齐避免漏网。
    target: ["es2020", "safari15", "chrome88", "edge88", "firefox88"],
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-antd": ["antd", "@ant-design/icons"],
          "vendor-editor": ["@tiptap/react", "@tiptap/starter-kit"],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },

  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
