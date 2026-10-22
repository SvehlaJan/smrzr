// URL helpers for YouTube tabs. The panel parses the tab URL itself so it can react
// before the content script reports (or when it isn't injected at all).

/** YouTube video ids are 11 chars of [A-Za-z0-9_-]. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Only the desktop site: our content scripts match `https://www.youtube.com/*` only, so on
 * m.youtube.com / music.youtube.com nothing would answer the panel. (Bare youtube.com
 * redirects to www.)
 */
const SUPPORTED_HOSTS = new Set(['www.youtube.com', 'youtube.com']);

export function isYouTubeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return SUPPORTED_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Returns the video id for `youtube.com/watch?v=…` URLs, otherwise null. */
export function parseVideoId(url: string | null | undefined): string | null {
  if (!url || !isYouTubeUrl(url)) return null;
  try {
    const u = new URL(url);
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    return v && VIDEO_ID.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
