// UI-language (native-language) selector — #17. Distinct from the translation
// source/target in LangBar: this swaps the chrome the app is shown in. Persists
// via the i18n provider.
import { useI18n, LOCALES, type Locale } from "../../i18n";
import "./common.css";

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="langpicker">
      {t("ui.language")}
      <select
        className="select select--sm"
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        aria-label={t("ui.language")}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
