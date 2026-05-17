import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sitstand.timer",
  appName: "Sit+Stand Timer",
  webDir: "dist/public",
  server: {
    androidScheme: "https",
    iosScheme: "https",
  },
  plugins: {
    // Firebase Authentication — used ONLY as native Google identity acquisition.
    // skipNativeAuth: false so we get a populated user object (email, displayName).
    // RuntimeCore owns FSM, session lifecycle, JWT management, and refresh —
    // Firebase Auth is not used for session persistence or state.
    // The Web client ID (serverClientId equivalent) is read from google-services.json
    // automatically by the Firebase SDK on Android.
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ["google.com"],
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
