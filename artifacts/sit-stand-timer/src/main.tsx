import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";

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
