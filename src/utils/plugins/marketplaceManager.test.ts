import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  type Mock,
  test,
} from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getFsImplementation,
  NodeFsOperations,
  setFsImplementation,
  type FsOperations,
} from '../fsOperations.js'

// Clear any stale mocks from other test files (e.g. lspRecommendation.test.ts,
// officialMarketplaceStartupCheck.test.ts) that mock marketplaceManager.js
// globally. mock.module with original() forces the real module, overriding
// any previously registered mock for this module.
mock.module('./marketplaceManager.js', async (original) => {
  // When this test runs in isolation (no prior mock from other test files),
  // `original` is undefined and calling it would throw TypeError.
  // Only call original() when it's a valid function — otherwise the real
  // module is already loaded and nothing needs to be restored.
  if (typeof original !== 'function') return
  return await original()
})

import { _test } from './marketplaceManager.js'
import type { MarketplaceSource } from './schemas.js'

const { loadAndCacheMarketplace } = _test

/**
 * Regression test for issue #1500 / PR #1531.
 *
 * On case-insensitive filesystems (Windows NTFS), the temporary cache path
 * and the final cache path can differ only in case — meaning they point at
 * the SAME directory. The old finalization code called fs.rm(finalCachePath)
 * unconditionally, which destroyed the source data and made the subsequent
 * fs.rename fail with ENOENT.
 *
 * The fix adds a `samePathCaseInsensitive` guard that skips the rm + rename
 * block when temporaryCachePath.toLowerCase() === finalCachePath.toLowerCase().
 *
 * A `settings` source is the cleanest way to drive this branch: it is
 * non-local (so the rename block is entered, unlike file/directory sources),
 * needs no network, and synthesizes its marketplace.json on disk under the
 * source's name. With a mixed-case name the temp path keeps the original case
 * while the final path is lowercased — so the two differ only in case.
 */
