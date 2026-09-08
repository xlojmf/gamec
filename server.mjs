/**
 * Minimal production server for the TanStack Start build.
 *
 * The vite build (latest TanStack Start) emits a Web-standard fetch handler in
 * `dist/server/server.js` instead of a standalone listener, so we bridge it to
 * node:http and serve `dist/client` assets statically. Zero extra dependencies.
 *
 *   node server.mjs            # listens on :3000
 *   PORT=8080 node server.mjs
 */

import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import handler from './dist/server/server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.join(here, 'dist', 'client')
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

function tryStaticFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/[/\\]+/g, '/')
  const filePath = path.join(clientDir, path.normalize(clean).replace(/^([.][.][/\\])+/, ''))
  if (!filePath.startsWith(clientDir)) return null
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null
  return filePath
}

const server = http.createServer(async (req, res) => {
  try {
    // 1) static assets from the client build
    const filePath = tryStaticFile(req.url ?? '/')
    if (filePath) {
      res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream')
      res.setHeader('Cache-Control', path.basename(filePath).includes('.') && filePath.includes(path.join('assets', '')) ? 'public, max-age=31536000, immutable' : 'no-cache')
      createReadStream(filePath).pipe(res)
      return
    }

    // 2) everything else → SSR fetch handler
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? '/'}`
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(key, v)
      else if (value != null) headers.set(key, value)
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
    })
    const response = await handler.fetch(request)

    res.writeHead(response.status, [...response.headers])
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
      } catch {
        // client disconnected mid-stream — fine
      }
    }
    res.end()
  } catch (err) {
    console.error('[server] error handling', req.url, err)
    if (!res.headersSent) res.writeHead(500)
    res.end('Internal Server Error')
  }
})

server.listen(port, host, () => {
  console.log(`▲ Catan 3D listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
})
