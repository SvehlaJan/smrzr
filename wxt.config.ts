import { defineConfig } from 'wxt';

// See docs/DESIGN.md §3 (architecture) and §8 (observability).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'smrzr',
    description: 'Structured AI summaries of YouTube videos, with details and fact-checking chat.',
    permissions: ['sidePanel', 'storage', 'unlimitedStorage', 'tabs'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://generativelanguage.googleapis.com/*',
      'https://*.ingest.de.sentry.io/*',
    ],
    action: { default_title: 'Open smrzr' },
  },
  // Unminified on purpose: readable Sentry stack traces without a source-map upload pipeline.
  vite: () => ({
    build: { minify: false, sourcemap: true },
  }),
});
