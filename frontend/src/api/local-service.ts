import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, cloneRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 跨模块事务：把涉及的模块复制成草稿交给变更函数，草稿上随便改；
// 变更函数抛错就什么都不写（自动回滚），正常返回才一次性整体落盘。
export function transact(
  keys: string[],
  mutate: (draft: Record<string, EntryRow[]>) => Record<string, EntryRow[]>,
): void {
  const draft: Record<string, EntryRow[]> = {}
  for (const key of keys) {
    draft[key] = cloneRows(listRows(key))
  }
  const changed = mutate(draft)
  const batch: Record<string, EntryRow[]> = {}
  for (const key of keys) {
    if (changed[key]) {
      batch[key] = changed[key]
    }
  }
  saveModules(batch)
}

function bumpRevision(row: EntryRow, now: string): Pick<EntryRow, 'rev' | 'updatedAt'> {
  return { rev: Number(row.rev ?? 1) + 1, updatedAt: now }
}

function toNumber(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : NaN
}

// 给遗物挑架位：状态「正常使用」且当前件数小于容纳件数；
// 优先存放器物类别与器物类型一致的架位，其次按架位编号顺序，保证结果可预期。
function pickRackIndex(racks: EntryRow[], artifact: EntryRow): number {
  const usable: number[] = []
  for (let i = 0; i < racks.length; i += 1) {
    const rack = racks[i]
    if (String(rack.status) !== '正常使用') {
      continue
    }
    const capacity = toNumber(rack['容纳件数'])
    const current = toNumber(rack['当前件数'])
    if (Number.isFinite(capacity) && Number.isFinite(current) && current < capacity) {
      usable.push(i)
    }
  }
  if (usable.length === 0) {
    return -1
  }
  const typed = usable.filter(
    (i) => String(racks[i]['存放器物类别']) === String(artifact['器物类型']),
  )
  const pool = typed.length > 0 ? typed : usable
  return pool.sort((a, b) => Number(racks[a].id) - Number(racks[b].id))[0]
}

// 办理入库 = 遗物状态流转 + 库房架位件数联动，两件事必须一起成、一起退：
// 在草稿上先算好两边的新值，任何一步过不了（没编号、没架位、件数不是数）都抛错回滚；
// 可用空间不单独存，由「容纳件数 − 当前件数」派生，与当前件数天然同生同灭，不会写岔。
function warehouseArtifact(id: number): ActionResult {
  let message = ''
  try {
    transact(['artifact', 'storage'], (draft) => {
      const artifacts = draft.artifact
      const racks = draft.storage
      const artifactIndex = artifacts.findIndex((row) => Number(row.id) === id)
      if (artifactIndex < 0) {
        throw new Error(`没有找到编号为 ${id} 的出土遗物`)
      }
      const artifact = artifacts[artifactIndex]
      const currentStatus = String(artifact.status)
      if (currentStatus === '已入库') {
        throw new Error('出土遗物已经是「已入库」，不用重复操作')
      }
      if (currentStatus !== '已编号') {
        throw new Error(`出土遗物当前状态「${currentStatus}」，需先完成清洗、编号才能办理入库`)
      }
      const rackIndex = pickRackIndex(racks, artifact)
      if (rackIndex < 0) {
        throw new Error('库房没有可用架位（需「正常使用」且当前件数小于容纳件数），入库取消')
      }
      const rack = racks[rackIndex]
      const capacity = toNumber(rack['容纳件数'])
      const current = toNumber(rack['当前件数'])
      if (!Number.isFinite(capacity) || !Number.isFinite(current)) {
        throw new Error(`架位 ${rack['架位编号']} 的容纳件数/当前件数不是数字，入库取消`)
      }
      const now = new Date().toISOString()
      const nextCurrent = current + 1
      const artifactStatuses = moduleMeta('artifact').statuses
      const nextRack: EntryRow = {
        ...rack,
        当前件数: nextCurrent,
        status: nextCurrent >= capacity ? '已满' : rack.status,
        ...bumpRevision(rack, now),
      }
      const nextArtifact: EntryRow = {
        ...artifact,
        status: '已入库',
        pending: '已入库' !== artifactStatuses[artifactStatuses.length - 1],
        abnormal: false,
        存放架位: String(rack['架位编号']),
        ...bumpRevision(artifact, now),
      }
      const nextArtifacts = [...artifacts]
      nextArtifacts[artifactIndex] = nextArtifact
      const nextRacks = [...racks]
      nextRacks[rackIndex] = nextRack
      message = `出土遗物已办理入库，当前状态「已入库」；架位 ${rack['架位编号']} 当前件数 ${nextCurrent}/${capacity}，可用空间 ${capacity - nextCurrent}`
      return { artifact: nextArtifacts, storage: nextRacks }
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知原因'
    return { ok: false, message: `${reason}；出土遗物与库房架位均未改动` }
  }
  return { ok: true, message }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 办理入库牵动库房架位，走跨模块事务，不能按普通状态流转处理。
  if (key === 'artifact' && action === '办理入库') {
    return warehouseArtifact(id)
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
    ...bumpRevision(rows[index], new Date().toISOString()),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadTextFile(filename, content, 'text/csv;charset=utf-8')
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
