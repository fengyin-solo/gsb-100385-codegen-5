/* 行为验证（非自动化测试套件）：用 esbuild 把 TS 连同 @ 别名打成临时文件，在 Node 里
 * mock localStorage / crypto，验证外业封包的幂等、冲突裁决和入库跨模块事务。
 * 运行：node scripts/verify-packet.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'

const root = new URL('..', import.meta.url).pathname

let passed = 0
let failed = 0
function assert(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

async function loadFresh() {
  const dir = mkdtempSync(join(tmpdir(), 'packet-verify-'))
  const entry = join(dir, 'entry.ts')
  const outfile = join(dir, 'bundle.mjs')
  writeFileSync(entry, `
    export * as packet from '${root}/src/api/exchange-packet.ts'
    export * as service from '${root}/src/api/local-service.ts'
    export * as store from '${root}/src/data/local-store.ts'
  `)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    alias: { '@': join(root, 'src') },
    logLevel: 'silent',
  })

  const backing = new Map()
  const storage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => {
      backing.set(key, String(value))
    },
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  }
  globalThis.window = { localStorage: storage }
  globalThis.localStorage = storage
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }

  const mod = await import(pathToFileURL(outfile).href)
  return {
    ...mod.packet,
    ...mod.service,
    saveRows: mod.store.saveRows,
    listRows: mod.store.listRows,
    resetCache: mod.store.__resetCacheForTest,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const codeField = '器物编号'
function findRow(rows, code) {
  return rows.find((r) => String(r[codeField]) === code)
}
function findShelf(rows, id) {
  return rows.find((r) => Number(r.id) === id)
}

const api = await loadFresh()

// 准备：用可计算的真实数字架位替换种子数据，便于验证入库联动
api.saveRows('storage', [
  { id: 1, status: '正常使用', pending: true, abnormal: false, '架位编号': 'S1', '库房名称': '库一', '存放器物类别': '陶', '架位层数': 2, '容纳件数': 2, '当前件数': 0, '可用空间': 2, '管理人': '赵', '架位状态': '正常使用' },
  { id: 2, status: '已满', pending: true, abnormal: false, '架位编号': 'S2', '库房名称': '库一', '存放器物类别': '石', '架位层数': 1, '容纳件数': 1, '当前件数': 1, '可用空间': 0, '管理人': '赵', '架位状态': '已满' },
])
api.saveRows('artifact', [
  { id: 101, status: '已编号', pending: true, abnormal: false, '器物编号': 'A-1', '所属发掘区': 'Ⅰ区', '出土探方': 'T1', '出土层位': '第1层', '器物质地': '陶', '器物类型': '罐', '完残程度': '残', '登记人': '甲', '登记状态': 's1' },
])

// 1) 导出：选择条件 + 校验摘要
console.log('\n[1] 生成封包与校验摘要')
const packet = await api.buildArtifactPacket({ code: '', area: 'Ⅰ区', layer: '', status: '' })
assert(packet.count === 1, '按发掘区命中 1 条')
assert(/^[0-9a-f]{64}$/.test(packet.checksum), '封包带 64 位 SHA-256 摘要')
assert(/^[0-9a-f]{64}$/.test(packet.records[0].recordHash), '每条记录带内容哈希')
const packetText = JSON.stringify(packet)

// 摘要稳定性：同样数据再导出，记录哈希一致；抹平导出时刻后封包摘要也一致
const packet2 = await api.buildArtifactPacket({ code: '', area: 'Ⅰ区', layer: '', status: '' })
assert(packet2.records[0].recordHash === packet.records[0].recordHash, '同数据重复导出：记录哈希一致')
const { createHash } = await import('node:crypto')
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const bodyOf = (p) => {
  const { checksum, exportedAt, ...rest } = p
  return rest
}
// 与真实校验完全对齐：只剥 checksum，exportedAt 参与摘要
const packetBodyOf = (p) => {
  const { checksum, ...rest } = p
  return rest
}
assert(sha(stable(bodyOf(packet))) === sha(stable(bodyOf(packet2))), '抹平导出时刻后封包摘要完全一致')

// 2) 校验：篡改封包/篡改记录必须被拒绝
console.log('\n[2] 校验失败拒绝导入')
const tamperedWhole = JSON.parse(packetText)
tamperedWhole.sourceDevice = 'DEV-EVIL'
let threw = false
try { await api.importArtifactPacket(JSON.stringify(tamperedWhole)) } catch (e) { threw = true }
assert(threw, '改动封包体但不更新摘要 -> 封包摘要校验失败')

const tamperedRecord = JSON.parse(packetText)
tamperedRecord.records[0].fields['器物质地'] = '玉'
threw = false
try { await api.importArtifactPacket(JSON.stringify(tamperedRecord)) } catch (e) { threw = true }
assert(threw, '篡改单条记录内容 -> 记录哈希校验失败（整包拒绝）')

const wrongKind = JSON.parse(packetText)
wrongKind.kind = 'other'
wrongKind.checksum = 'x'
threw = false
try { await api.importArtifactPacket(JSON.stringify(wrongKind)) } catch (e) { threw = true }
assert(threw, '非封包文件被拒绝')

// 3) 新设备导入：清空 storage 模拟另一台设备，导入后不新增重复
console.log('\n[3] 首次导入与幂等')
{
  window.localStorage.clear()
  api.resetCache()
  // 新设备的种子里没有 A-1
  let rows = api.listRows('artifact')
  assert(!findRow(rows, 'A-1'), '导入前新设备没有 A-1')

  const r1 = await api.importArtifactPacket(packetText, 'p.json')
  rows = api.listRows('artifact')
  assert(r1.inserted === 1 && findRow(rows, 'A-1'), '首次导入新增 1 条 A-1')
  const idsAfterFirst = rows.map((r) => r.id)

  const r2 = await api.importArtifactPacket(packetText, 'p.json')
  rows = api.listRows('artifact')
  assert(r2.repeated === true, '同一封包再装载：标记 repeated')
  assert(r2.inserted === 0 && r2.unchanged === 1, '同一封包再装载：不新增、全部 unchanged')
  assert(JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(idsAfterFirst), '反复装载不会多出出土遗物')

  const r3 = await api.importArtifactPacket(packetText)
  assert(r3.inserted === 0 && r3.updated === 0, '第三次装载依然零写入')
}

// 4) 冲突裁决：封包版本更高 -> 更新；本地版本更高 -> 保留本地且不静默跳过
console.log('\n[4] 版本冲突裁决')
{
  window.localStorage.clear()
  api.resetCache()
  await api.importArtifactPacket(packetText)

  // 4a. 本地先修改（rev 升高），再导入旧封包：保留本地
  const localEdit = api.runAction('artifact', findRow(api.listRows('artifact'), 'A-1').id, '完成清洗')
  assert(localEdit.ok, '本地执行完成清洗成功')
  const afterLocal = findRow(api.listRows('artifact'), 'A-1')
  assert(afterLocal._rev === 1 && afterLocal.status === '已清洗', '本地修改后 _rev 升到 1')

  const rKeep = await api.importArtifactPacket(packetText)
  const stillLocal = findRow(api.listRows('artifact'), 'A-1')
  assert(rKeep.keptLocal === 1 && rKeep.inserted === 0, '旧封包（rev0）不覆盖本地（rev1），记为 keptLocal')
  assert(stillLocal.status === '已清洗' && stillLocal._rev === 1, '本地现场修改被保留、没有被跳过覆盖')
  assert(/本地修订版本更新/.test(rKeep.items[0].reason), '报告给出裁决依据')

  // 4b. 封包版本更高（模拟外业设备后续又改了两次）：按封包更新
  const newer = JSON.parse(packetText)
  const rec = newer.records[0]
  rec.rev = 3
  rec.status = '已编号'
  rec.pending = false
  rec.recordHash = sha(stable({ status: rec.status, pending: rec.pending, abnormal: rec.abnormal, fields: rec.fields }))
  const newerBody = packetBodyOf(newer)
  newer.checksum = sha(stable(newerBody))

  const rUpdate = await api.importArtifactPacket(JSON.stringify(newer))
  const afterUpdate = findRow(api.listRows('artifact'), 'A-1')
  assert(rUpdate.updated === 1, '封包 rev3 > 本地 rev1：按封包更新')
  assert(afterUpdate.status === '已编号' && afterUpdate._rev === 3, '本地内容被高版本封包覆盖，_rev 取 3')
}

// 5) 版本号相同：封包修改时间更晚 -> 封包胜；时间也相同/缺失 -> 本地胜
console.log('\n[5] 版本号相同的裁决')
{
  window.localStorage.clear()
  api.resetCache()
  await api.importArtifactPacket(packetText)

  // 本地 rev0 内容变一下（直接构造，不动 _rev）
  const rows = api.listRows('artifact')
  const idx = rows.findIndex((r) => String(r[codeField]) === 'A-1')
  rows[idx] = { ...rows[idx], status: '已清洗', _updatedAt: '2026-09-01T00:00:00.000Z' }
  api.saveRows('artifact', rows)

  const repack = (p) => {
    const n = JSON.parse(JSON.stringify(p))
    const rec = n.records[0]
    rec.updatedAt = '2026-09-02T00:00:00.000Z'
    rec.recordHash = sha(stable({ status: rec.status, pending: rec.pending, abnormal: rec.abnormal, fields: rec.fields }))
    n.checksum = sha(stable(packetBodyOf(n)))
    return JSON.stringify(n)
  }
  const later = repack(packet)
  const rLater = await api.importArtifactPacket(later)
  assert(rLater.updated === 1, 'rev 相同、封包修改时间更晚：按封包更新')

  // 再导一次同 rev 同内容会 unchanged；改为本地时间更晚：本地胜
  const rows2 = api.listRows('artifact')
  const i2 = rows2.findIndex((r) => String(r[codeField]) === 'A-1')
  rows2[i2] = { ...rows2[i2], status: '已清洗', _updatedAt: '2026-09-09T00:00:00.000Z' }
  api.saveRows('artifact', rows2)
  const rLocalTime = await api.importArtifactPacket(later)
  assert(rLocalTime.keptLocal === 1, 'rev 相同、本地修改时间更晚：保留本地')
}

// 6) 入库跨模块事务
console.log('\n[6] 办理入库：两模块联动 + 失败回退')
{
  window.localStorage.clear()
  api.resetCache()
  api.saveRows('storage', [
    { id: 1, status: '正常使用', pending: true, abnormal: false, '架位编号': 'S1', '库房名称': '库一', '存放器物类别': '陶', '架位层数': 2, '容纳件数': 2, '当前件数': 0, '可用空间': 2, '管理人': '赵', '架位状态': '正常使用' },
    { id: 2, status: '已满', pending: true, abnormal: false, '架位编号': 'S2', '库房名称': '库一', '存放器物类别': '石', '架位层数': 1, '容纳件数': 1, '当前件数': 1, '可用空间': 0, '管理人': '赵', '架位状态': '已满' },
    { id: 3, status: '正常使用', pending: true, abnormal: false, '架位编号': 'S3', '库房名称': '库二', '存放器物类别': '骨', '架位层数': 1, '容纳件数': 1, '当前件数': 0, '可用空间': 1, '管理人': '钱', '架位状态': '正常使用' },
  ])
  await api.importArtifactPacket(packetText)
  const artifactId = findRow(api.listRows('artifact'), 'A-1').id

  // 已满架位拒绝
  let r = api.checkInArtifact(artifactId, 2)
  assert(!r.ok && /已满/.test(r.message), '已满架位拒绝入库')
  assert(findRow(api.listRows('artifact'), 'A-1').status !== '已入库', '被拒绝时遗物状态不变')
  assert(findShelf(api.listRows('storage'), 2)['当前件数'] === 1, '被拒绝时架位件数不变')

  // 正常入库：两边同时更新
  r = api.checkInArtifact(artifactId, 1)
  assert(r.ok, '入库成功')
  const art = findRow(api.listRows('artifact'), 'A-1')
  const shelf = findShelf(api.listRows('storage'), 1)
  assert(art.status === '已入库', '遗物状态 -> 已入库')
  assert(shelf['当前件数'] === 1 && shelf['可用空间'] === 1, '架位当前件数 +1、可用空间同步 -1')

  // 重复入库拒绝
  r = api.checkInArtifact(artifactId, 1)
  assert(!r.ok && /重复入库/.test(r.message), '同一遗物不能重复入库')

  // 入库到恰好放满的架位：状态翻成「已满」
  api.saveRows('artifact', [...api.listRows('artifact'), { id: 202, status: '已编号', pending: true, abnormal: false, '器物编号': 'A-2', '所属发掘区': 'Ⅰ区', '出土层位': '第2层' }])
  r = api.checkInArtifact(202, 3)
  const s3 = findShelf(api.listRows('storage'), 3)
  assert(r.ok && s3['当前件数'] === 1 && s3['可用空间'] === 0 && s3.status === '已满', '最后一件入库后件数/可用空间更新且架位标记「已满」')

  // 存储写入失败：两边一起退回
  api.saveRows('artifact', [...api.listRows('artifact'), { id: 303, status: '已编号', pending: true, abnormal: false, '器物编号': 'A-3', '所属发掘区': 'Ⅰ区', '出土层位': '第2层' }])
  const before = JSON.stringify({ a: api.listRows('artifact'), s: api.listRows('storage') })
  const originalSetItem = window.localStorage.setItem.bind(window.localStorage)
  window.localStorage.setItem = (key) => {
    if (key === 'field-archaeology-digital:entries') throw new Error('QuotaExceededError')
    return originalSetItem(key)
  }
  r = api.checkInArtifact(303, 1)
  window.localStorage.setItem = originalSetItem
  assert(!r.ok && /两边一起退回|未改动/.test(r.message), '写入失败时返回回退提示')
  const after = JSON.stringify({ a: api.listRows('artifact'), s: api.listRows('storage') })
  assert(after === before, '写入失败后遗物与架位数据都停留在提交前（两边一起退回）')
}

api.cleanup?.()
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
