/**
 * Helpers for one-to-many custom-tag (Test-Case-ID) tagging.
 *
 * Both runtime paths (CLI/gRPC module + legacy listener handler) funnel through
 * the same tokenizer + merge engine so they produce an identical `custom_metadata`
 * payload shape:
 *   { [key]: { field_type: 'multi_dropdown', values: [...] } }
 *
 * The binary is a strict pass-through for per-test/per-hook `custom_metadata` — it
 * does NOT merge or dedupe across events — so the union+dedupe (set semantics)
 * MUST be completed SDK-side before serialization. Value parsing mirrors the
 * node-agent quote-aware tokenizer (helper.js `parseCommaSeparatedValues`).
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export interface CustomMetadataEntry {
    field_type: 'multi_dropdown'
    values: string[]
}

export type CustomMetadata = Record<string, CustomMetadataEntry>

/**
 * Quote-aware comma split. Mirrors node-agent `helper.js` tokenizer
 * `/\s*"([^"]*)"\s*|[^,]+/g` — a quoted body is preserved verbatim (so an
 * embedded comma is kept), otherwise the raw token is trimmed; empties dropped.
 *   '"checkout,cart", header' -> ['checkout,cart', 'header']
 *   'TC-1, TC-2'              -> ['TC-1', 'TC-2']
 * Backward compatible: unquoted input tokenizes identically to a naive
 * split(',').map(trim).filter(Boolean).
 */
export function parseCommaSeparatedValues(value: string | string[] | undefined | null): string[] {
    if (!value) {
        return []
    }

    if (Array.isArray(value)) {
        return value
    }

    const str = value.toString()
    if (str.trim() === '') {
        return []
    }

    const tokenizer = /\s*"([^"]*)"\s*|[^,]+/g
    const out: string[] = []
    let match: RegExpExecArray | null
    while ((match = tokenizer.exec(str)) !== null) {
        // Group 1 = quoted body (preserved verbatim); otherwise trim the raw match.
        const token = match[1] !== undefined ? match[1] : match[0].trim()
        if (token !== '') {
            out.push(token)
        }
    }
    return out
}

/**
 * Union + dedupe, existing-first ordering. Mirrors node-agent
 * `CustomTagManager.mergeValues` — repeated calls accumulate, they do not override.
 */
export function mergeValues(existingValues: string[] | undefined | null, incomingValues: string[] | undefined | null): string[] {
    return Array.from(new Set([...(existingValues || []), ...(incomingValues || [])]))
}

/**
 * Create-or-merge a single tag key inside a `custom_metadata` container.
 * Always produces `{ field_type: 'multi_dropdown', values: [...] }`; merges values
 * via mergeValues. The container is mutated in place and returned for chaining.
 * Mirrors node-agent `CustomTagManager.mergeIntoTags`.
 */
export function mergeIntoTags(tagsContainer: CustomMetadata, key: string, incomingValues: string[]): CustomMetadata {
    if (!tagsContainer[key]) {
        tagsContainer[key] = {
            field_type: 'multi_dropdown',
            values: [...(incomingValues || [])]
        }
    } else {
        // Defensive: tolerate malformed pre-existing entries.
        if (!tagsContainer[key].field_type) {
            tagsContainer[key].field_type = 'multi_dropdown'
        }
        if (!Array.isArray(tagsContainer[key].values)) {
            tagsContainer[key].values = []
        }
        tagsContainer[key].values = mergeValues(tagsContainer[key].values, incomingValues)
    }

    return tagsContainer
}

/**
 * Per-test-uuid accumulator. Both paths key on `InsightsHandler.currentTest.uuid`
 * so repeated `setCustomTags` calls within a single test union into one entry, and
 * the flush sink reads the final consolidated map for that test.
 */
export class CustomTagAccumulator {
    private store: Map<string, CustomMetadata> = new Map()

    /**
     * Add (key, value) for a test uuid. value is quote-aware comma-split; the
     * resulting values union+dedupe into the test's custom_metadata for that key.
     * Returns false (no-op) when uuid/key/value resolve to nothing.
     */
    add(testUuid: string | undefined, key: string, value: string): boolean {
        if (!testUuid || !key) {
            return false
        }
        const values = parseCommaSeparatedValues(value)
        if (values.length === 0) {
            return false
        }
        const container = this.store.get(testUuid) || {}
        mergeIntoTags(container, key, values)
        this.store.set(testUuid, container)
        return true
    }

