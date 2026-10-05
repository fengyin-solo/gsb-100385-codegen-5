import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

// 早期数据没有版本信息，统一补成 rev=1，时间用播种日，保证各设备上同一份种子数据版本一致。
const SEED_TIMESTAMP = '2026-09-01T00:00:00.000Z'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function cloneRows<T>(value: T): T {
  return clone(value)
}

// 每条记录都带 rev（修订号，本地每改一次 +1）和 updatedAt（最后修改时间），
// 外业交换封包靠这两个字段判断哪一份更新。
function normalizeRow(row: EntryRow): EntryRow {
  const rev = Number(row.rev)
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : ''
  return {
    ...row,
    rev: Number.isFinite(rev) && rev >= 1 ? Math.floor(rev) : 1,
    updatedAt: updatedAt || SEED_TIMESTAMP,
  }
}

function normalizeAll(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(rows)) {
    next[key] = (rows[key] ?? []).map(normalizeRow)
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeAll(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAll(fallback)))
    return normalizeAll(fallback)
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalizeAll({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAll(fallback)))
    return normalizeAll(fallback)
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

// 多模块原子提交：整库一次性落盘。localStorage.setItem 失败时 cache 不更新，
// 调用方拿到的还是旧数据，等于这次写入整体没发生过。
export function saveModules(batch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...batch }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveModules({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []).map(normalizeRow)
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
