import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

const rawPort = process.env.PORT;

// PORT is only required when running the dev/preview server.
// Capacitor builds (build:android) don't use a server, so we allow it to be absent.
const isBuildOnly = process.argv.includes("build");
const port = rawPort ? Number(rawPort) : isBuildOnly ? 5173 : (() => {
  throw new Error("PORT environment variable is required but was not provided.");
})();

if (!isBuildOnly && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? (isBuildOnly ? "/" : (() => {
  throw new Error("BASE_PATH environment variable is required but was not provided.");
})());

// Bake build identity into the bundle so the debug panel can prove which APK
// is actually running. GIT_COMMIT can be set by the build command; falls back
// to a placeholder for local builds that don't set it.
const buildTime = new Date().toISOString();
const buildCommit = process.env.GIT_COMMIT ?? "dev";

export default defineConfig({
  base: basePath,
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      devOptions: {
        enabled: true,
        type: "module",
      },
      injectManifest: {
        rollupFormat: "es",
        // Exclude HTML files from the precache manifest entirely.
        // index.html is served network-first via a NavigationRoute in sw.ts,
        // so it must NOT appear in the precache (which uses cache-first).
        globIgnores: ["**/*.html"],
      },
      manifest: {
        name: "Sit + Stand Timer",
        short_name: "Sit+Stand",
        description: "Track your daily sitting and standing time",
        theme_color: "#7ea58c",
        background_color: "#f9f5f0",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split vendor libraries into separate cacheable chunks.
        // Each chunk is fetched in parallel and cached independently,
        // so a code change only invalidates the app chunk — not the vendors.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // @clerk/* — auth library (~350 kB). Separated so it caches across
          // app deploys (it changes far less often than app code).
          if (id.includes("@clerk")) return "vendor-clerk";

          // recharts + D3 helpers — only referenced from lazy DashboardPage
          // and BladderStatsPage, so this chunk is only fetched on first
          // dashboard visit.
          if (id.includes("recharts") || id.match(/\/d3-[a-z]/)) {
            return "vendor-charts";
          }

          // Radix UI primitives — used across many pages but stable
          if (id.includes("@radix-ui")) return "vendor-radix";

          // Capacitor runtime — small but completely separate concern
          if (id.includes("@capacitor")) return "vendor-capacitor";

          // TanStack Query — needed immediately (data fetching)
          if (id.includes("@tanstack")) return "vendor-query";

          // React core + scheduler — pinned and rarely changes.
          // scheduler and react-dom have a tight internal coupling; keeping them
          // in the same chunk avoids the vendor-react ↔ vendor-misc circular
          // chunk warning that Rollup emits when scheduler ends up in vendor-react
          // while one of its dependents lands in vendor-misc.
          if (
            id.match(/[/\\]react[/\\]/) ||
            id.match(/[/\\]react-dom[/\\]/) ||
            id.match(/[/\\]scheduler[/\\]/)
          ) {
            return "vendor-react";
          }

          // html2canvas is only imported from the lazy DashboardPage chunk.
          // Returning undefined lets Rollup co-locate it there automatically
          // instead of pulling it into the eager initial bundle.
          if (id.includes("html2canvas")) return undefined;

          // workbox-* packages are only used in sw.ts (built separately).
          // Excluding them from manualChunks prevents them from appearing in
          // the main app bundle should Rollup ever follow the import graph here.
          if (id.includes("workbox-")) return undefined;

          // Everything else from node_modules (wouter, zod, etc.)
          // Packages only referenced from lazy routes are naturally co-located
          // with those routes by Rollup when they fall through to undefined.
          // Avoid a catch-all "vendor-misc" chunk — it tends to pull in
          // scheduler/react transitive deps and create circular chunk edges.
          return undefined;
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
