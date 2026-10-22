// Root of the side panel: settings + telemetry, active-tab tracking, the video session,
// and a tiny "router" between the Video / History / Settings views.

import { useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import { ErrorCard } from './components/ErrorCard';
import { Header, type View } from './components/Header';
import { PanelProvider } from './components/PanelContext';
import { ReportDialog } from './components/ReportDialog';
import { describeError, handleError } from './errors';
import { useActiveVideo } from './hooks/useActiveVideo';
import { useSettings, useTelemetry } from './hooks/useSettings';
import { useVideoSession } from './hooks/useVideoSession';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { VideoView } from './views/VideoView';
import { isYouTubeUrl, watchUrl } from './youtube';

export function App() {
  const { settings, error: settingsError, setSettings } = useSettings();
  useTelemetry(settings?.sentryEnabled);
  const active = useActiveVideo();
  const session = useVideoSession(active.tabId, active.videoId, settings);

  const [view, setView] = useState<View>('video');
  const [reportOpen, setReportOpen] = useState(false);
  const openReport = useCallback(() => setReportOpen(true), []);
  const closeReport = useCallback(() => setReportOpen(false), []);
  // Header buttons toggle: pressing 🕘 while in History goes back to the video.
  const toggleView = (v: View) => setView((cur) => (cur === v ? 'video' : v));

  /** History click: reuse the active YouTube tab, otherwise open a new tab. */
  const openVideo = async (videoId: string) => {
    setView('video');
    if (videoId === active.videoId) return;
    const url = watchUrl(videoId);
    try {
      if (active.tabId !== null && isYouTubeUrl(active.url)) await browser.tabs.update(active.tabId, { url });
      else await browser.tabs.create({ url });
    } catch (err) {
      handleError(err, { videoId, task: 'open_video' });
    }
  };

  const record = session.record;
  const meta = session.meta;
  const hasVideo = session.status.kind !== 'idle';

  let body;
  if (!settings) {
    body = settingsError ? (
      <ErrorCard message={describeError(settingsError)?.message ?? "Couldn't load settings."} />
    ) : (
      <p className="muted progress pad">Loading…</p>
    );
  } else if (view === 'settings') {
    body = <SettingsView settings={settings} onSaved={setSettings} />;
  } else if (view === 'history') {
    body = <HistoryView currentVideoId={active.videoId} onOpen={(id) => void openVideo(id)} />;
  } else {
    body = (
      <VideoView
        session={session}
        settings={settings}
        onOpenSettings={() => setView('settings')}
        onOpenHistory={() => setView('history')}
      />
    );
  }

  return (
    <PanelProvider tabId={active.tabId} videoId={active.videoId} onOpenReport={openReport}>
      <div className="app">
        <Header
          view={view}
          title={hasVideo ? (meta?.title ?? record?.title ?? null) : null}
          durationSec={hasVideo ? (meta?.durationSec ?? record?.durationSec ?? null) : null}
          costUsd={hasVideo && record ? record.totalCostUsd : null}
          onBack={() => setView('video')}
          onReport={openReport}
          onHistory={() => toggleView('history')}
          onSettings={() => toggleView('settings')}
        />
        <main className="content">{body}</main>
      </div>
      {reportOpen && <ReportDialog videoId={active.videoId} onClose={closeReport} />}
    </PanelProvider>
  );
}
