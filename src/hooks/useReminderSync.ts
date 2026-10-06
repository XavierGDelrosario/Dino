// Keep the device's scheduled reminders in step with reality: on launch and whenever
// today's activity flips (the first save or grade of the day cancels today's nag), the
// next week of moments is re-scheduled from the saved settings. Inert when reminders
// are off, unsupported, or not permitted — syncReminders checks all three.
import { useEffect } from "react";
import { useI18n } from "../i18n";
import { loadReminderSettings, syncReminders } from "../services/reminders";

export function useReminderSync(studiedToday: boolean | null) {
  const { t } = useI18n();
  useEffect(() => {
    if (studiedToday === null) return; // the streak hasn't answered yet
    const settings = loadReminderSettings();
    if (!settings.enabled) return;
    void syncReminders(settings, { title: t("reminder.notifTitle"), body: t("reminder.notifBody") }, studiedToday);
  }, [studiedToday, t]);
}
