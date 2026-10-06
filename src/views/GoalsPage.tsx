// /goals: the two streak numbers, the daily goals (new words · reviews) with what they
// add up to over time, and the daily reminder. Reached by pressing the 🔥 badge in the
// top bar (and from the account menu). Guests included — a goal needs no account.
//
// Goals persist on `users` (hooks/useGoals → services/goals); the reminder is a device
// setting (services/reminders). Today's numbers come from the same study_days rows as
// the badge (hooks/useStreak), so the two never disagree.
import { useEffect, useRef, useState } from "react";
import { BackLink } from "../components/common/BackLink";
import { ErrorText } from "../components/common/ErrorText";
import { useI18n, plural } from "../i18n";
import { useGoals } from "../hooks/useGoals";
import { canOpenAppSettings, openAppSettings } from "../services/appSettings";
import { onAppResume } from "../services/appResume";
import { useStreak } from "../hooks/useStreak";
import {
  NEW_WORDS_GOAL_OPTIONS,
  REVIEWS_GOAL_OPTIONS,
  projections,
  type HorizonKey,
} from "../services/goals";
import {
  DEFAULT_REMINDER,
  MAX_MINUTES,
  MIN_MINUTES,
  STEP_MINUTES,
  checkReminderPermission,
  formatMinutes,
  loadReminderSettings,
  reminderSupport,
  reminderWindow,
  requestReminderPermission,
  saveReminderSettings,
  syncReminders,
  type ReminderPermission,
  type ReminderSettings,
} from "../services/reminders";
import "../components/common/common.css";
import "../components/lists/lists.css"; // .dualrange — the same slider as the Lists confidence filter
import "./goals.css";

const HORIZON_LABEL: Record<HorizonKey, "goals.inWeek" | "goals.inMonth" | "goals.inHalfYear" | "goals.inYear"> = {
  week: "goals.inWeek",
  month: "goals.inMonth",
  halfYear: "goals.inHalfYear",
  year: "goals.inYear",
};

