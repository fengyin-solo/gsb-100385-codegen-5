import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  resetRows,
  saveRows,
  saveRowsTransaction,
} from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const STORAGE_MODULE = 'storage'
const STORAGE_LAST_STATUS = '临时封存'
// 办理入库的目标状态（与 modules.ts 里 artifact 的动作流转目标保持一致）。
const CHECKED_IN_STATUS = '已入库'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 现场修订痕迹：每次业务流转都把版本号 +1 并记下时间，外业封包用它做冲突裁决。 */
function stampRevision(row: EntryRow): { _rev: number; _updatedAt: string } {
  return {
    _rev: (typeof row._rev === 'number' ? row._rev : 0) + 1,
    _updatedAt: new Date().toISOString(),
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    ...stampRevision(rows[index]),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 库房架位容量（跨模块联动用）
// ---------------------------------------------------------------------------

export type ShelfCapacity = {
  capacity: number
  current: number
  available: number
  /** 容纳件数 / 当前件数无法解析成数字（旧示例数据）时为 false，不允许参与入库。 */
  valid: boolean
}

function readShelfCapacity(shelf: EntryRow): ShelfCapacity {
  const capacity = Number(shelf['容纳件数'])
  const current = Number(shelf['当前件数'])
  const valid = Number.isFinite(capacity) && Number.isFinite(current) && capacity >= 0 && current >= 0
  return { capacity, current, available: valid ? capacity - current : NaN, valid }
}

/** 架位可用空间 = 容纳件数 - 当前件数；旧数据字段不是数字时返回 null，页面显示「—」。 */
export function shelfAvailableSpace(shelf: EntryRow): number | null {
  const info = readShelfCapacity(shelf)
  return info.valid ? info.available : null
}

export type ShelfOption = {
  id: number
  code: string
  warehouse: string
  category: string
  capacity: number
  current: number
  available: number
  /** 不能再放：已满或临时封存，或容量字段不是合法数字。 */
  unavailable: boolean
  reason: string
}

/** 办理入库时选择架位用：同时给出可用空间与不可用原因。 */
export function listShelfOptions(): ShelfOption[] {
  return listRows(STORAGE_MODULE).map((shelf) => {
    const info = readShelfCapacity(shelf)
    const status = String(shelf.status ?? '')
    let reason = ''
    if (!info.valid) {
      reason = '容纳件数/当前件数不是合法数字，需先在库房模块校正'
    } else if (status === '临时封存') {
      reason = '架位已临时封存，禁止存入'
    } else if (info.available <= 0) {
      reason = '架位已满，没有可用空间'
    }
    return {
      id: Number(shelf.id),
      code: String(shelf['架位编号'] ?? ''),
      warehouse: String(shelf['库房名称'] ?? ''),
      category: String(shelf['存放器物类别'] ?? ''),
      capacity: info.capacity,
      current: info.current,
      available: info.valid ? info.available : 0,
      unavailable: reason !== '',
      reason,
    }
  })
}

/**
 * 办理入库：跨模块事务。
 *
 * 一次动作同时写两个模块——
 * - artifact：遗物状态改为「已入库」；
 * - storage：目标架位当前件数 +1、可用空间同步重算，满了还要把架位状态翻成「已满」。
 *
 * 所有校验先在内存副本上完成，最后用 saveRowsTransaction 一次性提交：
 * 任一侧写入失败（如 localStorage 配额超限），事务抛错且缓存不换，
 * 遗物状态与架位件数两边一起退回，不会出现「遗物已入库但架位没加件」的中间态。
 */
export function checkInArtifact(artifactId: number, shelfId: number): ActionResult {
  const artifacts = listRows('artifact')
  const artifactIndex = artifacts.findIndex((row) => Number(row.id) === artifactId)
  if (artifactIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${artifactId} 的出土遗物` }
  }
  const artifact = artifacts[artifactIndex]
  if (String(artifact.status) === CHECKED_IN_STATUS) {
    return { ok: false, message: `出土遗物 ${artifact['器物编号']} 已办理过入库，不能重复入库` }
  }

  const shelves = listRows(STORAGE_MODULE)
  const shelfIndex = shelves.findIndex((row) => Number(row.id) === shelfId)
  if (shelfIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${shelfId} 的库房架位` }
  }
  const shelf = shelves[shelfIndex]
  const capacityInfo = readShelfCapacity(shelf)
  if (!capacityInfo.valid) {
    return {
      ok: false,
      message: `架位 ${shelf['架位编号']} 的容纳件数/当前件数不是合法数字，请先在库房管理模块校正`,
    }
  }
  if (String(shelf.status) === STORAGE_LAST_STATUS) {
    return { ok: false, message: `架位 ${shelf['架位编号']} 已临时封存，不能办理入库` }
  }
  if (capacityInfo.available <= 0) {
    return { ok: false, message: `架位 ${shelf['架位编号']} 已满（当前 ${capacityInfo.current}/${capacityInfo.capacity}），请另选架位` }
  }

  const nextCurrent = capacityInfo.current + 1
  const nextAvailable = capacityInfo.capacity - nextCurrent
  const previousShelfStatus = String(shelf.status ?? '')
  // 待整理的架位维持待整理（由库房模块自己决定何时恢复）；正常使用/已满按件数联动。
  const nextShelfStatus =
    nextCurrent >= capacityInfo.capacity
      ? '已满'
      : previousShelfStatus === '待整理'
        ? '待整理'
        : '正常使用'

  const nextArtifact: EntryRow = {
    ...artifact,
    status: CHECKED_IN_STATUS,
    pending: false,
    ...stampRevision(artifact),
  }
  const nextShelf: EntryRow = {
    ...shelf,
    '当前件数': nextCurrent,
    '可用空间': nextAvailable,
    status: nextShelfStatus,
  }

  const nextArtifacts = artifacts.slice()
  nextArtifacts[artifactIndex] = nextArtifact
  const nextShelves = shelves.slice()
  nextShelves[shelfIndex] = nextShelf

  try {
    saveRowsTransaction({ artifact: nextArtifacts, storage: nextShelves })
  } catch (error) {
    // 事务保证缓存与 localStorage 都停留在提交前状态：两边一起退回。
    return {
      ok: false,
      message: `入库写入失败，遗物状态与架位件数均未改动：${
        error instanceof Error ? error.message : '未知存储错误'
      }`,
    }
  }
  const shelfHint =
    nextCurrent >= capacityInfo.capacity ? '，架位已达容纳上限并标记为「已满」' : ''
  return {
    ok: true,
    message: `出土遗物 ${artifact['器物编号']} 已入库到架位 ${shelf['架位编号']}（当前 ${nextCurrent}/${capacityInfo.capacity}，可用空间 ${nextAvailable}）${shelfHint}`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
