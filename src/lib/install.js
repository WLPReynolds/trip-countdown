// iPhone install guide, following the finance app's approach.
// iOS has no install prompt, so people need telling to use Share, then Add to
// Home Screen. It matters here because the Home Screen app keeps its own
// storage, separate from Safari: a setup key pasted in Safari isn't seen by
// the installed app. So the banner asks for this before the key goes in.

/** 'not-ios' | 'installed' | 'needs-install' */
export function iosInstallState(env = {}) {
  const ua = env.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/i.test(ua)
    // iPadOS asks for the desktop site and reports itself as a Mac; a touch screen gives it away.
    || (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) > 1);
  if (!ios) return 'not-ios';
  if (env.standalone === true || env.displayModeStandalone === true) return 'installed';
  return 'needs-install';
}

/** Days the banner stays hidden after "Not now". */
export const HINT_SNOOZE_DAYS = 7;

/** True if the banner should show, given when (ms) it was last dismissed. */
export function hintBannerDue(dismissedAt, now = Date.now()) {
  const t = Number(dismissedAt);
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t >= HINT_SNOOZE_DAYS * 86400000;
}
