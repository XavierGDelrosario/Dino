// The way out of a page, back to the app: just the arrow, at the top-left of every
// page (sign-in, profile, history, the legal pages). One component so they all sit in
// the same place and read the same to a screen reader, which hears the full label.
import { useI18n } from "../../i18n";
import { Link } from "../../router";

export function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/" className="page__back" ariaLabel={t("profile.back")} title={t("profile.back")}>
      ←
    </Link>
  );
}
