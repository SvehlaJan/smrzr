# smrzr

AI summarizer for YouTube videos, as a Chrome side panel. For each video it gives:
- up to 7 key points with timestamps,
- expandable details per point,
- a fact-checking chat grounded in both the video and the web.

It uses Gemini with your own API key. The design and the reasoning behind it are in [docs/DESIGN.md](docs/DESIGN.md).

## Setup

Requirements: Node 22+, Chrome 116+.

```bash
npm install
# optional: WXT_SENTRY_DSN=... in .env.local, WXT_GEMINI_API_KEY=... in .env.development.local (see .env.example)
npm run dev                  # builds to .output/chrome-mv3-dev and watches for changes
```

Load the extension in Chrome:
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `.output/chrome-mv3-dev` (or `.output/chrome-mv3` after `npm run build`).
3. Pin smrzr, open a YouTube video, and click the toolbar icon. The side panel opens.
4. Open **⚙ Settings**, paste your Gemini API key, click **Load models**, and save. In a dev build, `WXT_GEMINI_API_KEY` from `.env.development.local` is used automatically when the field is empty.

Tabs that were already open before you installed or reloaded the extension need a page reload. Chrome only injects content scripts into pages loaded after that.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev build with hot reload |
| `npm run build` | Production build into `.output/chrome-mv3` (unminified on purpose, for readable stack traces) |
| `npm run compile` | Type check |
| `npm test` | Unit tests (Vitest) |

## Reporting problems

Click **⚑** in the panel and describe what went wrong in one sentence:
- **Send to Sentry** sends the description with a full debug bundle attached: transcript, prompts, raw model responses and the event log. Your API key is stripped.
- **Copy debug bundle** puts the same JSON on your clipboard, so you can paste it anywhere.

## Layout

```
entrypoints/
  background.ts             side panel wiring, log sink for the YouTube tab
  youtube.content.ts        runs in the YouTube tab (isolated world): messaging, seek, navigation
  youtube-main.content.ts   runs in YouTube's page context: player data, transcript fetch
  sidepanel/                React UI
src/
  transcript/               transcript fallback chain (the part YouTube breaks most often)
  llm/                      Gemini REST client, model picking, pricing
  pipeline/                 prompts, summary, details, visuals, chat
  storage/                  IndexedDB history + settings
  telemetry/                event log, Sentry, debug bundles
  types.ts, messaging.ts    shared contracts
```
