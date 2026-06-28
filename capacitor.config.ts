import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the built web app (dist/) in a native iOS shell so we can use
// on-device features (speech, camera/OCR, handwriting). The whole React app runs
// unchanged inside the WebView; `services/` stays platform-neutral. App Store is NOT
// a goal yet — this is for installing on a dev device to test those features.
//
// NOTE: the bundled web build must point at a backend the DEVICE can reach. The
// local Supabase (127.0.0.1) is NOT reachable from a phone — build with the PROD
// VITE_SUPABASE_URL + publishable key (see scripts/build-ios.sh / the iOS guide),
// or set `server.url` to your Mac's LAN dev-server for live reload.
const config: CapacitorConfig = {
  appId: "com.xaviergdelrosario.dino",
  appName: "DINO",
  webDir: "dist",
  plugins: {
    // Route the app's HTTPS calls (Supabase auth + the translate edge function)
    // through NATIVE HTTP, so they aren't browser fetches and CORS never applies —
    // the native shell needs no entry in the edge function's ALLOWED_ORIGINS, and
    // prod CORS stays web-only (just the Pages domain). Only http(s) URLs are
    // intercepted; relative / capacitor:// asset loads (e.g. the kuromoji /dict
    // payload) pass through untouched.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
