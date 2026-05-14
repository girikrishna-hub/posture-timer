import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sitstand.timer",
  appName: "Sit+Stand Timer",
  webDir: "dist/public",
  server: {
    androidScheme: "https",
  },
  plugins: {
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
