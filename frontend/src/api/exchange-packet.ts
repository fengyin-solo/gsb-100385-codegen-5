import { listRows, loadPacketLedger, savePacketLedger, saveRowsTransaction } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { EntryRow } from '@/data/types'

/**
 * 出土遗物「外业交换封包」。
 *
 * 离线场景：工地设备按 器物编号 / 所属发掘区 / 出土层位 / 登记状态 挑出遗物，
 * 生成一个 JSON 封包（带封包级 SHA-256 摘要 + 每条记录的内容哈希），
 * 拷到室内设备导入后继续清洗、编号、入库，不需要网络和后端。
 *
 * 幂等模型见本文件 importArtifactPacket 的注释；冲突裁决规则见 resolveRevision。
 */

const ARTIFACT_KEY = 'artifact'
const PACKET_KIND = 'field-archaeology-artifact-packet'
const PACKET_VERSION = 1
const APP_VERSION = '1.0.0'
const DEVICE_KEY = 'field-archaeology-digital:device-id'

const artifactMeta = MODULE_BY_KEY.get(ARTIFACT_KEY)!
const CODE_FIELD = '器物编号'

// 参与封包与内容哈希的业务字段：meta 里登记的全部字段 + 工作流状态三件套。
// id、_rev、_updatedAt 不进哈希——它们是身份和版本元数据，不是遗物内容本身。
const ARTIFACT_FIELDS = artifactMeta.fields

export type ArtifactSelection = {
  /** 器物编号：片段包含 */
  code: string
  /** 所属发掘区：片段包含 */
  area: string
  /** 出土层位：片段包含 */
  layer: string
  /** 登记状态（工作流状态：已采集/已清洗/已编号/已入库/借出展示）：精确匹配，空串为不限 */
  status: string
}

export type ArtifactContent = {
  status: string
  pending: boolean
  abnormal: boolean
  fields: Record<string, string | number | boolean>
}

export type PacketArtifactRecord = {
  /** 来源设备里这条遗物的行 id，仅用于溯源；跨设备不保证唯一，身份永远以器物编号为准。 */
  sourceId: number
  code: string
  /** 封包版本：来源设备上这条记录的现场修订版本号（_rev）。 */
  rev: number
  updatedAt: string | null
  status: string
  pending: boolean
  abnormal: boolean
  fields: Record<string, string | number | boolean>
  /** 本记录业务内容（status/pending/abnormal/fields）的 SHA-256，导入端逐条复核。 */
  recordHash: string
}

export type ExchangePacket = {
  kind: typeof PACKET_KIND
  packetVersion: typeof PACKET_VERSION
  appVersion: string
  exportedAt: string
  sourceDevice: string
  selection: ArtifactSelection
  count: number
  records: PacketArtifactRecord[]
  /** 封包摘要：对除 checksum 外整个封包做规范化序列化后取 SHA-256。 */
  checksum: string
}

export type ImportDecision = 'inserted' | 'updatedFromPacket' | 'keptLocal' | 'unchanged'

export type ImportItemResult = {
  code: string
  decision: ImportDecision
  reason: string
  localRev: number
  packetRev: number
}

export type ImportReport = {
  ok: boolean
  message: string
  filename: string
  checksum: string
  sourceDevice: string
  exportedAt: string
  /** 这个封包（按摘要判定）以前是否已在本机装载过。 */
  repeated: boolean
  inserted: number
  updated: number
  keptLocal: number
  unchanged: number
  /** 业务数据已提交，但幂等台账写入失败（例如存储配额不足）。 */
  ledgerWarning: boolean
  items: ImportItemResult[]
}

// ---------------------------------------------------------------------------
// 哈希与规范化
// ---------------------------------------------------------------------------

