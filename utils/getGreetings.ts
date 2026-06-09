/**
 * Returns the i18n key for the time-of-day greeting (e.g. "greeting.morning").
 * The caller resolves it through `t()` so the greeting follows the active UI
 * language instead of being hard-coded English.
 */
export const getGreetingKey = () => {
  const time = new Date().getHours();

  if (time >= 5 && time < 12) return "greeting.morning";
  if (time >= 12 && time < 18) return "greeting.afternoon";
  if (time >= 18 && time < 22) return "greeting.evening";
  return "greeting.night";
};
