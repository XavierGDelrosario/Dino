// =========================================================
// Daily word — the data behind the iOS home-screen widgets.
//
// There are TWO widgets (ios/App/DailyWordWidget), one word a day each:
//   · New word    — an UNSEEN word at the user's band (the Learn tab's level pool);
//   · Review word — the saved word the user is weakest on right now (the review
//                   queue's head), or another new word while nothing is saved/shaky.
//
// A widget is a separate process that cannot run our JS, sign in, or reach Supabase
// with the user's session. So the APP does the choosing and hands the widget a
// finished SCHEDULE: `WIDGET_DAYS` words per widget, word[i] belonging to `day` + i.
// The widget only indexes into it by date (wrapping when it runs out), which is what
// keeps the word changing at midnight for someone who hasn't opened the app in a week.
//
// The hand-off is a JSON string written through the local `DailyWordWidget` Capacitor
// plugin into the App Group's UserDefaults (DailyWordStore.swift decodes it — the
// payload shape here and the Codable structs there must stay in step; bump `version`
// on a breaking change and the widget shows its "open DINO" state instead of garbage).
//
// Synced at most ONCE PER LOCAL DAY per (user, pair, band): re-drawing on every launch
// would change "today's word" under a user who already read it this morning.
//
// Native-only, inert everywhere else — like services/photos and services/ocr.
// =========================================================
import { Capacitor, registerPlugin } from "@capacitor/core";
import { getUserProficiencyBand } from "../calibration";
import { otherLanguage, resolveLanguagePair, type LangCode } from "../language";
import { fetchLearnWords } from "../learn";
import { getProficiency } from "../proficiency";
import { peekReviewQueue, type ReviewQueueItem } from "../review";
import { getUserProfile } from "../session";
import type { Word } from "../words/repository";

/** Days of words handed over per sync. The edge caps a learn draw at 30 (MAX_LEARN_LIMIT),
 *  and the sync asks for two of these (the review widget's fallback), so keep it ≤ 15. */
export const WIDGET_DAYS = 14;

/** Payload schema version — mirrored by DailyWordStore.swift's `supportedVersion`. */
export const WIDGET_PAYLOAD_VERSION = 1;

/** One day's word, already resolved to what the widget prints. */
export interface WidgetWord {
  headword: string;
  /** The annotation shown beside the headword (kana; the kanji for a `uk` entry). */
  reading: string | null;
  meaning: string;
  /** Proficiency label ("N4", "B1"), curated or estimated; null when the word has none. */
  level: string | null;
  /** Language of the headword — the widget picks the right CJK glyph set from it. */
  lang: string;
  /** Displayed confidence 0–5 for a saved word; null for a new one. */
  confidence: number | null;
}

export interface DailyWordPayload {
  version: number;
  /** The LOCAL calendar day (YYYY-MM-DD) that index 0 of each list belongs to. */
  day: string;
  newWords: WidgetWord[];
  reviewWords: WidgetWord[];
}

interface DailyWordWidgetPlugin {
  setPayload(opts: { json: string }): Promise<void>;
}

const Native = registerPlugin<DailyWordWidgetPlugin>("DailyWordWidget");

/** Is there a widget to feed? False on web and on a build without the plugin. */
export function widgetAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("DailyWordWidget");
}

