import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../src/telemetry';

const KEY = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K_lMnOpQrStU-'; // 4 + 35 chars
const KEY2 = 'AIza' + 'Z'.repeat(35);

describe('scrubSecrets', () => {
  it('redacts Google API keys inside strings', () => {
    expect(scrubSecrets(`token ${KEY} end`)).toBe('token <redacted> end');
    expect(scrubSecrets(`${KEY}${KEY2}`)).toBe('<redacted><redacted>');
  });

  it('leaves unrelated values alone', () => {
    const input = { a: 1, b: true, c: null, d: undefined, e: 'AIza-too-short', f: [1, 'x'] };
    expect(scrubSecrets(input)).toEqual(input);
  });

  it('deep-copies without mutating the input', () => {
    const input = { nested: { list: [{ text: KEY }] } };
    const out = scrubSecrets(input);
    expect(out).toEqual({ nested: { list: [{ text: '<redacted>' }] } });
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
    expect(input.nested.list[0]?.text).toBe(KEY);
  });

  it('handles arrays at any depth', () => {
    expect(scrubSecrets([[KEY], [{ k: [KEY] }]])).toEqual([['<redacted>'], [{ k: ['<redacted>'] }]]);
  });

  it('redacts key= query parameters in URLs, whatever the key looks like', () => {
    expect(scrubSecrets('https://generativelanguage.googleapis.com/v1/models?key=abc123&alt=sse')).toBe(
      'https://generativelanguage.googleapis.com/v1/models?key=<redacted>&alt=sse',
    );
    expect(scrubSecrets('GET /x?a=1&api_key=zzz#frag')).toBe('GET /x?a=1&api_key=<redacted>#frag');
    expect(scrubSecrets('https://example.com/?monkey=banana')).toBe('https://example.com/?monkey=banana');
  });

  it('redacts values of apiKey / api_key / x-goog-api-key properties (case-insensitive)', () => {
    expect(
      scrubSecrets({ apiKey: 'abc', API_KEY: 'def', headers: { 'X-Goog-Api-Key': 'ghi', accept: 'json' }, key: 'p1' }),
    ).toEqual({ apiKey: '<redacted>', API_KEY: '<redacted>', headers: { 'X-Goog-Api-Key': '<redacted>', accept: 'json' }, key: 'p1' });
  });

  it('keeps the "no key" placeholders visible', () => {
    expect(scrubSecrets({ apiKey: '' })).toEqual({ apiKey: '' });
    expect(scrubSecrets({ apiKey: '<empty>' })).toEqual({ apiKey: '<empty>' });
  });

  it('replaces cycles with "[Circular]" and stays JSON-serializable', () => {
    const a: Record<string, unknown> = { name: 'a', secret: KEY };
    a.self = a;
    a.list = [a, { back: a }];
    const out = scrubSecrets(a);
    expect(out.self).toBe('[Circular]');
    expect(out.list).toEqual(['[Circular]', { back: '[Circular]' }]);
    expect(out.secret).toBe('<redacted>');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('copies shared (non-cyclic) references instead of marking them circular', () => {
    const shared = { v: 1 };
    expect(scrubSecrets({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  it('turns Errors into plain objects and scrubs their message', () => {
    const out = scrubSecrets({ err: new TypeError(`bad key ${KEY}`) }) as unknown as { err: Record<string, unknown> };
    expect(out.err.name).toBe('TypeError');
    expect(out.err.message).toBe('bad key <redacted>');
    expect(String(out.err.stack)).not.toContain(KEY);
  });

  it('replaces functions so the result can be stored in IndexedDB', () => {
    expect(scrubSecrets({ fn: () => 1 })).toEqual({ fn: '[Function]' });
  });
});