    /** Final consolidated custom_metadata for a test uuid, or undefined if none. */
    get(testUuid: string | undefined): CustomMetadata | undefined {
        if (!testUuid) {
            return undefined
        }
        return this.store.get(testUuid)
    }

    /** Drop the accumulated entry once flushed (avoid unbounded growth). */
    clear(testUuid: string | undefined): void {
        if (testUuid) {
            this.store.delete(testUuid)
        }
    }
}

/* --------------------------------------------------------------------------
 * Build-level custom metadata.
 *
 * Unlike test-level tags (which ride the per-test event_json), build-level tags are
 * attached ONCE to the build-finish payload (stopBinSession.custom_metadata). WDIO
 * runs one process per spec file with NO shared memory, so each worker accumulates
 * its own build-level tags in-process and persists a FULL snapshot to a shared temp
 * file; the main process aggregates every worker's snapshot at build finish. Mirrors
 * node-agent's customTagManager build-level mechanism (temp-file snapshot + aggregate).
 * ------------------------------------------------------------------------ */

/** Env var carrying the run-scope build id — set in BrowserstackCLI.loadModules() in every process. */
const BUILD_TAGS_RUN_ID_ENV = 'BROWSERSTACK_TESTHUB_UUID'
const BUILD_TAGS_FILE_PREFIX = 'bstack_build_tags_'
/** Skip + drop snapshots older than this — guards a reused run id from picking up a prior run's leftovers. */
const BUILD_TAGS_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** Run-scope id used to name this process's snapshot file; null when unavailable (build-level tags then degrade gracefully). */
export function getBuildTagsRunId(): string | null {
    const runId = process.env[BUILD_TAGS_RUN_ID_ENV]
    return runId && runId !== 'null' ? runId : null
}

function getBuildTagsFilePath(runId: string): string {
    return path.join(os.tmpdir(), `${BUILD_TAGS_FILE_PREFIX}${runId}_${process.pid}.json`)
}

/**
 * Process-local build-level custom_metadata store. Accumulates
 * setCustomTags(key, value, true) calls and persists a full snapshot for the main
 * process to aggregate. Never throws — a failed snapshot must not break the user's test.
 */
export class BuildLevelTagStore {
    private store: CustomMetadata = {}

    /** Merge one (key, value) into the build store; value is quote-aware comma-split. Returns false when nothing usable. */
    add(key: string, value: string): boolean {
        if (!key) {
            return false
        }
        const values = parseCommaSeparatedValues(value)
        if (values.length === 0) {
            return false
        }
        mergeIntoTags(this.store, key, values)
        return true
    }

    get(): CustomMetadata {
        return this.store
    }

    /**
     * Persist a FULL snapshot of this process's build-level tags to the shared temp
     * file (keyed on runId + pid). Full-snapshot, not diff, so aggregation is an
     * order-independent union. No-op when the run id is unavailable or the store is
     * empty. Never throws.
     */
    async writeSnapshot(): Promise<void> {
        try {
            const runId = getBuildTagsRunId()
            if (!runId || Object.keys(this.store).length === 0) {
                return
            }
            await fs.promises.writeFile(getBuildTagsFilePath(runId), JSON.stringify(this.store))
        } catch {
            // graceful degradation — snapshot failure must not surface to the user's test
        }
    }
}

/** Singleton build-level store for the current process. */
export const buildLevelTagStore = new BuildLevelTagStore()

/**
 * Aggregate every worker's build-level snapshot for this run into one custom_metadata
 * map, unlinking each file as it goes (best-effort). Snapshots older than
 * BUILD_TAGS_MAX_AGE_MS are skipped + unlinked. Called once, in the main process, at
 * build finish. Never throws; returns {} on any failure.
 */
