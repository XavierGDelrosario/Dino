// =========================================================
// The in-app photo library — a grid of the photos DINO can actually see, with MANAGE
// at its top right.
//
// WHY IT EXISTS, when iOS has a perfectly good picker. Under LIMITED access the system
// picker shows the user's whole library and quietly hands back whatever they tap, so it
// never reveals that the app's own access is narrower. This grid shows the real answer:
// these are the photos you shared. That is what makes Manage meaningful and where it
// belongs — on the thing whose contents it changes, not on the input box's toolbar.
//
// SO IT IS ONLY FOR THE LIMITED CASE. With full access the caller opens the system
// picker instead: Apple's is a better picker, and there is nothing left to manage.
//
// Tapping a tile resolves the full-size image through loadLibraryPhoto and hands it up;
// from there it is the ordinary crop → recognize path, identical to a camera shot.
// =========================================================
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Loading, LoadingDots } from "../common/Loading";
import {
  listLibraryPhotos,
  loadLibraryPhoto,
  selectMorePhotos,
  openPhotoSettings,
  type LibraryPhoto,
  type PhotoAccess,
} from "../../services/photos/access";
import "./photolibrary.css";

export function PhotoLibrarySheet({
  onPick,
  onClose,
  onAccessChange,
}: {
  /** A chosen photo at OCR resolution — the same shape the camera hands back. */
  onPick: (photo: { base64: string; format: string }) => void;
  onClose: () => void;
  /** The grant after Manage; the host uses it to retire the whole sheet on full access. */
  onAccessChange: (access: PhotoAccess) => void;
}) {
  const { t } = useI18n();
  const [photos, setPhotos] = useState<LibraryPhoto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);

  const load = useCallback(() => {
    void listLibraryPhotos().then(setPhotos);
  }, []);
  useEffect(load, [load]);

  const pick = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const photo = await loadLibraryPhoto(id);
      if (photo) onPick(photo);
    } finally {
      setBusy(false);
    }
  };

  return (
    // The backdrop dismisses; the sheet stops its own taps reaching it.
    <div className="photolib" onClick={onClose} role="presentation">
      <div
        className="photolib__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("photos.libraryTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="photolib__bar">
          <h2 className="photolib__title">{t("photos.libraryTitle")}</h2>
          {/* MANAGE, top right — the position it has in every app that hosts its own
              library, and the only place it reads as "change what is in THIS grid". */}
          <button className="photolib__manage" onClick={() => setManaging(true)}>
            {t("photos.manage")}
          </button>
        </header>

        <p className="photolib__hint">{t("photos.limitedHint")}</p>

        {photos === null ? (
          <div className="photolib__empty">
            <Loading text={t("photos.loading")} />
          </div>
        ) : photos.length === 0 ? (
          // Zero shared photos is a real state, not an error: "Limit Access" then
          // selecting nothing lands here, and Manage is the way out of it.
          <div className="photolib__empty">{t("photos.none")}</div>
        ) : (
          <ul className="photolib__grid">
            {photos.map((p) => (
              <li key={p.id}>
                <button
                  className="photolib__tile"
                  onClick={() => void pick(p.id)}
                  disabled={busy}
                  aria-label={t("photos.useThis")}
                >
                  <img src={`data:image/jpeg;base64,${p.thumb}`} alt="" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="photolib__foot">
          {busy && <LoadingDots />}
          <button className="photolib__cancel" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>

        {/* The two ways to widen access, which is all iOS offers once "Limit Access"
            has been chosen. Nested inside the sheet so dismissing it returns to the
            grid rather than closing the lot. */}
        {managing && (
          // A scrim over the sheet, so a tap anywhere else puts the menu away. This is
          // also why the menu has no Cancel of its own: the footer already has one, and
          // two buttons both reading "Cancel" in one dialog is ambiguous to anybody
          // navigating by label rather than position.
          <div className="photolib__menuscrim" onClick={() => setManaging(false)} role="presentation">
          <div className="photolib__menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="photolib__menuitem"
              onClick={() => {
                void selectMorePhotos().then((access) => {
                  setManaging(false);
                  onAccessChange(access);
                  // Re-read regardless: the selection is what this grid IS.
                  load();
                });
              }}
            >
              {t("photos.selectMore")}
            </button>
            <button
              className="photolib__menuitem"
              onClick={() => {
                // Backgrounds the app; the host re-reads the grant on resume.
                void openPhotoSettings();
                setManaging(false);
              }}
            >
              {t("photos.changeSettings")}
            </button>
          </div>
          </div>
        )}
      </div>
    </div>
  );
}
