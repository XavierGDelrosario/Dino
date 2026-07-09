/* eslint-disable react-refresh/only-export-components -- the provider, the useI18n
   hook, and the catalog re-exports are intentionally co-located as the i18n entry
   point; splitting them for Fast Refresh isn't worth the indirection. */
// =========================================================
// i18n runtime (#17). A tiny React context over the string catalog: current
// locale (persisted) + a `t(key, params?)` lookup with `{name}` interpolation.
// Missing keys in a non-`en` locale can't happen (compile-checked in messages.ts);
// at runtime we still fall back en → key, so nothing renders blank.
// =========================================================
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { messages, LOCALES, type Locale, type MessageKey } from "./messages";

export { LOCALES, type Locale, type MessageKey } from "./messages";

const STORAGE_KEY = "dino.locale";
const SUPPORTED = new Set<string>(LOCALES.map((l) => l.code));

/** Saved choice → browser language → "en". */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.has(saved)) return saved as Locale;
  } catch {
    /* localStorage unavailable (SSR/private mode) — fall through */
  }
  const nav =
    typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return SUPPORTED.has(nav) ? (nav as Locale) : "en";
}

function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_m, k) => (k in params ? String(params[k]) : `{${k}}`));
}

export type TFn = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Count-based singular/plural: plural(t, n, "common.word", "common.words"). */
export const plural = (t: TFn, n: number, one: MessageKey, other: MessageKey): string =>
  t(n === 1 ? one : other);

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const t = useCallback<TFn>(
    (key, params) => {
      const table = messages[locale] ?? messages.en;
      return interpolate(table[key] ?? messages.en[key] ?? key, params);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <LocaleProvider>");
  return ctx;
}
