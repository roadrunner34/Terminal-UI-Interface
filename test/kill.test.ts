// Ending an agent's whole process tree: taskkill /T on Windows, the process
// group elsewhere (SIGTERM, then SIGKILL for whatever ignores it).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupSpawnOptions, killTree } from '../src/main/kill'

const proc = (over: Record<string, unknown> = {}) => ({ pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(), ...over }) as any

describe('killTree', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses taskkill /T on Windows', () => {
    const taskkill = vi.fn()
    const kill = vi.fn()
    killTree(proc(), { platform: 'win32', taskkill, kill })
    expect(taskkill).toHaveBeenCalledWith(4242)
    expect(kill).not.toHaveBeenCalled()
  })

  it('signals the whole process group elsewhere, then SIGKILLs what is left', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const p = proc()
    killTree(p, { platform: 'linux', kill, graceMs: 3000 })
    expect(kill.mock.calls).toEqual([[-4242, 'SIGTERM']])
    vi.advanceTimersByTime(2999)
    expect(kill).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(kill.mock.calls[1]).toEqual([-4242, 'SIGKILL'])
    expect(p.kill).not.toHaveBeenCalled()
  })

  it('ignores a group that has already gone by the time SIGKILL is due', () => {
    vi.useFakeTimers()
    const kill = vi.fn((_pid: number, signal: string) => {
      if (signal === 'SIGKILL') throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    killTree(proc(), { platform: 'darwin', kill, graceMs: 10 })
    expect(() => vi.advanceTimersByTime(10)).not.toThrow()
  })

  it('falls back to the child alone when it does not lead a group', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const p = proc()
    killTree(p, { platform: 'linux', kill })
    expect(p.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('leaves a process that has already exited alone', () => {
    const taskkill = vi.fn()
    const kill = vi.fn()
    killTree(proc({ exitCode: 0 }), { platform: 'win32', taskkill })
    killTree(proc({ signalCode: 'SIGTERM' }), { platform: 'linux', kill })
    killTree(proc({ pid: undefined }), { platform: 'linux', kill })
    expect(taskkill).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('makes children lead their own group only off Windows', () => {
    expect(groupSpawnOptions('win32')).toEqual({})
    expect(groupSpawnOptions('linux')).toEqual({ detached: true })
    expect(groupSpawnOptions('darwin')).toEqual({ detached: true })
  })
})
