// =========================================================
// Public surface of the senses module (import from "./senses").
//   provider.ts    the SenseProvider contract
//   registry.ts    language-pair -> provider routing (+ MT fallback)
//   mtFallback.ts  the single-sense fallback used until a dictionary is added
// =========================================================

export * from "./provider";
export * from "./registry";