/** 递归按 key 排序的 JSON 序列化：保证两端算出来的摘要逐字节一致。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function rowRev(row: EntryRow): number {
  return typeof row._rev === 'number' ? row._rev : 0
}

function pickContent(row: EntryRow): ArtifactContent {
  const fields: Record<string, string | number | boolean> = {}
  for (const field of ARTIFACT_FIELDS) {
    const value = row[field]
    if (value !== undefined) {
      fields[field] = value
    }
  }
  return {
    status: String(row.status ?? ''),
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    fields,
  }
}

function contentFromRecord(record: PacketArtifactRecord): ArtifactContent {
  return {
    status: record.status,
    pending: record.pending,
    abnormal: record.abnormal,
    fields: record.fields,
  }
}

async function hashContent(content: ArtifactContent): Promise<string> {
  return sha256Hex(stableStringify(content))
}

// ---------------------------------------------------------------------------
// 设备身份
// ---------------------------------------------------------------------------

export function getDeviceId(): string {
  const fallback = `DEV-${Date.now().toString(36).toUpperCase()}`
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const existed = window.localStorage.getItem(DEVICE_KEY)
  if (existed) {
    return existed
  }
  const random = new Uint8Array(4)
  crypto.getRandomValues(random)
  const id = `DEV-${[...random].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`
  window.localStorage.setItem(DEVICE_KEY, id)
  return id
}

// ---------------------------------------------------------------------------
// 挑选与导出
// ---------------------------------------------------------------------------

export function emptySelection(): ArtifactSelection {
  return { code: '', area: '', layer: '', status: '' }
}

/** 按器物编号、所属发掘区、出土层位（片段包含）和登记状态（精确）挑选出土遗物。 */
export function selectArtifacts(selection: ArtifactSelection): EntryRow[] {
  const code = selection.code.trim()
  const area = selection.area.trim()
  const layer = selection.layer.trim()
  const status = selection.status.trim()
  return listRows(ARTIFACT_KEY).filter((row) => {
    if (code && !String(row[CODE_FIELD] ?? '').includes(code)) {
      return false
    }
    if (area && !String(row['所属发掘区'] ?? '').includes(area)) {
      return false
    }
    if (layer && !String(row['出土层位'] ?? '').includes(layer)) {
      return false
    }
    if (status && String(row.status ?? '') !== status) {
      return false
    }
    return true
  })
}

/** 生成带校验摘要的离线封包。记录按器物编号排序，保证同一份数据反复导出摘要稳定。 */
export async function buildArtifactPacket(selection: ArtifactSelection): Promise<ExchangePacket> {
  const rows = selectArtifacts(selection).slice().sort((a, b) => {
    return String(a[CODE_FIELD] ?? '').localeCompare(String(b[CODE_FIELD] ?? ''))
  })
  const records: PacketArtifactRecord[] = []
  for (const row of rows) {
    const content = pickContent(row)
    records.push({
      sourceId: Number(row.id),
      code: String(row[CODE_FIELD] ?? ''),
      rev: rowRev(row),
      updatedAt: typeof row._updatedAt === 'string' ? row._updatedAt : null,
      ...content,
      recordHash: await hashContent(content),
    })
  }
  const body: Omit<ExchangePacket, 'checksum'> = {
    kind: PACKET_KIND,
    packetVersion: PACKET_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDevice: getDeviceId(),
    selection: { code: selection.code.trim(), area: selection.area.trim(), layer: selection.layer.trim(), status: selection.status.trim() },
    count: records.length,
    records,
  }
  const checksum = await sha256Hex(stableStringify(body))
  return { ...body, checksum }
}

export function packetFilename(packet: ExchangePacket): string {
  const stamp = packet.exportedAt.replace(/[-:T.Z]/g, '').slice(0, 14)
  return `出土遗物外业封包-${stamp}.json`
}

export function downloadArtifactPacket(packet: ExchangePacket): void {
  const blob = new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = packetFilename(packet)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

/**
 * 解析并校验封包：
 * 1. JSON 结构与 magic/版本号；2. 封包摘要整体复核；3. 每条记录的内容哈希复核。
 * 任何一项不过关都直接抛错——校验失败的封包一条数据都不许落库。
 */
export async function parseArtifactPacket(text: string): Promise<ExchangePacket> {
  let packet: ExchangePacket
  try {
    packet = JSON.parse(text) as ExchangePacket
  } catch {
    throw new Error('文件不是合法的 JSON，无法作为外业交换封包解析')
  }
  if (!packet || typeof packet !== 'object' || packet.kind !== PACKET_KIND) {
    throw new Error('文件不是出土遗物外业交换封包（缺少封包标识）')
  }
  if (packet.packetVersion !== PACKET_VERSION) {
    throw new Error(`封包格式版本 ${String(packet.packetVersion)} 与本机支持的版本 ${PACKET_VERSION} 不一致，拒绝导入`)
  }
  if (!Array.isArray(packet.records)) {
    throw new Error('封包结构损坏：records 不是数组')
  }
  if (packet.count !== packet.records.length) {
    throw new Error(`封包结构损坏：登记件数 ${packet.count} 与实际记录数 ${packet.records.length} 不一致`)
  }
  const { checksum, ...body } = packet
  const expectedChecksum = await sha256Hex(stableStringify(body))
  if (expectedChecksum !== String(checksum ?? '')) {
    throw new Error('封包校验摘要不一致：文件可能已损坏或被改动，拒绝导入')
  }
  for (const [index, record] of packet.records.entries()) {
    if (!record || typeof record !== 'object' || typeof record.code !== 'string' || !record.code) {
      throw new Error(`封包第 ${index + 1} 条记录缺少器物编号，拒绝导入`)
    }
    if (typeof record.rev !== 'number' || typeof record.sourceId !== 'number') {
      throw new Error(`封包第 ${index + 1} 条记录（${record.code}）版本信息损坏，拒绝导入`)
    }
    if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
      throw new Error(`封包记录 ${record.code} 的字段区损坏，拒绝导入`)
    }
    const expectedHash = await hashContent(contentFromRecord(record))
    if (expectedHash !== String(record.recordHash ?? '')) {
      throw new Error(`封包记录 ${record.code} 的内容哈希不一致：该条数据已损坏或被改动，整包拒绝导入`)
    }
  }
  return packet
}

