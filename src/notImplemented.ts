// Temporary helper for contract stubs during parallel development. Must have no callers when done.
export function notImplemented(what: string): never {
  throw new Error(`Not implemented: ${what}`);
}
