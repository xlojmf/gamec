import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameServerHost, roomsApiBase } from './session'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function browser(protocol: string, search = '') {
  vi.stubGlobal('window', { location: { hostname: 'catan.example.com', protocol, search } })
  vi.stubEnv('VITE_GAME_SERVER_URL', '')
  vi.stubEnv('VITE_GAME_SERVER_PORT', '8011')
}

describe('multiplayer endpoints behind HTTPS', () => {
  it('retains the configured local port over HTTP', () => {
    browser('http:')
    expect(roomsApiBase()).toBe('http://catan.example.com:8011')
  })
  it('uses the public HTTPS origin for both lobby and socket connections', () => {
    browser('https:')
    vi.stubEnv('VITE_GAME_SERVER_URL', 'https://game.example.com/')
    expect(gameServerHost()).toBe('https://game.example.com')
    expect(roomsApiBase()).toBe(gameServerHost())
  })
  it('inherits HTTPS for legacy host-only overrides', () => {
    browser('https:', '?server=other.example.com')
    expect(roomsApiBase()).toBe('https://other.example.com')
  })
  it('accepts a full URL override without doubling its scheme', () => {
    browser('https:', '?server=https%3A%2F%2Fother.example.com')
    vi.stubEnv('VITE_GAME_SERVER_URL', 'https://game.example.com')
    expect(roomsApiBase()).toBe('https://other.example.com')
  })
})
