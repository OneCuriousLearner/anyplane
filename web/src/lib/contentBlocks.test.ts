import { describe, expect, test } from 'bun:test'
import { cliContentToHistoryBlocks as webMap } from './contentBlocks'
import { cliContentToHistoryBlocks as serverMap } from '../../../server/src/backends/claude/contentBlocks'
import { LOCKSTEP_CASES } from './contentBlocks.lockstep'

describe('cliContentToHistoryBlocks 同形夹具（web ↔ server）', () => {
  for (const c of LOCKSTEP_CASES) {
    test(c.name, () => {
      const opts = { onImage: c.onImage }
      const web = webMap(c.content, opts)
      const server = serverMap(c.content, opts)
      expect(web).toEqual(c.expected)
      expect(server).toEqual(c.expected)
      expect(web).toEqual(server)
    })
  }
})