// ---------------------------------------------------------------------------
// 版本冲突裁决
// ---------------------------------------------------------------------------

/**
 * 封包版本（记录 rev）与本地版本冲突时的裁决依据：
 *
 * 1. 修订版本号高的一方胜。_rev 是设备上这条记录每次被现场修改时单调递增的
 *    计数器，代表「这份内容基于更多次现场修改」，这是主裁决依据；
 * 2. 版本号相同（典型情形：同一基线在两台设备上各自只改了一次，或旧封包回流），
 *    比较记录的最近修改时间 _updatedAt，时间更晚的一方胜；
 * 3. 版本号和修改时间都相同（含双方都没有修改时间），保留本地这一份。
 *    这是刻意选择的保守策略：室内设备上的清洗/编号/入库劳动不被一个
 *    无法证明自己更新的外业封包静默覆盖，冲突结果会在导入报告里逐条列明。
 */
type RevisionWinner = { winner: 'packet' | 'local'; reason: string }

function resolveRevision(
  localRev: number,
  localUpdatedAt: string | null,
  packetRev: number,
  packetUpdatedAt: string | null,
): RevisionWinner {
  if (packetRev > localRev) {
    return { winner: 'packet', reason: `封包修订版本更高（封包 rev${packetRev} > 本地 rev${localRev}）` }
  }
  if (packetRev < localRev) {
    return { winner: 'local', reason: `本地修订版本更新（本地 rev${localRev} > 封包 rev${packetRev}），保留本地现场修改` }
  }
  if (packetUpdatedAt && localUpdatedAt && packetUpdatedAt > localUpdatedAt) {
    return {
      winner: 'packet',
      reason: `双方修订版本同为 rev${localRev}，封包修改时间更晚（${packetUpdatedAt} > ${localUpdatedAt}），按封包更新`,
    }
  }
  return {
    winner: 'local',
    reason:
      `双方修订版本同为 rev${localRev}` +
      (packetUpdatedAt && localUpdatedAt
        ? `，本地修改时间不更早（${localUpdatedAt} ≥ ${packetUpdatedAt}）`
        : '，且缺少可比较的修改时间') +
      '，按本地优先原则保留现场修改',
  }
}

// ---------------------------------------------------------------------------
// 幂等导入
// ---------------------------------------------------------------------------

/**
 * 导入封包。幂等保证：
 *
 * - 身份键是器物编号（业务键），不是行 id。同一条遗物无论装载多少次，
 *   本地始终只有一行：已存在就走裁决合并，不存在才新增；
 * - 封包内容与本地当前内容逐条比对（recordHash vs 本地内容哈希）：
 *   内容一致 → unchanged，什么都不写；
 *   内容不一致且封包胜出 → 覆盖业务内容；本地胜出 → 保留现场修改并在报告中
 *   逐条列出（keptLocal），绝不静默跳过；
 * - 同一封包反复装载：第一次插入/更新后，第二次起内容一致全部 unchanged，
 *   不会多出任何出土遗物；报告用 repeated 标明它是重复封包。
 *
 * 写入是单事务：遗物表整体校验、合并完成后一次性落库，中途任何一步抛错，
 * localStorage 与内存缓存都保持导入前的状态。
 */
