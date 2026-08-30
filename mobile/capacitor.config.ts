import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.boosted.mobile",
  appName: "Boosted",
  webDir: "../web/dist",
  backgroundColor: "#101010",
  loggingBehavior: "debug",
  ios: {
    preferredContentMode: "mobile",
    contentInset: "never",
  },
  android: {
    captureInput: true,
  },
  server: {
    hostname: "localhost",
    androidScheme: "https",
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#101010",
      showSpinner: false,
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#101010",
      overlaysWebView: true,
    },
    Keyboard: {
      resize: "native",
    },
  },
};

export default config;
