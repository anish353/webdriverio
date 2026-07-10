import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import {
    parseCommaSeparatedValues,
    mergeIntoTags,
    BuildLevelTagStore,
    getBuildTagsRunId,
    aggregateBuildLevelTagsFromTmp
} from '../src/customTags.js'
import type { CustomMetadata } from '../src/customTags.js'

const RUN_ID_ENV = 'BROWSERSTACK_TESTHUB_UUID'

/** Path a snapshot for `runId` written by process `pid` would live at (mirrors getBuildTagsFilePath). */
function snapshotPath(runId: string, pid: number): string {
    return path.join(os.tmpdir(), `bstack_build_tags_${runId}_${pid}.json`)
}

function writeSnapshotFile(runId: string, pid: number, data: CustomMetadata): string {
    const p = snapshotPath(runId, pid)
    fs.writeFileSync(p, JSON.stringify(data))
    return p
}

function tag(...values: string[]) {
    return { field_type: 'multi_dropdown' as const, values }
}

describe('customTags — build-level custom metadata', () => {
    const origEnv = process.env[RUN_ID_ENV]
    // Unique run id per test run so the shared tmpdir can't collide with other suites.
    let runId: string
    const written: string[] = []

    beforeEach(() => {
        runId = `test-run-${process.pid}-${Math.floor(performance.now() * 1000)}`
        written.length = 0
    })

    afterEach(() => {
        // Clean up any snapshot files a test left behind and restore env.
        for (const f of written) {
            try {
                fs.unlinkSync(f)
            } catch { /* already gone */ }
        }
        if (origEnv === undefined) {
            delete process.env[RUN_ID_ENV]
        } else {
            process.env[RUN_ID_ENV] = origEnv
        }
    })

    describe('getBuildTagsRunId', () => {
        it('returns the env value when set', () => {
            process.env[RUN_ID_ENV] = 'abc123'
            expect(getBuildTagsRunId()).toBe('abc123')
        })

        it('returns null when unset or literal "null"', () => {
            delete process.env[RUN_ID_ENV]
            expect(getBuildTagsRunId()).toBeNull()
            process.env[RUN_ID_ENV] = 'null'
            expect(getBuildTagsRunId()).toBeNull()
        })
    })

    describe('BuildLevelTagStore', () => {
        it('accumulates with quote-aware split + union/dedupe (merge, not override)', () => {
            const store = new BuildLevelTagStore()
            expect(store.add('release', 'v1, v2')).toBe(true)
            expect(store.add('release', 'v2, v3')).toBe(true) // v2 dedupes
            expect(store.add('component', '"checkout,cart", header')).toBe(true)
            expect(store.get()).toEqual({
                release: tag('v1', 'v2', 'v3'),
                component: tag('checkout,cart', 'header')
            })
        })

        it('is a no-op (returns false) for empty key or no usable values', () => {
            const store = new BuildLevelTagStore()
            expect(store.add('', 'v1')).toBe(false)
            expect(store.add('release', '   ')).toBe(false)
            expect(store.add('release', ',,')).toBe(false)
            expect(store.get()).toEqual({})
        })

        it('writeSnapshot persists a full snapshot keyed on runId + pid', async () => {
            process.env[RUN_ID_ENV] = runId
            const store = new BuildLevelTagStore()
            store.add('release', 'v1')
            await store.writeSnapshot()
            const p = snapshotPath(runId, process.pid)
            written.push(p)
            expect(fs.existsSync(p)).toBe(true)
            expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ release: tag('v1') })
        })

        it('writeSnapshot is a no-op when the run id is unavailable', async () => {
            delete process.env[RUN_ID_ENV]
            const store = new BuildLevelTagStore()
            store.add('release', 'v1')
            await store.writeSnapshot()
            expect(fs.existsSync(snapshotPath('', process.pid))).toBe(false)
        })

        it('writeSnapshot is a no-op when the store is empty', async () => {
            process.env[RUN_ID_ENV] = runId
            const store = new BuildLevelTagStore()
            await store.writeSnapshot()
            expect(fs.existsSync(snapshotPath(runId, process.pid))).toBe(false)
        })
    })

    describe('aggregateBuildLevelTagsFromTmp', () => {
        it('returns {} when runId is null', () => {
            expect(aggregateBuildLevelTagsFromTmp(null)).toEqual({})
        })

        it('unions snapshots across simulated workers and unlinks every file', () => {
            const f1 = writeSnapshotFile(runId, 1001, { release: tag('v1'), test_case_id: tag('TC-1', 'TC-2') })
            const f2 = writeSnapshotFile(runId, 1002, { release: tag('v1', 'v2'), env: tag('staging') })
            written.push(f1, f2)

            const merged = aggregateBuildLevelTagsFromTmp(runId)

            expect(merged).toEqual({
                release: tag('v1', 'v2'),          // union + dedupe across workers
                test_case_id: tag('TC-1', 'TC-2'),
                env: tag('staging')
            })
            // Cleaned up after aggregation.
            expect(fs.existsSync(f1)).toBe(false)
            expect(fs.existsSync(f2)).toBe(false)
        })

        it('ignores snapshots belonging to a different run id', () => {
            const mine = writeSnapshotFile(runId, 2001, { release: tag('v1') })
            const other = writeSnapshotFile(`${runId}-other`, 2002, { release: tag('SHOULD_NOT_APPEAR') })
            written.push(mine, other)

            const merged = aggregateBuildLevelTagsFromTmp(runId)

            expect(merged).toEqual({ release: tag('v1') })
            expect(fs.existsSync(mine)).toBe(false)   // mine consumed
            expect(fs.existsSync(other)).toBe(true)   // other run's file untouched
        })

        it('skips but still unlinks a stale snapshot (older than the 2h guard)', () => {
            const stale = writeSnapshotFile(runId, 3001, { release: tag('STALE') })
            written.push(stale)
            // Backdate mtime ~3h so it trips the staleness guard.
            const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
            fs.utimesSync(stale, threeHoursAgo, threeHoursAgo)

            const merged = aggregateBuildLevelTagsFromTmp(runId)

            expect(merged).toEqual({})                // stale content not merged
            expect(fs.existsSync(stale)).toBe(false)  // but still cleaned up
        })

        it('tolerates a corrupt snapshot file without throwing', () => {
            const good = writeSnapshotFile(runId, 4001, { release: tag('v1') })
            const badPath = snapshotPath(runId, 4002)
            fs.writeFileSync(badPath, '{ this is not json')
            written.push(good, badPath)

            const merged = aggregateBuildLevelTagsFromTmp(runId)

            expect(merged).toEqual({ release: tag('v1') })
            expect(fs.existsSync(good)).toBe(false)
            expect(fs.existsSync(badPath)).toBe(false) // corrupt file cleaned up too
        })
    })

    describe('shared helpers still behave (regression guard)', () => {
        it('parseCommaSeparatedValues keeps quoted commas', () => {
            expect(parseCommaSeparatedValues('"a,b", c')).toEqual(['a,b', 'c'])
        })
        it('mergeIntoTags create-or-merges (no override)', () => {
            const c: CustomMetadata = {}
            mergeIntoTags(c, 'k', ['a'])
            mergeIntoTags(c, 'k', ['a', 'b'])
            expect(c).toEqual({ k: tag('a', 'b') })
        })
    })
})
