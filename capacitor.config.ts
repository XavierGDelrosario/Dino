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
  // NOTE: do NOT enable CapacitorHttp — it globally patches fetch and breaks
  // supabase-js `functions.invoke` (the edge call hangs on the native Response).
  // Native edge access is granted by adding `capacitor://localhost` to the edge
  // function's ALLOWED_ORIGINS secret instead (CORS, not a fetch patch).
};

export default config;
