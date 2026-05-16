import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sitstand.timer",
  appName: "Sit+Stand Timer",
  webDir: "dist/public",
  server: {
    androidScheme: "https",
  },
  plugins: {
    // Google Sign-In (native account picker).
    // scopes: email + profile are the minimum needed for Clerk's oauth_google exchange.
    // clientId: the Web client OAuth client ID from Google Cloud Console
    // (Project → APIs & Services → Credentials → OAuth 2.0 Client IDs → Web client).
    // This is NOT the Android client ID — that one is configured via google-services.json.
    // GOOGLE_FIT_CLIENT_ID is re-used here since it was created for the same project.
    GoogleAuth: {
      scopes: ["profile", "email"],
      serverClientId: process.env.GOOGLE_FIT_CLIENT_ID ?? "",
      forceCodeForRefreshToken: false,
    },
    // Splash screen: we hide it manually after React mounts (see main.tsx)
    // so the native overlay never outlives the first real WebView frame.
    SplashScreen: {
      launchAutoHide: false,          // manual control via SplashScreen.hide()
      launchShowDuration: 0,          // don't enforce a minimum display time
      backgroundColor: "#f9f5f0",     // matches app background — no white flash
      androidSpinnerStyle: "small",
      spinnerColor: "#7ea58c",
      showSpinner: false,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_notification",
      iconColor: "#7ea58c",
    },
  },
};

export default config;
