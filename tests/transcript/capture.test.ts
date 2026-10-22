import { describe, expect, it, vi } from 'vitest';
import { installTimedtextCapture, type CaptureWindow } from '../../src/transcript/capture';

function fakeWindow() {
  const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response('ok'));
  const openSpy = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return 'open-result';
  });
  class FakeXhr {}
  (FakeXhr.prototype as unknown as { open: unknown }).open = openSpy;
  const win = {
    fetch: fetchSpy as unknown as typeof fetch,
    XMLHttpRequest: FakeXhr as unknown as CaptureWindow['XMLHttpRequest'],
    location: { href: 'https://www.youtube.com/watch?v=vid1' },
  };
  return { win, fetchSpy, openSpy, FakeXhr };
}

const TT = 'https://www.youtube.com/api/timedtext?v=vid1&lang=en&fmt=srv3';

describe('installTimedtextCapture', () => {
  it('captures fetch URLs (string, URL, Request-like) and passes calls through unchanged', async () => {
    const { win, fetchSpy } = fakeWindow();
    const cap = installTimedtextCapture(win);
    const init = { method: 'GET' };
    const res = await win.fetch(`${TT}&pot=P1`, init);
    expect(await res.text()).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledWith(`${TT}&pot=P1`, init);
    expect(cap.latest('vid1')).toMatchObject({ videoId: 'vid1', hasPot: true });

    await win.fetch(new URL('https://www.youtube.com/api/timedtext?v=vid2&pot=P2'));
    expect(cap.latest('vid2')?.hasPot).toBe(true);
    await win.fetch({ url: '/api/timedtext?v=vid3' } as unknown as Request);
    expect(cap.latest('vid3')?.url).toBe('https://www.youtube.com/api/timedtext?v=vid3');
    await win.fetch('https://www.youtube.com/youtubei/v1/player');
    expect(cap.latest('vid1')?.url).toContain('pot=P1');
  });

  it('captures XHR open() and keeps `this` and the return value', () => {
    const { win, openSpy, FakeXhr } = fakeWindow();
    const cap = installTimedtextCapture(win);
    const xhr = new FakeXhr() as unknown as { open: (...a: unknown[]) => unknown };
    expect(xhr.open('GET', `${TT}&pot=X`, true)).toBe('open-result');
    expect(openSpy).toHaveBeenCalledWith('GET', `${TT}&pot=X`, true);
    expect(openSpy.mock.contexts[0]).toBe(xhr);
    expect(cap.latest('vid1')?.hasPot).toBe(true);
  });

  it('does not replace a token-carrying URL with a token-less one', async () => {
    const { win } = fakeWindow();
    const cap = installTimedtextCapture(win);
    await win.fetch(`${TT}&pot=GOOD`);
    await win.fetch(TT);
    expect(cap.latest('vid1')?.url).toContain('pot=GOOD');
  });

  it('never throws from our side, even for weird inputs', async () => {
    const { win, fetchSpy } = fakeWindow();
    installTimedtextCapture(win);
    await expect(win.fetch(undefined as unknown as string)).resolves.toBeDefined();
    await expect(win.fetch('http://[bad')).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('waitForNext resolves on the next capture for that video, or undefined on timeout', async () => {
    const { win } = fakeWindow();
    const cap = installTimedtextCapture(win);
    const next = cap.waitForNext('vid1', 1000);
    const other = cap.waitForNext('zzz', 20);
    await win.fetch(`${TT}&pot=NEW`);
    await expect(next).resolves.toMatchObject({ hasPot: true });
    await expect(other).resolves.toBeUndefined();
  });

  it('originalFetch bypasses capture; uninstall restores', async () => {
    const { win, fetchSpy, openSpy, FakeXhr } = fakeWindow();
    const cap = installTimedtextCapture(win);
    await cap.originalFetch(`${TT}&pot=OWN`);
    expect(cap.latest('vid1')).toBeUndefined();
    cap.uninstall();
    expect(win.fetch).toBe(fetchSpy);
    expect((FakeXhr.prototype as unknown as { open: unknown }).open).toBe(openSpy);
  });
});
