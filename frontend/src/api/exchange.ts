import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, saveModules } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { canonicalJson, sha256Hex } from '@/utils/checksum'

// 出土遗物外业交换封包：导出、校验、幂等导入都在这里。
// 核心函数（buildPackageFromRows / mergePackageIntoRows）不碰存储，纯数据进纯数据出，
// 方便在测试里模拟「A 机导出 → B 机导入」的双设备流程。

export const EXCHANGE_FORMAT = 'artifact-exchange'
export const EXCHANGE_FORMAT_VERSION = 1
const ARTIFACT_KEY = 'artifact'

export type ExchangeFilters = {
  器物编号?: string
  发掘区?: string
  出土层位?: string
  登记状态?: string
}

export type ExchangeRecord = {
  器物编号: string
  status: string
  pending: boolean
  abnormal: boolean
  rev: number
  updatedAt: string
  fields: Record<string, string | number | boolean>
}

export type ExchangePackage = {
  format: typeof EXCHANGE_FORMAT
  formatVersion: number
  packageId: string
  createdAt: string
  filters: Record<string, string>
  count: number
  records: ExchangeRecord[]
  checksum: string
}

export type ImportConflict = {
  器物编号: string
  decision: string
}

export type ImportReport = {
  packageId: string
  total: number
  inserted: number
  updated: number
  unchanged: number
  keptLocal: number
  conflicts: ImportConflict[]
}

function artifactStatuses(): string[] {
  return MODULE_BY_KEY.get(ARTIFACT_KEY)?.statuses ?? []
}

function matchFilters(row: EntryRow, filters: ExchangeFilters): boolean {
  const code = filters.器物编号?.trim() ?? ''
  if (code && !String(row['器物编号'] ?? '').includes(code)) {
    return false
  }
  // 「发掘区」在遗物台账里落在「出土探方」字段上（探方隶属于发掘区），按它检索。
  const area = filters.发掘区?.trim() ?? ''
  if (area && !String(row['出土探方'] ?? '').includes(area)) {
    return false
  }
  const layer = filters.出土层位?.trim() ?? ''
  if (layer && !String(row['出土层位'] ?? '').includes(layer)) {
    return false
  }
  const status = filters.登记状态?.trim() ?? ''
  if (status && String(row.status) !== status) {
    return false
  }
  return true
}

// 封包里只带业务字段 + 版本信息；本机自增 id 不出封包，到对端重新分配，避免跨设备撞号。
function toExchangeRecord(row: EntryRow): ExchangeRecord {
  const meta = MODULE_BY_KEY.get(ARTIFACT_KEY)
  const fields: Record<string, string | number | boolean> = {}
  for (const field of meta?.fields ?? []) {
    const value = row[field]
    if (value !== undefined) {
      fields[field] = value
    }
  }
  // 入库后写回的存放架位也随封包走，到对端不用翻台账。
  if (row['存放架位'] !== undefined) {
    fields['存放架位'] = row['存放架位']
  }
  return {
    器物编号: String(row['器物编号'] ?? ''),
    status: String(row.status),
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    rev: Number(row.rev ?? 1),
    updatedAt: String(row.updatedAt ?? ''),
    fields,
  }
}

function normalizeRecord(record: ExchangeRecord): ExchangeRecord {
  return {
    器物编号: String(record.器物编号 ?? ''),
    status: String(record.status ?? ''),
    pending: Boolean(record.pending),
    abnormal: Boolean(record.abnormal),
    rev: Number(record.rev ?? 1),
    updatedAt: String(record.updatedAt ?? ''),
    fields: record.fields ?? {},
  }
}

function makePackageId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `AXP-${stamp}-${suffix}`
}

/** 从给定遗物行生成封包（纯函数，不读存储）。 */
export function buildPackageFromRows(
  rows: EntryRow[],
  filters: ExchangeFilters,
  now: Date = new Date(),
): ExchangePackage {
  const records = rows
    .filter((row) => matchFilters(row, filters))
    .map(toExchangeRecord)
    .sort((a, b) => a.器物编号.localeCompare(b.器物编号, 'zh-Hans-CN'))
  const trimmedFilters: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value && value.trim() !== '') {
      trimmedFilters[key] = value.trim()
    }
  }
  return {
    format: EXCHANGE_FORMAT,
    formatVersion: EXCHANGE_FORMAT_VERSION,
    packageId: makePackageId(now),
    createdAt: now.toISOString(),
    filters: trimmedFilters,
    count: records.length,
    records,
    checksum: sha256Hex(canonicalJson(records)),
  }
}

/** 解析并校验封包：格式、版本、条数、SHA-256 摘要、记录完整性，任一不过直接拒收。 */
export function parseExchangePackage(json: string): ExchangePackage {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('封包不是合法的 JSON 文件')
  }
  const pkg = raw as ExchangePackage
  if (!pkg || pkg.format !== EXCHANGE_FORMAT) {
    throw new Error('这不是出土遗物外业交换封包')
  }
  if (pkg.formatVersion !== EXCHANGE_FORMAT_VERSION) {
    throw new Error(`封包格式版本 ${pkg.formatVersion} 不受支持，当前只认 v${EXCHANGE_FORMAT_VERSION}`)
  }
  if (!Array.isArray(pkg.records)) {
    throw new Error('封包缺少记录列表')
  }
  if (pkg.count !== pkg.records.length) {
    throw new Error(`封包条数对不上：摘要写 ${pkg.count} 条，实际 ${pkg.records.length} 条`)
  }
  const checksum = sha256Hex(canonicalJson(pkg.records))
  if (checksum !== pkg.checksum) {
    throw new Error('封包校验摘要不一致，文件已损坏或被人改动，拒绝导入')
  }
  const seen = new Set<string>()
  for (const record of pkg.records) {
    if (!record || typeof record.器物编号 !== 'string' || record.器物编号.trim() === '') {
      throw new Error('封包里有缺器物编号的记录')
    }
    if (seen.has(record.器物编号)) {
      throw new Error(`封包里器物编号 ${record.器物编号} 重复出现`)
    }
    seen.add(record.器物编号)
    if (!Number.isFinite(Number(record.rev)) || Number(record.rev) < 1) {
      throw new Error(`器物 ${record.器物编号} 的修订号无效`)
    }
  }
  return pkg
}

