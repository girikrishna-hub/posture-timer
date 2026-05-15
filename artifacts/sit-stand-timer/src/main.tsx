import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";

// When the service worker updates (new deployment = new chunk hashes), any
// lazy-loaded chunk that was cached under the old hash becomes a 404 and
// throws a "Failed to fetch dynamically imported module" error.  A single
// hard-reload is enough to let the new SW serve the fresh chunks.
// The sessionStorage guard prevents an infinite reload loop if the new build
// itself is somehow broken.
window.addEventListener("error", (event) => {
  const msg = event.message ?? "";
  const isChunkError =
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    event.error?.name === "ChunkLoadError";
  if (isChunkError && !sessionStorage.getItem("chunk-reload")) {
    sessionStorage.setItem("chunk-reload", "1");
    window.location.reload();
  }
});
window.addEventListener("unhandledrejection", (event) => {
  const msg = String(event.reason?.message ?? event.reason ?? "");
  const isChunkError =
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    event.reason?.name === "ChunkLoadError";
  if (isChunkError && !sessionStorage.getItem("chunk-reload")) {
    sessionStorage.setItem("chunk-reload", "1");
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// On native Capacitor builds: hide the native splash-screen / window-background
// overlay after React has painted its first real frame.
//
// Why double-rAF: the first rAF fires before the browser composites the frame,
// the second fires after — so the WebView has rendered at least one real frame
// before we remove the native overlay, preventing a blank flash.
if (Capacitor.isNativePlatform()) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      SplashScreen.hide({ fadeOutDuration: 200 }).catch((e) => {
        // Log but don't crash — if the plugin somehow isn't available the
        // styles.xml windowBackground fix below still keeps things correct.
        console.warn("[SplashScreen] hide() failed:", e);
      });
    });
  });
}
