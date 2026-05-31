/**
 * Regression tests for --fallback-model prop plumbing through interactive paths.
 *
 * The --fallback-model CLI option was extended from --print-only to interactive
 * mode. These tests verify all 3 entry points pass the prop through:
 *   1. Foreground REPL query() call (via sessionConfig spread)
 *   2. --resume picker (via launchResumeChooser -> ResumeConversation -> REPL)
 *   3. Background session (Ctrl+B -> startBackgroundSession queryParams)
 *
 * Tests read source files as text (no module loading) to avoid pulling in
 * transitive dependencies that can't resolve in the test environment.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const testDir = import.meta.dirname

function readSource(filename: string): string {
  return readFileSync(join(testDir, filename), 'utf8')
}

describe('fallbackModel: REPL Props contract', () => {
  test('REPL Props type declares optional fallbackModel', () => {
    const source = readSource('REPL.tsx')
    expect(source).toContain('fallbackModel?: string')
  })

  test('REPL destructures fallbackModel from Props', () => {
    const source = readSource('REPL.tsx')
    // fallbackModel appears as a bare identifier in the destructuring param
    // list (not just in the Props type). Verify it exists after the type def.
    const typeIdx = source.indexOf('fallbackModel?: string')
    expect(typeIdx).toBeGreaterThan(-1)
    const afterType = source.indexOf('fallbackModel', typeIdx + 20)
    expect(afterType).toBeGreaterThan(-1)
  })
})

describe('fallbackModel: foreground query() path', () => {
  test('fallbackModel appears inside a query({ call', () => {
    const source = readSource('REPL.tsx')
    // Foreground REPL path: fallbackModel is spread into sessionConfig
    // which is passed to query({. Assert query({ and fallbackModel
    // appear in proximity — the regex matches from query({ up to the
    // nearest fallbackModel (non-greedy).
    const match = source.match(/query\(\{[\s\S]*?fallbackModel/)
    expect(match).not.toBeNull()
  })
})

describe('fallbackModel: ResumeConversation path', () => {
  test('ResumeConversation Props type declares optional fallbackModel', () => {
    const source = readSource('ResumeConversation.tsx')
    expect(source).toContain('fallbackModel?: string')
  })

  test('ResumeConversation passes fallbackModel={fallbackModel} to REPL', () => {
    const source = readSource('ResumeConversation.tsx')
    expect(source).toContain('fallbackModel={fallbackModel}')
  })
})

describe('fallbackModel: background session path', () => {
  test('fallbackModel appears near startBackgroundSession call', () => {
    const source = readSource('REPL.tsx')
    // Ctrl+B path: fallbackModel is baked into queryParams passed
    // to startBackgroundSession. Find the function call site (not
    // the import) and verify fallbackModel is within the same handler
    // code block — a 8000-char window after the call site.
    const callIdx = source.indexOf('startBackgroundSession(')
    expect(callIdx).toBeGreaterThan(-1)
    const window = source.slice(callIdx, callIdx + 8000)
    expect(window).toContain('fallbackModel')
  })
})
