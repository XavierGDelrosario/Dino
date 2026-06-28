// Counter-reading facade — import from "./counters".
export type { CounterReading, CounterResolver } from "./types";
export { getCounterResolver } from "./registry";
export { japaneseCounterResolver, parseJapaneseNumber } from "./japanese";
