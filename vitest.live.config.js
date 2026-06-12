import { defineConfig } from 'vite';

// Dedicated config for the live relay integration test. It is intentionally
// kept out of the default `npm test` run (which only matches *.test.js) so the
// unit suite stays fast and offline. Run with `npm run test:live`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.live.js'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
