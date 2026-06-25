import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

// kuromoji fetches its gzipped dictionary (/dict/*.dat.gz) and gunzips it itself.
// Vite's static server sets `Content-Encoding: gzip` on .gz files, so the browser
// transparently decompresses them — then kuromoji's gunzip sees already-inflated
// bytes and dies with "invalid file signature". Serve /dict/ as raw octet-stream
// with NO Content-Encoding so the browser hands kuromoji the gzip bytes intact.
function serveDictRaw(): Plugin {
  const dictDir = fileURLToPath(new URL("./public/dict/", import.meta.url));
  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = (req.url || "").split("?")[0];
    if (!url.startsWith("/dict/") || url.includes("..")) return next();
    const file = dictDir + url.slice("/dict/".length);
    fs.readFile(file, (err, data) => {
      if (err) return next();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", data.length);
      res.end(data); // deliberately NO Content-Encoding
    });
  };
  return {
    name: "serve-dict-raw",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [serveDictRaw(), react()],
  resolve: {
    alias: {
      // kuromoji's loader uses Node's `path.join`, which Vite externalizes in the
      // browser (→ silent fallback to Intl.Segmenter). Point `path` at a shim.
      // App code uses the `@/*` TS alias, never a bare `path` import.
      path: fileURLToPath(new URL("./src/shims/path.ts", import.meta.url)),
      // kuromoji gunzips /dict/*.gz via zlibjs, whose Closure-UMD `this`-global
      // export breaks in the strict-mode Rollup prod build (zlib.Zlib === undefined
      // → ".Gunzip" throws → loader hangs → endless spinner). Shim it with fflate.
      "zlibjs/bin/gunzip.min.js": fileURLToPath(
        new URL("./src/shims/zlibjs-gunzip.ts", import.meta.url),
      ),
    },
  },
});
