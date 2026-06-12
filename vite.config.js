import { defineConfig } from 'vite';

// GitHub Pages serves the site from https://<user>.github.io/<repo>/,
// so the build needs a base path that matches the repo name.
// Override with BASE_PATH env var (e.g. "/" for a custom domain).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/nostr-brainmaker/',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
