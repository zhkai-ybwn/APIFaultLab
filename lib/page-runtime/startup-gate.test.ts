import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStartupGate, readStartupMarker, STARTUP_KEY, writeStartupMarker } from './startup-gate'

afterEach(() => vi.useRealTimers())

describe('首屏规则保护', () => {
  it('keeps simultaneous callers waiting for the matching session', async () => {
    const gate = createStartupGate('same-session')
    const first = gate.wait()
    expect(gate.wait()).toBe(first)
    expect(gate.holdsRequests).toBe(true)

    expect(gate.confirm('same-session', false)).toBe(true)
    await expect(first).resolves.toBe(true)
    expect(gate.state).toBe('protected')
    expect(gate.holdsRequests).toBe(false)
  })

  it('blocks stale callers and allows new work after an explicit replacement', async () => {
    const gate = createStartupGate('missing-session')
    const first = gate.wait()
    expect(gate.confirm('new-session', false)).toBe(false)
    await expect(first).resolves.toBe(false)
    await expect(gate.wait()).resolves.toBe(false)
    expect(gate.confirm('new-session', true)).toBe(true)
    await expect(gate.wait()).resolves.toBe(true)
  })

  it('fails closed when the background does not respond before the deadline', async () => {
    vi.useFakeTimers()
    const gate = createStartupGate('old-session')
    const request = gate.wait()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(request).resolves.toBe(false)
    expect(gate.state).toBe('blocked')
    gate.confirm('old-session', false)
    await expect(gate.wait()).resolves.toBe(true)
  })

  it('stores only a session marker and tolerates blocked site storage', () => {
    const rows = new Map<string, string>()
    const page = { sessionStorage: {
      setItem: (key: string, value: string) => rows.set(key, value),
      getItem: (key: string) => rows.get(key) ?? null,
      removeItem: (key: string) => rows.delete(key),
    } }
    expect(writeStartupMarker(page, 'same-session')).toBe(true)
    expect([...rows]).toEqual([[STARTUP_KEY, 'same-session']])
    expect(readStartupMarker(page)).toBe('same-session')
    expect(writeStartupMarker(page)).toBe(true)
    expect(readStartupMarker(page)).toBeUndefined()
    const disabled = { get sessionStorage(): Storage { throw new Error('Web Storage is blocked') } }
    expect(readStartupMarker(disabled)).toBeUndefined()
    expect(writeStartupMarker(disabled, 'same-session')).toBe(false)
  })
})