// 冲突裁决（同器物编号、两边都改过）：先看修订号，号高者新；
// 修订号相同再比状态在推进序列里的位置（已入库 > 已编号 > 已清洗 > 已采集），
// 流程走得更远的一般是更晚的整理成果；再平手比 updatedAt；
// 全都一样时保留本地——外来封包不能盖掉本机还没发出去的修改，这样丢的最多是封包里那份已知数据。
function arbitrate(localRow: EntryRow, record: ExchangeRecord): 'local' | 'package' {
  const statuses = artifactStatuses()
  const rank = (status: string) => {
    const index = statuses.indexOf(status)
    return index < 0 ? statuses.length : index
  }
  const localRank = rank(String(localRow.status))
  const packageRank = rank(record.status)
  if (localRank !== packageRank) {
    return packageRank > localRank ? 'package' : 'local'
  }
  const localTime = Date.parse(String(localRow.updatedAt ?? '')) || 0
  const packageTime = Date.parse(record.updatedAt) || 0
  if (localTime !== packageTime) {
    return packageTime > localTime ? 'package' : 'local'
  }
  return 'local'
}

// 封包版本覆盖本地：本机 id 保留，业务字段以封包为准；
// 封包里没有的「存放架位」沿用本地值，避免把本机已办的入库信息抹掉。
function mergedRow(localRow: EntryRow, record: ExchangeRecord): EntryRow {
  const merged: EntryRow = {
    id: localRow.id,
    ...record.fields,
    器物编号: record.器物编号,
    status: record.status,
    pending: record.pending,
    abnormal: record.abnormal,
    rev: record.rev,
    updatedAt: record.updatedAt,
  }
  if (record.fields['存放架位'] === undefined && localRow['存放架位'] !== undefined) {
    merged['存放架位'] = localRow['存放架位']
  }
  return merged
}

function fromExchangeRecord(record: ExchangeRecord, id: number): EntryRow {
  return {
    id,
    ...record.fields,
    器物编号: record.器物编号,
    status: record.status,
    pending: record.pending,
    abnormal: record.abnormal,
    rev: record.rev,
    updatedAt: record.updatedAt,
  }
}

/**
 * 把封包合并进给定的本地遗物行（纯函数）。
 * 幂等规则：按器物编号对账 ——
 *   本地没有 → 新增；封包修订号高 → 覆盖本地；本地修订号高 → 保留本地；
 *   修订号相同且内容一致 → 不动（所以同一封包反复装载不会多出遗物，也不会重复改动）；
 *   修订号相同但内容不同 → 按 arbitrate 的规则裁决，绝不静默跳过。
 */
export function mergePackageIntoRows(
  localRows: EntryRow[],
  pkg: ExchangePackage,
): { next: EntryRow[]; report: ImportReport } {
  const next = [...localRows]
  const indexByCode = new Map<string, number>()
  next.forEach((row, index) => {
    indexByCode.set(String(row['器物编号']), index)
  })
  let maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const report: ImportReport = {
    packageId: pkg.packageId,
    total: pkg.records.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    keptLocal: 0,
    conflicts: [],
  }

  for (const rawRecord of pkg.records) {
    const record = normalizeRecord(rawRecord)
    const index = indexByCode.get(record.器物编号)
    if (index === undefined) {
      maxId += 1
      next.push(fromExchangeRecord(record, maxId))
      indexByCode.set(record.器物编号, next.length - 1)
      report.inserted += 1
      continue
    }
    const localRow = next[index]
    const localRev = Number(localRow.rev ?? 1)
    if (record.rev > localRev) {
      next[index] = mergedRow(localRow, record)
      report.updated += 1
      continue
    }
    if (record.rev < localRev) {
      report.keptLocal += 1
      report.conflicts.push({
        器物编号: record.器物编号,
        decision: `本地修订号 ${localRev} 高于封包 ${record.rev}，保留本地`,
      })
      continue
    }
    if (canonicalJson(toExchangeRecord(localRow)) === canonicalJson(record)) {
      report.unchanged += 1
      continue
    }
    const winner = arbitrate(localRow, record)
    if (winner === 'package') {
      next[index] = mergedRow(localRow, record)
      report.updated += 1
      report.conflicts.push({
        器物编号: record.器物编号,
        decision: `同为修订号 ${record.rev} 但内容不一致，封包状态更靠后或时间更晚，采用封包`,
      })
    } else {
      report.keptLocal += 1
      report.conflicts.push({
        器物编号: record.器物编号,
        decision: `同为修订号 ${record.rev} 但内容不一致，本地状态不落后，保留本地`,
      })
    }
  }
  return { next, report }
}

/** 从本地遗物台账生成封包对象。 */
export function buildExchangePackage(filters: ExchangeFilters): ExchangePackage {
  return buildPackageFromRows(listRows(ARTIFACT_KEY), filters)
}

/** 校验并导入封包，返回对账报告；校验不过会抛错，本地数据不动。 */
export function importExchangePackage(json: string): ImportReport {
  const pkg = parseExchangePackage(json)
  const { next, report } = mergePackageIntoRows(listRows(ARTIFACT_KEY), pkg)
  saveModules({ [ARTIFACT_KEY]: next })
  return report
}
