// Tracks which tab is active in the panel's window and which YouTube video it shows.
//
// A Chrome side panel belongs to a browser window and stays open while you switch tabs,
// so "the current video" changes under us. Sources of truth, in order of arrival:
//   1. tabs.query on startup and whenever the active tab changes (tabs.onActivated)
//   2. tabs.onUpdated when the active tab's URL changes (YouTube navigates without page loads)
//   3. `videoChanged` messages from our content script (authoritative, sent after YouTube's
//      own 'yt-navigate-finish' event)
// We parse the URL ourselves too, so the panel works before (or without) the content script.

import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { isTabToExtension } from '@/src/messaging';
import { parseVideoId } from '../youtube';

export interface ActiveVideo {
  tabId: number | null;
  /** URL of the active tab (needs the "tabs" permission). */
  url: string | null;
  videoId: string | null;
}

const NONE: ActiveVideo = { tabId: null, url: null, videoId: null };

export function useActiveVideo(): ActiveVideo {
  const [active, setActive] = useState<ActiveVideo>(NONE);
  // Listeners are registered once; they read the current tab id from this ref instead of
  // from a stale closure.
  const tabIdRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const applyTab = (tabId: number | null, url: string | null) => {
      tabIdRef.current = tabId;
      const videoId = parseVideoId(url);
      setActive((prev) =>
        prev.tabId === tabId && prev.url === url && prev.videoId === videoId ? prev : { tabId, url, videoId },
      );
    };

    // `currentWindow` from a side panel page means the window the panel is docked in.
    const refresh = async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!disposed) applyTab(tab?.id ?? null, tab?.url ?? null);
      } catch (err) {
        console.warn('[smrzr] tabs.query failed', err);
      }
    };

    const onActivated = () => void refresh();

    const onUpdated = (tabId: number, changeInfo: { url?: string }) => {
      if (tabId === tabIdRef.current && changeInfo.url !== undefined) applyTab(tabId, changeInfo.url);
    };

    // Note: this listener returns nothing (undefined), which tells Chrome we won't send a
    // response, so it doesn't interfere with other listeners that do respond.
    const onMessage = (msg: unknown, sender: { tab?: { id?: number } }) => {
      if (!isTabToExtension(msg) || msg.type !== 'videoChanged') return;
      if (sender.tab?.id === undefined || sender.tab.id !== tabIdRef.current) return;
      setActive((prev) => (prev.videoId === msg.videoId ? prev : { ...prev, videoId: msg.videoId }));
    };

    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.runtime.onMessage.addListener(onMessage);
    void refresh();

    return () => {
      disposed = true;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return active;
}
