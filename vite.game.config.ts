import { defineConfig } from 'vite'

/**
 * Build for the boardgame.io game server (src/server/gameServer.ts → dist/game).
 *
 * Runs AFTER the web build; `emptyOutDir: false` keeps dist/client + dist/server
 * intact. boardgame.io is bundled in (no exports map → Node ESM can't resolve
 * its bare subpaths at runtime), same as the web SSR build.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['boardgame.io'],
    // boardgame.io's optional FlatFile adapter require()s node-persist lazily
    // (only when FLATFILE_DIR is set — we use the default in-memory DB).
    external: ['node-persist'],
  },
  build: {
    ssr: 'src/server/gameServer.ts',
    outDir: 'dist/game',
    emptyOutDir: false,
    rollupOptions: { external: ['node-persist'] },
  },
})
