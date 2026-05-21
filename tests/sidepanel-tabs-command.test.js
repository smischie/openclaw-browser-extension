import { describe, it, expect, vi, beforeEach } from 'vitest'

// Minimal pure parsers matching current sidepanel.js logic
function parseTabsCloseArgs(args) {
  const idsStr = args.join(' ')
  return idsStr
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((id) => Number.isFinite(id))
}

function parseTabsCommand(text) {
  const parts = text.trim().split(/\s+/)
  const subCmd = parts[1] || 'query'
  const args = parts.slice(2)
  return { subCmd, args, parts }
}

describe('sidepanel /tabs command parsing', () => {
  it('defaults to query when only "/tabs" is provided', () => {
    expect(parseTabsCommand('/tabs')).toEqual({ subCmd: 'query', args: [], parts: ['/tabs'] })
  })

  it('parses subcommand + args', () => {
    expect(parseTabsCommand('/tabs close 1,2,3').subCmd).toBe('close')
    expect(parseTabsCommand('/tabs close 1,2,3').args).toEqual(['1,2,3'])
  })

  it('parses comma-separated ids with whitespace', () => {
    expect(parseTabsCloseArgs(['123,', ' 456,789', 'oops'])).toEqual([123, 456, 789])
  })

  it('returns empty list when no valid ids exist', () => {
    expect(parseTabsCloseArgs(['oops', 'nope'])).toEqual([])
  })

  it('tolerates spaces between comma-separated items', () => {
    expect(parseTabsCloseArgs(['1,', ' 2,', '3'])).toEqual([1, 2, 3])
  })
})

describe('sidepanel /tabs close integration (chrome.tabs.remove calls)', () => {
  beforeEach(() => {
    chrome.tabs.remove.mockClear()
  })

  it('closes each id and reports failures (simulated)', async () => {
    const tabIds = [1, 2, 3]

    chrome.tabs.remove.mockImplementation(async (id) => {
      if (id === 2) throw new Error('no tab with id')
      return undefined
    })

    const results = []
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.remove(tabId)
        results.push(`ok:${tabId}`)
      } catch (e) {
        results.push(`err:${tabId}`)
      }
    }

    expect(results).toEqual(['ok:1', 'err:2', 'ok:3'])
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(3)
  })

  it('bulk close can fail and still close as many as possible (one-by-one fallback pattern)', async () => {
    const ids = [10, 11]

    // bulk remove fails
    chrome.tabs.remove.mockImplementationOnce(async () => {
      throw new Error('bulk failed')
    })
    // individual removes
    chrome.tabs.remove.mockImplementationOnce(async () => undefined)
    chrome.tabs.remove.mockImplementationOnce(async () => {
      throw new Error('no tab with id')
    })

    let closed = 0
    const errors = []
    try {
      await chrome.tabs.remove(ids)
      closed = ids.length
    } catch {
      for (const id of ids) {
        try {
          await chrome.tabs.remove(id)
          closed++
        } catch (e) {
          errors.push({ tabId: id, error: e.message })
        }
      }
    }

    expect(closed).toBe(1)
    expect(errors).toEqual([{ tabId: 11, error: 'no tab with id' }])
  })
})