export function GoalsPage({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const { streaks, today } = useStreak(userId);
  const { goals, error, update } = useGoals(userId);

  // ── reminders ──
  const support = reminderSupport();
  const [reminder, setReminder] = useState<ReminderSettings>(() =>
    typeof localStorage === "undefined" ? DEFAULT_REMINDER : loadReminderSettings(),
  );
  const [permission, setPermission] = useState<ReminderPermission>("prompt");
  /** The user pressed "Turn on" while the OS said no and was sent to Settings: when
   *  they come back with permission granted, finish what they asked for. */
  const wantsOn = useRef(false);
  useEffect(() => {
    void checkReminderPermission().then(setPermission);
  }, []);

  const copy = { title: t("reminder.notifTitle"), body: t("reminder.notifBody") };
  // The slider fires onChange for every step of a drag; the setting is saved at once
  // (cheap) but the OS schedule — a cancel + up to 14 notifications — is rewritten only
  // once the thumb has rested. The on/off button syncs immediately.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (syncTimer.current) clearTimeout(syncTimer.current); }, []);
  const apply = (next: ReminderSettings, { settle = false } = {}) => {
    setReminder(next);
    saveReminderSettings(next);
    if (syncTimer.current) clearTimeout(syncTimer.current);
    const sync = () => void syncReminders(next, copy, streaks?.studiedToday ?? null);
    if (settle) syncTimer.current = setTimeout(sync, 600);
    else sync();
  };
  // Re-check permission whenever the app comes back to the front — the return from
  // Settings on iOS — and turn the reminder on if that is what the user wanted. Every
  // resume signal is covered (services/appResume): the WebView's visibilitychange alone
  // did not fire on the return from Settings.
  const recheck = () =>
    checkReminderPermission().then((p) => {
      setPermission(p);
      if (p === "granted" && wantsOn.current) {
        wantsOn.current = false;
        setReminder((cur) => {
          const next = { ...cur, enabled: true };
          saveReminderSettings(next);
          void syncReminders(next, copy, streaks?.studiedToday ?? null);
          return next;
        });
      }
      return p;
    });
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;
  useEffect(() => onAppResume(() => void recheckRef.current()), []);

  // iOS asks once; after "Don't Allow" every request answers denied with no prompt, so
  // the way on is Settings (the local AppSettings plugin).
  const deniedNative = permission === "denied" && canOpenAppSettings();
  // What the switch SHOWS: the reminder is on only if the OS will deliver it. The stored
  // `enabled` is the user's wish and survives a denied spell, so allowing notifications
  // again in Settings brings the switch back on by itself.
  const isOn = reminder.enabled && permission !== "denied";
  const toggle = async () => {
    if (isOn) {
      wantsOn.current = false;
      apply({ ...reminder, enabled: false });
      return;
    }
    if (deniedNative) {
      // The user may already have allowed it in Settings and come back unnoticed: ask
      // the OS again before sending them there. Granted now → just turn it on.
      wantsOn.current = true;
      const now = await recheck();
      if (now === "granted") {
        if (!reminder.enabled) apply({ ...reminder, enabled: true });
        return;
      }
      await openAppSettings();
      return;
    }
    const p = permission === "granted" ? "granted" : await requestReminderPermission();
    setPermission(p);
    if (p === "granted") apply({ ...reminder, enabled: true });
    else if (p === "denied" && canOpenAppSettings()) wantsOn.current = true;
  };
  const toSettings = () => {
    wantsOn.current = true;
    void openAppSettings();
  };
  const win = reminderWindow(reminder);

  const goalCard = (
    title: string,
    options: readonly number[],
    value: number,
    done: number | null,
    onPick: (n: number) => void,
    unit: (n: number) => string,
  ) => {
    const met = done !== null && done >= value;
    return (
      <section className="goals__card" aria-label={title}>
        <div className="goals__cardhead">
          <h3 className="goals__h3">{title}</h3>
          {done !== null && (
            <span className={`goals__today${met ? " goals__today--met" : ""}`}>
              {met ? t("goals.todayMet", { n: done, goal: value }) : t("goals.today", { n: done, goal: value })}
            </span>
          )}
        </div>
        <div className="goals__options" role="group" aria-label={t("goals.perDayAria")}>
          {options.map((n) => (
            <button
              key={n}
              type="button"
              className={`goals__opt${n === value ? " is-active" : ""}`}
              aria-pressed={n === value}
              onClick={() => onPick(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <ul className="goals__proj">
          {projections(value).map((p) => (
            <li key={p.key}>
              <span>{t(HORIZON_LABEL[p.key])}</span>
              <strong>{unit(p.total)}</strong>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <section className="goals">
      <BackLink />

      <div className="goals__streaks">
        <div className="goals__streak">
          <span className="goals__streaknum">
            <span aria-hidden="true">🔥</span> {streaks?.current ?? "–"}
          </span>
          <span className="goals__streaklabel">{t("goals.currentStreak")}</span>
        </div>
        <div className="goals__streak">
          <span className="goals__streaknum">{streaks?.longest ?? "–"}</span>
          <span className="goals__streaklabel">{t("goals.longestStreak")}</span>
        </div>
      </div>

      <h2 className="goals__h2">{t("goals.dailyGoal")}</h2>
      {error && <ErrorText message={error} />}

      {goalCard(
        t("goals.newWords"),
        NEW_WORDS_GOAL_OPTIONS,
        goals.newWords,
        today?.added ?? null,
        (n) => void update({ newWords: n }),
        (n) => `${n} ${plural(t, n, "goals.newWordOne", "goals.newWordMany")}`,
      )}
      {goalCard(
        t("goals.reviews"),
        REVIEWS_GOAL_OPTIONS,
        goals.reviews,
        today?.reviews ?? null,
        (n) => void update({ reviews: n }),
        (n) => `${n} ${plural(t, n, "goals.reviewOne", "goals.reviewMany")}`,
      )}

      <section className="goals__card" aria-labelledby="goals-rem">
        <div className="goals__remrow">
          <h3 id="goals-rem" className="goals__h3">{t("reminder.title")}</h3>
          {/* A binary switch. Off while iOS has notifications off, whatever is stored. */}
          <button
            type="button"
            role="switch"
            aria-checked={isOn}
            aria-labelledby="goals-rem"
            className={`switch${isOn ? " switch--on" : ""}`}
            onClick={toggle}
            disabled={support === "none"}
          >
            <span className="switch__knob" />
          </button>
        </div>

        {support === "none" && <p className="goals__note goals__note--warn">{t("reminder.unsupported")}</p>}
        {support !== "none" && permission === "denied" && (
          <div className="goals__deniedrow">
            <p className="goals__note goals__note--warn">
              {t(deniedNative ? "reminder.deniedNative" : "reminder.denied")}
            </p>
            {deniedNative && (
              <button type="button" className="btn" onClick={toSettings}>
                {t("reminder.openSettings")}
              </button>
            )}
          </div>
        )}

        <p className="goals__window">
          {win.from === win.to
            ? t("reminder.at", { time: formatMinutes(win.from, locale) })
            : t("reminder.between", { from: formatMinutes(win.from, locale), to: formatMinutes(win.to, locale) })}
        </p>
        {/* The same dual-thumb slider as the Lists confidence filter; the thumbs may
            cross and the window is read as min..max (reminderWindow). */}
        <div className="dualrange">
          <div className="dualrange__track" />
          <div
            className="dualrange__fill"
            style={{
              left: `${((win.from - MIN_MINUTES) / (MAX_MINUTES - MIN_MINUTES)) * 100}%`,
              right: `${((MAX_MINUTES - win.to) / (MAX_MINUTES - MIN_MINUTES)) * 100}%`,
            }}
          />
          <input
            type="range"
            className="dualrange__input"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={STEP_MINUTES}
            value={reminder.from}
            onChange={(e) => apply({ ...reminder, from: Number(e.target.value) }, { settle: true })}
            aria-label={t("reminder.fromAria")}
          />
          <input
            type="range"
            className="dualrange__input"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={STEP_MINUTES}
            value={reminder.to}
            onChange={(e) => apply({ ...reminder, to: Number(e.target.value) }, { settle: true })}
            aria-label={t("reminder.toAria")}
          />
        </div>
        <div className="goals__hours" aria-hidden="true">
          <span>{formatMinutes(MIN_MINUTES, locale)}</span>
          <span>{formatMinutes(12 * 60, locale)}</span>
          <span>{formatMinutes(MAX_MINUTES, locale)}</span>
        </div>
        {support === "web" && <p className="goals__note">{t("reminder.webOnlyOpen")}</p>}
      </section>
    </section>
  );
}
