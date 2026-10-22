// Shared data model. See docs/DESIGN.md §4, §5 and §7.
// Everything here must stay JSON-serializable: it travels over extension messaging
// and is stored in IndexedDB.

// ---------- Video & transcript ----------

export interface Chapter {
  title: string;
  startSec: number;
}

export interface CaptionTrackInfo {
  /** Caption URL as found in the player response (may need a PO token to work). */
  baseUrl: string;
  /** BCP-47-ish code from YouTube, e.g. "en", "en-US", "cs". */
  languageCode: string;
  /** "asr" = auto-generated captions. */
  kind: 'manual' | 'asr';
  /** Human-readable track name, e.g. "English (auto-generated)". */
  name: string;
}

export interface VideoMeta {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  /** Creator chapters, parsed from the player/page data. Empty when none. */
  chapters: Chapter[];
  /** Live streams and Premieres in progress have no final transcript. */
  isLive: boolean;
  captionTracks: CaptionTrackInfo[];
}

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  /** Duration in seconds. */
  dur: number;
  text: string;
}

export type TranscriptStrategy = 'player' | 'panel' | 'dom' | 'gemini';

export interface Transcript {
  videoId: string;
  language: string;
  kind: 'manual' | 'asr';
  source: TranscriptStrategy;
  segments: TranscriptSegment[];
}

export type TranscriptOutcome =
  | 'ok'
  | 'empty_200' // HTTP 200 with an empty body: YouTube's PO-token refusal
  | 'http_error'
  | 'no_tracks'
  | 'no_english_track'
  | 'timeout'
  | 'parse_error'
  | 'error';

/** One step of the transcript fallback chain; logged as `transcript.attempt`. */
export interface TranscriptAttempt {
  strategy: TranscriptStrategy;
  outcome: TranscriptOutcome;
  ms: number;
  /** Short diagnostic, e.g. "HTTP 403" or "no ytd-transcript-segment-renderer after 5s". Never contains page content. */
  detail?: string;
  segmentCount?: number;
}

// ---------- LLM results ----------

export type LlmTask = 'summary' | 'details' | 'visuals' | 'chat';

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** null when the model is not in the price table. */
  estCostUsd: number | null;
}

export interface KeyPoint {
  id: string; // "p1".."p7"
  title: string;
  gist: string;
  /** null when the model's timestamp could not be validated (design §5.2). */
  startSec: number | null;
  endSec: number | null;
}

export interface Summary {
  tldr: string;
  points: KeyPoint[];
}

export interface SubPoint {
  text: string;
  startSec: number | null;
}

export interface PointDetails {
  subpoints: SubPoint[];
  /** Background knowledge NOT from the video. Rendered visually distinct. Markdown-free plain text. */
  context: string;
  /** Result of "Look at the visuals" for this point, if requested. */
  visuals?: string;
}

export interface Citation {
  /** 1-based, matches [n] markers in the answer text. */
  index: number;
  title: string;
  uri: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  /** The key point that was the chat focus when this message was sent. */
  focusPointId: string | null;
  citations: Citation[];
  /** Google Search "search suggestions" HTML that must be shown under grounded answers. */
  searchEntryPointHtml?: string;
  createdAt: number;
  usage?: LlmUsage;
}

// ---------- Persistence ----------

export interface VideoRecord {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  transcript: Transcript;
  summary?: Summary;
  details: Record<string, PointDetails>;
  chat: ChatMessage[];
  /** Bumped when prompts change; older summaries are regenerated on demand. */
  promptVersion: number;
  /** Sum of estCostUsd of all LLM calls for this video. */
  totalCostUsd: number;
  createdAt: number;
  lastOpenedAt: number;
}

export interface Settings {
  apiKey: string;
  /** Model id per task, e.g. { summary: "gemini-3-flash", chat: "gemini-3.1-pro" }. Empty string = not chosen yet. */
  models: Record<LlmTask, string>;
  sentryEnabled: boolean;
}

// ---------- Telemetry ----------

export type Component = 'panel' | 'content' | 'main' | 'background';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  /** Auto-increment key in IndexedDB. */
  id?: number;
  ts: number;
  component: Component;
  level: LogLevel;
  /** Dotted event name from design §8.2, e.g. "transcript.attempt". */
  name: string;
  videoId?: string;
  /** Small, metadata-only payload. Never transcripts, prompts or API keys. */
  data?: Record<string, unknown>;
}
