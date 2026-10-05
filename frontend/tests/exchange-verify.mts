// 外业交换封包 + 入库事务的行为验证。
// 运行方式（在 frontend/ 下）：npm run test:exchange
// （由 tests/run-exchange-verify.mjs 用 esbuild 打包本文件后在 node 里执行）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  buildExchangePackage,
  buildPackageFromRows,
  importExchangePackage,
  mergePackageIntoRows,
  parseExchangePackage,
  type ExchangePackage,
} from '@/api/exchange'
import { runAction, transact } from '@/api/local-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type { EntryRow } from '@/data/types'
import { canonicalJson, sha256Hex } from '@/utils/checksum'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// ── 1. SHA-256 与规范化 JSON ─────────────────────────────
assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
for (const sample of ['中文封包内容', 'ARTI-0001:已编号', 'x'.repeat(1000), '多行\n文本\t制表']) {
  assert.equal(sha256Hex(sample), createHash('sha256').update(sample, 'utf8').digest('hex'))
}
assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
assert.equal(canonicalJson({ a: [1, { c: true, b: 'x' }] }), '{"a":[1,{"b":"x","c":true}]}')
console.log('✓ 校验摘要：SHA-256 与规范序列化正确')

// ── 2. 导出挑选条件 ─────────────────────────────────────
const deviceA: EntryRow[] = clone(SEED_ROWS.artifact)
const pkgAll = buildPackageFromRows(deviceA, {})
assert.equal(pkgAll.count, 3)
assert.equal(buildPackageFromRows(deviceA, { 器物编号: 'ARTI-0001' }).count, 1)
assert.equal(buildPackageFromRows(deviceA, { 发掘区: '样例2' }).count, 1)
assert.equal(buildPackageFromRows(deviceA, { 出土层位: '样例3' }).count, 1)
const pkgNumbered = buildPackageFromRows(deviceA, { 登记状态: '已编号' })
assert.equal(pkgNumbered.count, 1)
assert.equal(pkgNumbered.records[0]['器物编号'], 'ARTI-0003')
assert.equal(buildPackageFromRows(deviceA, { 登记状态: '已入库' }).count, 0)
console.log('✓ 导出：器物编号/发掘区/出土层位/登记状态四种挑选条件生效')

// ── 3. 封包校验：损坏、篡改、格式不对都拒收 ───────────────
assert.equal(parseExchangePackage(JSON.stringify(pkgAll)).count, 3)
const tampered = clone(pkgAll) as ExchangePackage
tampered.records[0].status = '已入库'
assert.throws(() => parseExchangePackage(JSON.stringify(tampered)), /校验摘要/)
const wrongCount = clone(pkgAll) as ExchangePackage
wrongCount.count = 99
assert.throws(() => parseExchangePackage(JSON.stringify(wrongCount)), /条数/)
assert.throws(() => parseExchangePackage('{not json'), /JSON/)
assert.throws(() => parseExchangePackage(JSON.stringify({ format: 'other' })), /交换封包/)
console.log('✓ 校验：篡改、条数不符、非法 JSON、错误格式均被拒绝')

// ── 4. 幂等导入：同一封包反复装载不多出遗物 ───────────────
const deviceB: EntryRow[] = []
let result = mergePackageIntoRows(deviceB, pkgAll)
assert.equal(result.report.inserted, 3)
assert.equal(result.next.length, 3)
const afterFirst = result.next
result = mergePackageIntoRows(afterFirst, pkgAll)
assert.equal(result.report.inserted, 0)
assert.equal(result.report.updated, 0)
assert.equal(result.report.unchanged, 3)
assert.equal(result.next.length, 3)
assert.deepEqual(afterFirst.map((row) => Number(row.id)).sort(), [1, 2, 3])
console.log('✓ 幂等：第二次装载同一封包 0 新增、0 更新、3 无变化')

// ── 5. 现场改过的记录不会被跳过 ──────────────────────────
const aModified = clone(deviceA)
aModified[0] = { ...aModified[0], status: '已清洗', rev: 2, updatedAt: '2026-09-10T08:00:00.000Z' }
const pkgV2 = buildPackageFromRows(aModified, {})
result = mergePackageIntoRows(afterFirst, pkgV2)
assert.equal(result.report.updated, 1)
assert.equal(result.report.unchanged, 2)
const synced = result.next.find((row) => row['器物编号'] === 'ARTI-0001')
assert.equal(synced?.status, '已清洗')
assert.equal(Number(synced?.rev), 2)
result = mergePackageIntoRows(result.next, pkgV2)
assert.equal(result.report.updated, 0)
assert.equal(result.report.unchanged, 3)
console.log('✓ 同步：封包里修订号更高的现场修改被应用，再次装载转为无变化')

