import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { discoverRepositories } from '../src/discovery.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('repository discovery', () => {
  test('reports verified paths relative to the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-discovery-')); roots.push(root)
    const repo = join(root, 'team', 'service'); mkdirSync(repo, { recursive: true })
    spawnSync('git', ['init', '-b', 'main', repo])
    expect(discoverRepositories(root)).toEqual([{ path: 'team/service', name: 'service', defaultBranch: 'main' }])
  })
})