export async function importArtifactPacket(text: string, filename = ''): Promise<ImportReport> {
  const packet = await parseArtifactPacket(text)

  const ledger = loadPacketLedger()
  const previous = ledger.seenPackets.find((item) => item.checksum === packet.checksum)

  const localRows = listRows(ARTIFACT_KEY)
  const byCode = new Map<string, EntryRow>()
  for (const row of localRows) {
    byCode.set(String(row[CODE_FIELD] ?? ''), row)
  }
  // 去重保护：封包内若意外出现重复器物编号，拒绝整包，不允许后一条顶掉前一条。
  const packetCodes = new Set<string>()
  for (const record of packet.records) {
    if (packetCodes.has(record.code)) {
      throw new Error(`封包内器物编号 ${record.code} 出现多次，无法判定以哪条为准，整包拒绝导入`)
    }
    packetCodes.add(record.code)
  }

  let nextId = localRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const nextRows = localRows.slice()
  const items: ImportItemResult[] = []
  const counters = { inserted: 0, updated: 0, keptLocal: 0, unchanged: 0 }

  for (const record of packet.records) {
    const local = byCode.get(record.code)

    if (!local) {
      nextId += 1
      const inserted: EntryRow = {
        id: nextId,
        status: record.status,
        pending: record.pending,
        abnormal: record.abnormal,
        _rev: record.rev,
        _updatedAt: record.updatedAt ?? undefined,
        ...record.fields,
      }
      nextRows.push(inserted)
      byCode.set(record.code, inserted)
      counters.inserted += 1
      items.push({
        code: record.code,
        decision: 'inserted',
        reason: '本地无此器物编号，作为新记录登记',
        localRev: 0,
        packetRev: record.rev,
      })
      continue
    }

    const localRev = rowRev(local)
    const localUpdatedAt = typeof local._updatedAt === 'string' ? local._updatedAt : null
    const localHash = await hashContent(pickContent(local))

    if (localHash === record.recordHash) {
      counters.unchanged += 1
      items.push({
        code: record.code,
        decision: 'unchanged',
        reason: '本地内容与封包完全一致，重复装载不再写入',
        localRev,
        packetRev: record.rev,
      })
      continue
    }

    const verdict = resolveRevision(localRev, localUpdatedAt, record.rev, record.updatedAt)
    const index = nextRows.findIndex((row) => Number(row.id) === Number(local.id))
    if (verdict.winner === 'packet') {
      nextRows[index] = {
        ...local,
        ...record.fields,
        status: record.status,
        pending: record.pending,
        abnormal: record.abnormal,
        _rev: Math.max(localRev, record.rev),
        _updatedAt: record.updatedAt ?? localUpdatedAt ?? undefined,
      }
      counters.updated += 1
      items.push({
        code: record.code,
        decision: 'updatedFromPacket',
        reason: `内容不一致，${verdict.reason}，按封包更新`,
        localRev,
        packetRev: record.rev,
      })
    } else {
      counters.keptLocal += 1
      items.push({
        code: record.code,
        decision: 'keptLocal',
        reason: `内容不一致，${verdict.reason}，未被跳过`,
        localRev,
        packetRev: record.rev,
      })
    }
  }

  // 全部裁决完成后才统一提交：失败则遗物表原样不动（本功能只写 artifact 一个模块）。
  saveRowsTransaction({ [ARTIFACT_KEY]: nextRows })

  for (const record of packet.records) {
    ledger.artifacts[record.code] = {
      rev: record.rev,
      hash: record.recordHash,
      packetChecksum: packet.checksum,
    }
  }
  if (!previous) {
    ledger.seenPackets.push({ checksum: packet.checksum, importedAt: new Date().toISOString() })
  }
  const ledgerWarning = !savePacketLedger(ledger)

  const changed = counters.inserted + counters.updated
  const message =
    `封包来自设备 ${packet.sourceDevice}（导出于 ${packet.exportedAt}），共 ${packet.count} 条：` +
    `新增 ${counters.inserted} 条、按封包更新 ${counters.updated} 条、保留本地修改 ${counters.keptLocal} 条、内容一致未写入 ${counters.unchanged} 条。` +
    (changed === 0 ? '本次装载没有产生任何新增或覆盖。' : '')

  return {
    ok: true,
    message,
    filename,
    checksum: packet.checksum,
    sourceDevice: packet.sourceDevice,
    exportedAt: packet.exportedAt,
    repeated: Boolean(previous),
    ...counters,
    ledgerWarning,
    items,
  }
}
