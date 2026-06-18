// =========================================================
// Public surface of the senses module (import from "./senses").
//   provider.ts    the SenseProvider contract
//   registry.ts    language-pair -> provider routing (empty; decision is server-side)
//   mtFallback.ts  the default provider — delegates to the edge function (JMdict
//                  multi-sense; MT fallback would be single-sense)
// =========================================================

export * from "./provider";
export * from "./registry";
