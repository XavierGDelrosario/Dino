// Minimal browser shim for Node's `path`, aliased in vite.config for the browser
// build. kuromoji's dictionary loader calls `path.join(dicPath, file)` to build
// the URLs it fetches from /dict/; Vite externalizes Node's `path` in the
// browser (→ "path.join is not a function"), so kuromoji silently fails to load
// and analysis falls back to Intl.Segmenter (no lemmas). Only `join` is needed;
// a few safe extras are included so any incidental use degrades gracefully.

/** Join path/URL segments with single slashes (no protocol-aware normalization
 *  needed — the only caller joins "/dict/" with a filename). */
export function join(...parts: string[]): string {
  return parts.filter((p) => p && p.length > 0).join("/").replace(/\/{2,}/g, "/");
}

export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

export const sep = "/";

export default { join, basename, dirname, extname, sep };
