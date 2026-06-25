// Browser shim for `zlibjs/bin/gunzip.min.js`, aliased in vite.config for the
// build. kuromoji's BrowserDictionaryLoader does:
//     var zlib = require("zlibjs/bin/gunzip.min.js");
//     var gz   = new zlib.Zlib.Gunzip(new Uint8Array(buf));
//     var out  = gz.decompress();           // → Uint8Array
// to gunzip the /dict/*.dat.gz files. zlibjs is a Closure-compiled UMD that
// assigns its `Zlib` export via top-level `this` (the global). esbuild (dev) lets
// that through, but the Rollup PROD build runs the module in strict mode where
// `this` is undefined, so `zlib.Zlib` comes back undefined and `.Gunzip` throws
// ("Cannot read properties of undefined (reading 'Gunzip')") INSIDE kuromoji's
// async loader — its build() callback never fires, so analyze() hangs forever
// (endless spinner on the paragraph reader). We replace it with fflate's reliable
// synchronous gunzip, exposing the exact `Zlib.Gunzip(...).decompress()` shape
// kuromoji expects.
import { gunzipSync } from "fflate";

class Gunzip {
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  decompress(): Uint8Array {
    return gunzipSync(this.data);
  }
}

export const Zlib = { Gunzip };
export default { Zlib };