/** The device's local calendar day, YYYY-MM-DD — the widget rolls over at LOCAL midnight. */
export function localDay(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function fromCard(card: Word[]): WidgetWord | null {
  const primary = card[0];
  if (!primary) return null;
  return {
    headword: primary.input,
    reading: primary.inputReading,
    meaning: primary.translation,
    level: getProficiency(primary)?.label ?? null,
    lang: primary.sourceLang,
    confidence: null,
  };
}

function fromSaved(item: ReviewQueueItem): WidgetWord {
  return {
    headword: item.input,
    reading: item.inputReading,
    meaning: item.translation,
    level: getProficiency(item)?.label ?? null,
    lang: item.sourceLang,
    confidence: item.confidenceRating,
  };
}

/**
 * Lay the drawn words out as the two widgets' schedules. PURE.
 *
 * `cards` is ONE learn draw, split in two: the first WIDGET_DAYS feed the New widget and
 * the rest are the Review widget's fallback — so with nothing to review the two widgets
 * still never show the same word on the same day. Any saved word to review wins over the
 * fallback entirely (a short review list wraps rather than being padded with new words:
 * three shaky words on rotation is the nudge the widget exists for).
 */
export function buildDailyWordPayload(params: {
  day: string;
  cards: Word[][];
  review: ReviewQueueItem[];
}): DailyWordPayload {
  const fresh = params.cards.map(fromCard).filter((w): w is WidgetWord => w !== null);
  const newWords = fresh.slice(0, WIDGET_DAYS);
  const spare = fresh.slice(WIDGET_DAYS);
  const saved = params.review.slice(0, WIDGET_DAYS).map(fromSaved);
  return {
    version: WIDGET_PAYLOAD_VERSION,
    day: params.day,
    newWords,
    reviewWords: saved.length > 0 ? saved : spare.length > 0 ? spare : newWords,
  };
}

const SYNC_KEY = "dino.widget.synced";

function lastSync(): string | null {
  try {
    return localStorage.getItem(SYNC_KEY);
  } catch {
    return null;
  }
}

function markSynced(stamp: string): void {
  try {
    localStorage.setItem(SYNC_KEY, stamp);
  } catch {
    /* no storage → we simply re-sync next time */
  }
}

let inFlight: Promise<boolean> | null = null;

/**
 * Draw today's schedule and hand it to the widgets. Resolves true when a payload was
 * written, false when there was nothing to do (not native, or already synced today).
 *
 * Best-effort and silent: the widget is a convenience, and on any failure it keeps the
 * schedule it already has — which still rolls over daily — so nothing is cleared here.
 * `force` skips the once-a-day check.
 */
export function syncDailyWordWidget(userId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!widgetAvailable()) return Promise.resolve(false);
  inFlight ??= run(userId, opts.force === true).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(userId: string, force: boolean): Promise<boolean> {
  try {
    const [profile, storedBand] = await Promise.all([getUserProfile(userId), getUserProficiencyBand(userId)]);
    const { learning, native } = resolveLanguagePair(profile);
    // Same rule as LearnView: a pair needs two different languages.
    const explainIn: LangCode = native !== learning ? native : otherLanguage(learning);
    // Never calibrated → the easiest band, which is where Learn starts a new user too.
    const band = storedBand ?? 1;
    const day = localDay();

    const stamp = [userId, day, learning, explainIn, band].join("|");
    if (!force && lastSync() === stamp) return false;

    // Independent draws, and neither is allowed to sink the other: a guest with no
    // vocabulary has no queue, and a language with no level pool has no new words.
    const [cards, review] = await Promise.all([
      fetchLearnWords({ band, source: learning, target: explainIn, limit: WIDGET_DAYS * 2 }).catch((e) => {
        console.warn("[widget] couldn't draw new words", e);
        return null;
      }),
      peekReviewQueue({ userId, limit: WIDGET_DAYS }).catch((e) => {
        console.warn("[widget] couldn't read the review queue", e);
        return null;
      }),
    ]);
    // Both failed (offline, most likely): keep yesterday's schedule and try again later.
    if (cards === null && review === null) return false;

    const payload = buildDailyWordPayload({ day, cards: cards ?? [], review: review ?? [] });
    await Native.setPayload({ json: JSON.stringify(payload) });
    // Only a COMPLETE draw settles the day; a half one is shown but retried.
    if (cards !== null && review !== null) markSynced(stamp);
    return true;
  } catch (e) {
    console.warn("[widget] daily word sync failed", e);
    return false;
  }
}

/**
 * Keep the widgets fed for `userId`: now, and each time the app comes back to the
 * foreground (the cheap once-a-day check makes that free on every return but the first
 * of a new day). Returns a teardown.
 */
export function watchDailyWordWidget(userId: string): () => void {
  if (!widgetAvailable()) return () => {};
  const sync = () => void syncDailyWordWidget(userId);
  // `visibilitychange` rather than Capacitor's appStateChange: it needs no extra plugin
  // and fires when the WebView returns to the foreground.
  const onVisible = () => {
    if (document.visibilityState === "visible") sync();
  };
  sync();
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