describe('loadAndCacheMarketplace — Windows cache finalization (#1500)', () => {
  let tempDir: string
  let originalFs: FsOperations
  let originalCacheDir: string | undefined
  let rmSpy: Mock<typeof NodeFsOperations.rm>
  let renameSpy: Mock<typeof NodeFsOperations.rename>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mp-cache-'))
    // getPluginsDirectory() honours this env var, so getMarketplacesCacheDir()
    // resolves to <tempDir>/marketplaces.
    originalCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = tempDir

    // Wrap the real filesystem so all operations actually happen, but rm and
    // rename are observable. The guard is a pure string comparison, so its
    // effect on control flow is identical on every platform.
    originalFs = getFsImplementation()
    rmSpy = mock(
      (path: string, options?: { recursive?: boolean; force?: boolean }) =>
        NodeFsOperations.rm(path, options),
    )
    renameSpy = mock((oldPath: string, newPath: string) =>
      NodeFsOperations.rename(oldPath, newPath),
    )
    setFsImplementation({
      ...NodeFsOperations,
      rm: rmSpy,
      rename: renameSpy,
    })
  })

  afterEach(() => {
    setFsImplementation(originalFs)
    if (originalCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalCacheDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('skips rm/rename when temp and final cache paths differ only in case', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'MyMarketplace',
      plugins: [],
    }

    const result = await loadAndCacheMarketplace(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const temporaryCachePath = join(cacheDir, 'MyMarketplace')
    const finalCachePath = join(cacheDir, 'mymarketplace')

    // Sanity check: this test only exercises the guard if the two paths really
    // do differ only in case. If this ever stops holding, the assertions below
    // would pass vacuously.
    expect(temporaryCachePath).not.toBe(finalCachePath)
    expect(temporaryCachePath.toLowerCase()).toBe(finalCachePath.toLowerCase())

    // The rename block must be skipped entirely — rename is the call that
    // failed with ENOENT once rm had destroyed the source.
    expect(renameSpy).not.toHaveBeenCalled()

    // fs.rm must never target the final cache path, which on a case-insensitive
    // filesystem is the very directory holding the freshly written manifest.
    const rmTargets = rmSpy.mock.calls.map(call => call[0])
    expect(
      rmTargets.some(p => p.toLowerCase() === finalCachePath.toLowerCase()),
    ).toBe(false)

    // The cached source survives: the manifest is still on disk and the
    // returned cache path keeps the original (un-renamed) directory.
    expect(result.marketplace.name).toBe('MyMarketplace')
    expect(result.cachePath).toBe(temporaryCachePath)
    expect(
      existsSync(join(temporaryCachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })

  // Regression test explicitly modeling the exact #1500 bug report scenario:
  // a mixed-case GitHub repo like 'AgriciDaniel/claude-obsidian' whose
  // marketplace.json has a matching (or case-variant) name. On Windows,
  // paths differing only in case point to the same directory — the old
  // code would rm the destination (destroying the source data) and then
  // fail the rename with ENOENT.
  test('skips rm/rename for mixed-case GitHub-style names (issue #1500)', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'AgriciDaniel-claude-obsidian', // mixed-case, like the GitHub repo
      plugins: [],
    }

    const result = await loadAndCacheMarketplace(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const temporaryCachePath = join(cacheDir, 'AgriciDaniel-claude-obsidian')
    const finalCachePath = join(cacheDir, 'agricidaniel-claude-obsidian')

    // Paths differ only in case — same directory on case-insensitive fs
    expect(temporaryCachePath).not.toBe(finalCachePath)
    expect(temporaryCachePath.toLowerCase()).toBe(finalCachePath.toLowerCase())

    // The case-insensitive guard must prevent rm + rename
    expect(renameSpy).not.toHaveBeenCalled()

    const rmTargets = rmSpy.mock.calls.map(call => call[0])
    expect(
      rmTargets.some(p => p.toLowerCase() === finalCachePath.toLowerCase()),
    ).toBe(false)

    // Data survives and cache path preserves the original case
    expect(result.marketplace.name).toBe('AgriciDaniel-claude-obsidian')
    expect(result.cachePath).toBe(temporaryCachePath)
    expect(
      existsSync(join(temporaryCachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })

  // When the source name is already lowercase, getCachePathForSource (for
  // github sources) and finalCachePath both produce lowercase strings —
  // they are identical, so the rename block at line 1725 is skipped at the
  // string-equality check without ever reaching the case-only guard. This
  // is the post-fix fast path for GitHub marketplaces.
  test('skips rm/rename when temp and final paths are already identical (lowercase)', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'claude-obsidian', // already lowercase, like a marketplace name
      plugins: [],
    }

    const result = await loadAndCacheMarketplace(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const cachePath = join(cacheDir, 'claude-obsidian')

    // Both temp and final paths are the same string — the rename block
    // is skipped at line 1725 (temporaryCachePath !== finalCachePath).
    expect(renameSpy).not.toHaveBeenCalled()

    // fs.rm must not target the cache directory at all
    const rmTargets = rmSpy.mock.calls.map(call => call[0])
    expect(
      rmTargets.some(p => p.toLowerCase() === cachePath.toLowerCase()),
    ).toBe(false)

    expect(result.marketplace.name).toBe('claude-obsidian')
    expect(result.cachePath).toBe(cachePath)
    expect(
      existsSync(join(cachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })
})

/**
 * Regression test: rename-failure fallback (EXDEV).
 *
 * When fs.rename fails (e.g. EXDEV on cross-device moves), the cache
 * finalization must fall back to cp + rm. This test uses a 'url' source
 * (with a mocked HTTP response) so that the temporary cache path (timestamp-
 * based) and the final cache path (marketplace.name.toLowerCase()) truly
 * differ, ensuring the samePathCaseInsensitive guard does not skip the
 * rename block. The test then forces rename to throw and verifies the
 * fallback correctly copies the temp cache to the final location, cleans up
 * the temp path, and returns the final cache path.
 */
describe('loadAndCacheMarketplace — rename failure fallback (EXDEV)', () => {
  let loadAndCacheWithMockedAxios: typeof loadAndCacheMarketplace
  let tempDir: string
  let originalFs: FsOperations
  let originalCacheDir: string | undefined
  let rmSpy: Mock<typeof NodeFsOperations.rm>
  let renameSpy: Mock<typeof NodeFsOperations.rename>
  let cpSpy: Mock<typeof import('fs/promises').cp>
  let axiosGetSpy: Mock<typeof import('axios').default.get>

  // Mock axios so the 'url' source can fetch without network.
  // Module-level mock.module() is registered once (per suite); the spy and its
  // implementation are recreated per-test in beforeEach to keep state isolated.
  const fakeMarketplaceJson = {
    name: 'MyMarketplace',
    owner: { name: 'test' },
    plugins: [],
  }

  beforeAll(async () => {
    // Capture the real fs/promises.cp so the spy can call through. We do this
    // by reading the unmocked module once before any mock.module() of
    // 'fs/promises' is registered, then re-exporting the real cp via a
    // closure the spy can call. The spy is recreated per-test so call counts
    // and implementations stay isolated across the suite.
    const realFsPromises = await import('fs/promises')

    // Spy on cp: passes through to the real implementation so the test
    // exercises the actual filesystem fallback path. We must use a wrapper
    // here because `mock()` without a default implementation would replace
    // cp with a no-op, leaving the temp file uncopied and the test's
    // filesystem assertions vacuous.
    const makeCpSpy = () =>
      mock(
        (
          source: Parameters<typeof realFsPromises.cp>[0],
          dest: Parameters<typeof realFsPromises.cp>[1],
          options?: Parameters<typeof realFsPromises.cp>[2],
        ): ReturnType<typeof realFsPromises.cp> =>
          realFsPromises.cp(source, dest, options),
      ) as unknown as Mock<typeof import('fs/promises').cp>

    cpSpy = makeCpSpy()

    // Replace fs/promises with a thin wrapper that uses our cp spy but
    // delegates everything else to the real module. marketplaceManager.ts
    // imports `cp` from 'fs/promises' (L22), so this mock routes that import
    // through cpSpy. fsOperations.ts also imports from 'fs/promises' but
    // only uses rm/rename, which still pass through.
    mock.module('fs/promises', () => ({
      ...realFsPromises,
      cp: cpSpy,
    }))

    mock.module('axios', () => ({
      default: {
        get: (...args: unknown[]) => axiosGetSpy(...args),
      },
      isAxiosError: () => false,
    }))

    // Re-import with mocked axios and fs/promises.cp so the module under
    // test picks up the mocks. Each test gets a fresh cp spy (and fresh
    // axios spy) via beforeEach.
    const mod = await import('./marketplaceManager.ts')
    loadAndCacheWithMockedAxios = mod._test.loadAndCacheMarketplace
  })

  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mp-cache-'))
    originalCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = tempDir

    originalFs = getFsImplementation()
    rmSpy = mock(
      (path: string, options?: { recursive?: boolean; force?: boolean }) =>
        NodeFsOperations.rm(path, options),
    )
    renameSpy = mock((oldPath: string, newPath: string) =>
      NodeFsOperations.rename(oldPath, newPath),
    )
    setFsImplementation({
      ...NodeFsOperations,
      rm: rmSpy,
      rename: renameSpy,
    })

    // Clear the cp spy that was registered in beforeAll so call counts
    // stay isolated per test. The spy itself persists across tests
    // (it is bound to the module-level mock.module('fs/promises')), but
    // mockClear() resets .mock.calls / .mock.results without losing the
    // call-through behavior.
    cpSpy.mockClear()

    // Fresh axios spy per test so call counts and implementations do not
    // leak across tests in this suite.
    axiosGetSpy = mock(async () => ({
      data: fakeMarketplaceJson,
      status: 200,
      headers: {},
    })) as Mock<typeof import('axios').default.get>
  })

  afterEach(() => {
    setFsImplementation(originalFs)
    if (originalCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalCacheDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('falls back to cp+rm when rename throws EXDEV', async () => {
    // Force rename to throw, simulating a cross-device move error.
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })

    // Use a 'url' source so the temp cache path (temp_<timestamp>.json
    // from getCachePathForSource) differs from the final cache path
    // (mymarketplace from marketplace.name.toLowerCase()). This bypasses
    // the samePathCaseInsensitive guard and lets the rename block execute.
    const source: MarketplaceSource = {
      source: 'url',
      url: 'https://example.com/marketplace.json',
      name: 'my-test-marketplace',
    }

    const cacheDir = join(tempDir, 'marketplaces')
    const finalCachePath = join(cacheDir, 'mymarketplace')

    // Create the cache directory and snapshot its contents BEFORE calling
    // the function under test. This makes the assertion platform-agnostic:
    // we compare against the pre-call state instead of assuming the
    // directory is empty (which fails on case-sensitive filesystems where
    // the temp file and final file can coexist as distinct entries).
    mkdirSync(cacheDir, { recursive: true })
    const beforeEntries = new Set(readdirSync(cacheDir))

    const result = await loadAndCacheWithMockedAxios(source)

    // After the fallback, the result cache path must be the final path
    expect(result.cachePath).toBe(finalCachePath)

    // The marketplace manifest must exist at the final location.
    // For 'url' sources the cache is stored as a flat JSON file named
    // after the marketplace (e.g. 'mymarketplace'), not a directory.
    expect(existsSync(finalCachePath)).toBe(true)

    // renameSpy must have been called at least once and must have thrown,
    // proving the code entered the catch block that triggers the cp+rm
    // fallback. Without this assertion, the test would still pass if the
    // code somehow reached the final file via a different path.
    expect(renameSpy).toHaveBeenCalled()
    const renameCalls = renameSpy.mock.calls
    expect(renameCalls.length).toBeGreaterThan(0)

    // The rename-failure fallback must invoke cp with the temp source and
    // final destination, and must request recursive copy. The first cp call
    // carries the source -> dest pair; the options are the third argument.
    expect(cpSpy).toHaveBeenCalled()
    const firstCpCall = cpSpy.mock.calls[0]
    expect(firstCpCall[0]).toContain('temp_')
    expect(firstCpCall[1]).toBe(finalCachePath)
    expect(firstCpCall[2]).toEqual({ recursive: true })

    // The temporary file (temp_<timestamp>.json) MUST be cleaned up — no
    // temp artifacts may remain after the fallback runs. This is the
    // explicit cleanup assertion the previous version of this test
    // weakened by filtering temp_* entries out of the delta.
    const afterEntries = readdirSync(cacheDir)
    const lingeringTempFiles = afterEntries.filter(e =>
      e.startsWith('temp_'),
    )
    expect(lingeringTempFiles).toEqual([])

    // Compare post-call directory state against the pre-call snapshot to
    // verify only the final file was added.
    const newEntries = afterEntries.filter(e => !beforeEntries.has(e))
    expect(newEntries).toEqual(['mymarketplace'])
  })
})
