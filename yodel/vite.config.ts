import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const headers = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default defineConfig({
  publicDir: false,
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [".", "../src/wasm", "../src/worklet", "../src/ui/render", "../src/ui/analysis.ts",
        "../src/ui/body.ts", "../src/ui/colors.ts",
        "../public/fonts", "../node_modules"]
        .map((path) => fileURLToPath(new URL(path, import.meta.url))),
    },
  },
  preview: { headers },
  plugins: [
    {
      name: "yodel-static-files",
      generateBundle() {
        const notices = ["../LICENSE", "../public/fonts/OFL.txt", "../node_modules/three/LICENSE"].map((path) =>
          readFileSync(new URL(path, import.meta.url), "utf8"),
        );
        this.emitFile({ type: "asset", fileName: "licenses.txt", source: notices.join("\n\n") });
        const rules = Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);
        this.emitFile({ type: "asset", fileName: "_headers", source: ["/*", ...rules, ""].join("\n") });
      },
    },
  ],
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", sourcemap: false },
});