export function aggregateBuildLevelTagsFromTmp(runId: string | null): CustomMetadata {
    const merged: CustomMetadata = {}
    if (!runId) {
        return merged
    }
    try {
        const dir = os.tmpdir()
        const prefix = `${BUILD_TAGS_FILE_PREFIX}${runId}_`
        const now = Date.now()
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith(prefix) || !name.endsWith('.json')) {
                continue
            }
            const filePath = path.join(dir, name)
            try {
                const stat = fs.statSync(filePath)
                if (now - stat.mtimeMs <= BUILD_TAGS_MAX_AGE_MS) {
                    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CustomMetadata
                    for (const [key, entry] of Object.entries(parsed || {})) {
                        if (entry && Array.isArray(entry.values)) {
                            mergeIntoTags(merged, key, entry.values)
                        }
                    }
                }
                // else: stale snapshot — skip merge (still unlinked in finally)
            } catch {
                // skip unreadable / corrupt snapshot
            } finally {
                try {
                    fs.unlinkSync(filePath)
                } catch {
                    // best-effort cleanup
                }
            }
        }
    } catch {
        // tmpdir unreadable — return whatever merged so far
    }
    return merged
}

/* --------------------------------------------------------------------------
 * Title-based Test-Case-ID tagging (opt-in).
 *
 * When enabled via testObservabilityOptions.testCaseIdFromTitle, Test-Case-IDs
 * are derived from each test's TITLE (e.g. a TestRail-style
 * "C123 C456 C987 My test") and merged into custom_metadata under the configured
 * key — equivalent to the user calling setCustomTags(key, 'C123, C456') for that
 * test, and unioned with any explicit setCustomTags calls. Both runtime paths
 * (legacy handler + CLI module) resolve the SAME config, published once to the
 * process env at beforeSession, so neither path depends on the binary echoing
 * user options back.
 * ------------------------------------------------------------------------ */

export interface TitleTagConfig {
    /** Regex SOURCE string, applied globally (g) to the test title. */
    pattern: string
    /** custom_metadata key the extracted IDs are tagged under. */
    key: string
}

/** TestRail convention: a `C` immediately followed by digits (e.g. C123). */
const DEFAULT_TITLE_TAG_PATTERN = 'C\\d+'
const DEFAULT_TITLE_TAG_KEY = 'test_case_id'
const TITLE_TAG_ENV = 'BROWSERSTACK_TESTHUB_CASE_ID_FROM_TITLE'

/**
 * Normalize the user-facing option (boolean | { pattern?, key? }) into a concrete
 * config, or undefined when disabled/absent. Blank overrides fall back to defaults.
 */
export function normalizeTitleTagConfig(
    option: boolean | { pattern?: string, key?: string } | undefined | null
): TitleTagConfig | undefined {
    if (!option) {
        return undefined
    }
    if (option === true) {
        return { pattern: DEFAULT_TITLE_TAG_PATTERN, key: DEFAULT_TITLE_TAG_KEY }
    }
    if (typeof option === 'object') {
        const pattern = (typeof option.pattern === 'string' && option.pattern.trim() !== '') ? option.pattern : DEFAULT_TITLE_TAG_PATTERN
        const key = (typeof option.key === 'string' && option.key.trim() !== '') ? option.key : DEFAULT_TITLE_TAG_KEY
        return { pattern, key }
    }
    return undefined
}

/** Publish the resolved config to the process env (single source of truth for both paths). */
export function publishTitleTagConfig(cfg: TitleTagConfig | undefined): void {
    if (cfg) {
        process.env[TITLE_TAG_ENV] = JSON.stringify(cfg)
    }
}

/** Read the resolved config from the process env, or undefined when disabled/malformed. */
export function resolveTitleTagConfig(): TitleTagConfig | undefined {
    const raw = process.env[TITLE_TAG_ENV]
    if (!raw) {
        return undefined
    }
    try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.pattern === 'string' && typeof parsed.key === 'string') {
            return { pattern: parsed.pattern, key: parsed.key }
        }
    } catch {
        // malformed → treat as disabled
    }
    return undefined
}

/**
 * Extract Test-Case-IDs from a test title using the configured pattern. Returns a
 * deduped, order-preserving list; an empty/invalid pattern or title is a safe no-op.
 *   extractCaseIdsFromTitle('C123 C456 C987 Checkout works', 'C\\d+')
 *     -> ['C123', 'C456', 'C987']
 */
export function extractCaseIdsFromTitle(title: string | undefined | null, pattern: string): string[] {
    if (!title || !pattern) {
        return []
    }
    try {
        const matches = title.match(new RegExp(pattern, 'g')) || []
        return Array.from(new Set(matches.map((m) => m.trim()).filter((m) => m !== '')))
    } catch {
        return []
    }
}
