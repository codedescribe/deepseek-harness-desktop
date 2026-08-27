import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Regression for the desktop-vendored `dsh-subprocess-local` patch:
 * Electron asar layout resolves some packaged binaries (e.g. @vscode/ripgrep)
 * to VIRTUAL paths inside `resources/app.asar`. Electron's fs patch makes
 * existsSync() answer true for those paths, but child_process.spawn never
 * unpacks them, so glob/grep failed with
 * "could not start its search command (ripgrep launch failed)" (ENOENT).
 * The patch remaps an argv[0] containing the `app.asar` segment to its
 * physical `app.asar.unpacked` counterpart when that file exists.
 */

let root: string
let asarVirtualBin: string
let missingBin: string

function testRuntime(): LocalSubprocessRuntime {
  // Minimal Cordis context stub: the runtime only reflects service
  // registration and registers a host-exit teardown effect.
  const ctx = {
    reflect: { provide: () => void 0 },
    effect: (fn: () => () => void) => {
      fn()
      return () => void 0
    },
  }
  return new LocalSubprocessRuntime(ctx as unknown as Context)
}

function spawnSpec(argv: readonly string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: root,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1_000_000 },
      stderr: { maxBytes: 1_000_000 },
    },
    graceMs: 10_000,
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-asar-remap-'))
  const unpackedBin = join(root, 'fake-app', 'app.asar.unpacked', 'node_modules', 'fake-rg', 'rg.exe')
  mkdirSync(join(unpackedBin, '..'), { recursive: true })
  copyFileSync(process.execPath, unpackedBin)
  // The `app.asar` sibling is intentionally never created: the real archive
  // is a file, not a directory, so a virtual path inside it cannot be
  // spawned without the remap.
  asarVirtualBin = unpackedBin.replace('app.asar.unpacked', 'app.asar')
  missingBin = join(root, 'fake-app', 'app.asar', 'node_modules', 'missing-bin', 'tool.exe')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('dsh-subprocess-local asar unpacked remap (desktop vendored patch)', () => {
  it('spawns an argv[0] resolved inside app.asar via its app.asar.unpacked counterpart', async () => {
    const runtime = testRuntime()
    const handle = runtime.spawn(spawnSpec([asarVirtualBin, '--version']))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('keeps failing when the asar-contained binary has no unpacked counterpart', async () => {
    const runtime = testRuntime()
    const handle = runtime.spawn(spawnSpec([missingBin, '--version']))
    await expect(handle.done).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves ordinary absolute programs untouched', async () => {
    const runtime = testRuntime()
    const handle = runtime.spawn(spawnSpec([process.execPath, '--version']))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })
})