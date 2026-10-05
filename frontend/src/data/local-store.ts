import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'
// 外业交换封包的导入台账：记录每个封包/每条遗物上次落库后的内容，用来支撑幂等判定。
const PACKING_LEDGER_KEY = 'field-archaeology-digital:packet-ledger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 跨模块事务写入：把多个模块的新行集合一次性落库。
 * 要么全部生效，要么抛错且缓存维持原样——调用方拿到错误后两边一起退回。
 * 纯前端只有一份 localStorage，写入点只有这一个：先 stringify 全量数据
 * （配额超限 / 序列化失败会在这里抛出），写成功后才换内存缓存。
 */
export function saveRowsTransaction(patches: Record<string, EntryRow[]>): void {
  const next: Record<string, EntryRow[]> = { ...allRows() }
  for (const [key, rows] of Object.entries(patches)) {
    next[key] = rows
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先完成可能失败的序列化与持久化，再动内存缓存：写失败时缓存仍是旧值。
    const serialized = JSON.stringify(next)
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export type PacketLedger = {
  /** 器物编号 -> 上次从封包落库的修订版本号与内容哈希。 */
  artifacts: Record<string, { rev: number; hash: string; packetChecksum: string }>
  /** 已经在本机落过库的封包摘要：同一封包反复装载时用它做提示与短路判定。 */
  seenPackets: { checksum: string; importedAt: string }[]
}

const EMPTY_LEDGER: PacketLedger = { artifacts: {}, seenPackets: [] }

export function loadPacketLedger(): PacketLedger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(EMPTY_LEDGER)
  }
  const raw = window.localStorage.getItem(PACKING_LEDGER_KEY)
  if (!raw) {
    return clone(EMPTY_LEDGER)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PacketLedger>
    return {
      artifacts: parsed.artifacts ?? {},
      seenPackets: parsed.seenPackets ?? [],
    }
  } catch {
    return clone(EMPTY_LEDGER)
  }
}

/**
 * 台账写入：台账只是幂等判定的记忆，不允许它把业务数据拖垮。
 * 所以这里失败不抛错，只返回 false，由调用方在导入报告里给出显式警告。
 */
export function savePacketLedger(ledger: PacketLedger): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true
  }
  try {
    window.localStorage.setItem(PACKING_LEDGER_KEY, JSON.stringify(ledger))
    return true
  } catch {
    return false
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供离线验证脚本使用：清掉内存缓存，强制下次从 localStorage 重读。 */
export function __resetCacheForTest(): void {
  cache = null
}
