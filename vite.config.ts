import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // boardgame.io 0.50 predates package "exports" maps — its bare subpath
  // imports ('boardgame.io/client', 'boardgame.io/core') can't be resolved
  // by Node ESM at runtime, so bundle it into the SSR build instead of
  // externalizing it.
  ssr: { noExternal: ['boardgame.io'] },
  plugins: [tanstackStart(), viteReact()],
})

export default config
