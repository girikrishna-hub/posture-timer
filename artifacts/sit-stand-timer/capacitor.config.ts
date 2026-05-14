import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sitstand.timer",
  appName: "Sit+Stand Timer",
  webDir: "dist/public",
  server: {
    androidScheme: "https",
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_notification",
      iconColor: "#7ea58c",
    },
  },
};

export default config;