// ── 6. 本地更新的记录不被旧封包覆盖 ───────────────────────
const bLocal = clone(result.next)
const localIndex = bLocal.findIndex((row) => row['器物编号'] === 'ARTI-0001')
bLocal[localIndex] = { ...bLocal[localIndex], status: '已编号', rev: 3, updatedAt: '2026-09-11T08:00:00.000Z' }
result = mergePackageIntoRows(bLocal, pkgV2)
assert.equal(result.report.keptLocal, 1)
assert.equal(result.report.conflicts.length, 1)
assert.equal(result.next.find((row) => row['器物编号'] === 'ARTI-0001')?.status, '已编号')
console.log('✓ 冲突：本地修订号更高时保留本地，并给出裁决说明')

// ── 7. 同号不同内容的裁决：状态更靠后者优先 ───────────────
const localRow: EntryRow = { ...clone(SEED_ROWS.artifact[0]), rev: 2, updatedAt: '2026-09-10T00:00:00.000Z', status: '已清洗' }
const pkgRow = clone(localRow)
pkgRow.status = '已编号'
pkgRow['完残程度'] = '残'
const conflictPkg = buildPackageFromRows([pkgRow], {})
assert.equal(conflictPkg.records[0].rev, 2)
result = mergePackageIntoRows([localRow], conflictPkg)
assert.equal(result.report.updated, 1)
assert.equal(result.next[0].status, '已编号')
const localRowNewer: EntryRow = { ...clone(localRow), status: '已入库' }
const pkgRowOlder = { ...clone(pkgRow), status: '已清洗' }
result = mergePackageIntoRows([localRowNewer], buildPackageFromRows([pkgRowOlder], {}))
assert.equal(result.report.keptLocal, 1)
assert.equal(result.next[0].status, '已入库')
console.log('✓ 裁决：同修订号不同内容时，状态更靠后的一份胜出')

// ── 8. 入库事务：遗物与架位一起更新 ───────────────────────
resetRows('artifact')
resetRows('storage')
const okResult = runAction('artifact', 3, '办理入库')
assert.equal(okResult.ok, true, okResult.message)
const stored = listRows('artifact').find((row) => Number(row.id) === 3)
assert.equal(stored?.status, '已入库')
assert.equal(stored?.['存放架位'], 'STOR-0001')
assert.equal(Number(stored?.rev), 2)
const rack = listRows('storage').find((row) => row['架位编号'] === 'STOR-0001')
assert.equal(Number(rack?.['当前件数']), 13)
assert.equal(Number(rack?.['容纳件数']) - Number(rack?.['当前件数']), 27)
assert.equal(Number(rack?.rev), 2)
console.log('✓ 入库：遗物状态与架位当前件数同事务更新，可用空间 40-13=27')

// 重复入库：失败且两边都不再变化
const dupResult = runAction('artifact', 3, '办理入库')
assert.equal(dupResult.ok, false)
assert.equal(Number(listRows('storage').find((row) => row['架位编号'] === 'STOR-0001')?.['当前件数']), 13)

// 未编号不能直接入库
const earlyResult = runAction('artifact', 1, '办理入库')
assert.equal(earlyResult.ok, false)
assert.match(earlyResult.message, /清洗、编号/)

// ── 9. 入库事务：任一步失败两边一起退回 ───────────────────
resetRows('artifact')
resetRows('storage')
saveRows('storage', listRows('storage').map((row) => ({ ...row, status: '已满' })))
const artifactBefore = clone(listRows('artifact'))
const storageBefore = clone(listRows('storage'))
const noRackResult = runAction('artifact', 3, '办理入库')
assert.equal(noRackResult.ok, false)
assert.match(noRackResult.message, /没有可用架位/)
assert.deepEqual(listRows('artifact'), artifactBefore)
assert.deepEqual(listRows('storage'), storageBefore)
assert.throws(() =>
  transact(['artifact', 'storage'], (draft) => {
    draft.artifact[0].status = '已入库'
    draft.storage[0]['当前件数'] = 999
    throw new Error('模拟第二步写入失败')
  }),
)
assert.deepEqual(listRows('artifact'), artifactBefore)
assert.deepEqual(listRows('storage'), storageBefore)
console.log('✓ 回滚：无可用架位或中途抛错时，遗物与架位都保持原样')

// ── 10. 普通动作升修订号 + 整包自导入幂等 ─────────────────
resetRows('artifact')
const washResult = runAction('artifact', 1, '完成清洗')
assert.equal(washResult.ok, true)
assert.equal(Number(listRows('artifact').find((row) => Number(row.id) === 1)?.rev), 2)
const selfPkg = buildExchangePackage({})
const selfReport = importExchangePackage(JSON.stringify(selfPkg))
assert.equal(selfReport.inserted, 0)
assert.equal(selfReport.unchanged, 3)
assert.equal(listRows('artifact').length, 3)
console.log('✓ 动作流转会升修订号；本机封包导入本机全部无变化')

console.log('\n全部验证通过')
