// Minimal Server-Sent Events reader for Gemini's `streamGenerateContent?alt=sse`.
//
// The response body is a byte stream like:
//   data: {"candidates":[...]}\r\n
//   \r\n
//   data: {"candidates":[...]}\r\n
//   \r\n
// Network chunks can end anywhere — in the middle of a line, or even in the middle of a multi-byte
// UTF-8 character — so we decode with `stream: true` and only process complete lines.

/**
 * Yields the `data` payload of each SSE event (multiple `data:` lines of one event are joined with
 * "\n", per the SSE spec). Comment lines (":") and other fields (event:, id:, retry:) are ignored.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];

  /** Handles one complete line. Returns a payload when the line ends an event. */
  const handleLine = (rawLine: string): string | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      // Blank line = end of event.
      if (dataLines.length === 0) return null;
      const payload = dataLines.join('\n');
      dataLines = [];
      return payload;
    }
    if (line.startsWith('data:')) {
      // "data: x" and "data:x" are both valid; one leading space is stripped.
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let newlineAt: number;
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        const payload = handleLine(line);
        if (payload !== null) yield payload;
      }

      if (done) {
        // Stream ended without a trailing blank line: flush what we have.
        if (buffer !== '') handleLine(buffer);
        const payload = handleLine('');
        if (payload !== null) yield payload;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
