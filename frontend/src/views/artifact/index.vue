<template>
  <section class="page" data-module="artifact">
    <header class="page-head">
      <div>
        <h2>出土遗物管理</h2>
        <p class="page-desc">维护出土遗物，围绕器物编号、所属发掘区、出土探方、出土层位、器物质地做登记、筛选与状态流转，支持外业交换封包离线携行。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记出土遗物</button>
        <button class="btn" type="button" @click="openExport">生成外业交换封包</button>
        <button class="btn" type="button" @click="openImport">导入外业交换封包</button>
        <button class="btn" type="button" @click="exportRows">导出出土遗物清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in textFilterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>登记状态</span>
        <select v-model="statusFilter">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions.filter((item) => item !== '办理入库')"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openCheckIn(row)">办理入库</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无出土遗物数据，可先登记出土遗物</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条出土遗物记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 生成外业交换封包 -->
    <div v-if="exportVisible" class="modal-mask" @click.self="exportVisible = false">
      <div class="modal">
        <div class="modal-head">
          <h3>生成外业交换封包</h3>
          <button class="modal-close" type="button" @click="exportVisible = false">×</button>
        </div>
        <div class="modal-body">
          <p class="hint-line">按器物编号、所属发掘区、出土层位（片段包含）和登记状态（精确）挑选出土遗物，生成带 SHA-256 校验摘要的离线文件。</p>
          <div class="form-grid">
            <label>
              <span>器物编号</span>
              <input v-model="selection.code" placeholder="如 ARTI-00" />
            </label>
            <label>
              <span>所属发掘区</span>
              <input v-model="selection.area" placeholder="如 Ⅰ区" />
            </label>
            <label>
              <span>出土层位</span>
              <input v-model="selection.layer" placeholder="如 第3层" />
            </label>
            <label>
              <span>登记状态</span>
              <select v-model="selection.status">
                <option value="">全部状态</option>
                <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
              </select>
            </label>
          </div>
          <p class="hint-line">当前条件命中 <strong>{{ selectionCount }}</strong> 条出土遗物。</p>
          <template v-if="pendingPacket">
            <p class="hint-line">封包已生成，可下载后拷到另一台设备导入：</p>
            <div class="checksum-line">封包摘要（SHA-256）：{{ pendingPacket.checksum }}</div>
            <p class="hint-line">
              来源设备 {{ pendingPacket.sourceDevice }} · 导出于 {{ pendingPacket.exportedAt }} · 共 {{ pendingPacket.count }} 条 ·
              格式版本 {{ pendingPacket.packetVersion }}
            </p>
          </template>
          <p v-if="exportError" class="error-text">{{ exportError }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="exportVisible = false">关闭</button>
          <button class="btn" type="button" :disabled="exportBuilding" @click="buildPacket">
            {{ exportBuilding ? '计算摘要中…' : '生成封包' }}
          </button>
          <button v-if="pendingPacket" class="btn primary" type="button" @click="downloadPacket">下载封包文件</button>
        </div>
      </div>
    </div>

    <!-- 导入外业交换封包 -->
    <div v-if="importVisible" class="modal-mask" @click.self="importVisible = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>导入外业交换封包</h3>
          <button class="modal-close" type="button" @click="importVisible = false">×</button>
        </div>
        <div class="modal-body">
          <p class="hint-line">
            导入按器物编号幂等合并：同一封包反复装载不会多出遗物；封包与本地记录内容不一致时，
            以修订版本号高者为准，版本相同看修改时间，再相同保留本地，裁决结果逐条列出。
          </p>
          <input ref="fileInput" type="file" accept="application/json,.json" @change="onFilePicked" />
          <p v-if="importBusy" class="hint-line">正在复核封包摘要与逐条哈希…</p>
          <p v-if="importError" class="error-text">{{ importError }}</p>
          <template v-if="report">
            <div class="report-summary">
              <div>{{ report.message }}</div>
              <div class="hint-line">封包摘要：<span class="checksum-line" style="display: inline">{{ report.checksum }}</span></div>
              <div v-if="report.repeated" class="warning-text">该封包此前已在本机装载过，本次为重复装载，没有产生重复遗物。</div>
              <div v-if="report.ledgerWarning" class="warning-text">警告：业务数据已提交，但幂等台账写入失败（可能是浏览器存储已满），请清理存储后重新装载同一封包。</div>
            </div>
            <table class="report-table">
              <thead>
                <tr><th>器物编号</th><th>裁决</th><th>本地/封包版本</th><th>说明</th></tr>
              </thead>
              <tbody>
                <tr v-for="item in report.items" :key="item.code">
                  <td>{{ item.code }}</td>
                  <td><span :class="['tag', tagClass(item.decision)]">{{ decisionLabel(item.decision) }}</span></td>
                  <td>rev {{ item.localRev }} / {{ item.packetRev }}</td>
                  <td>{{ item.reason }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="importVisible = false">关闭</button>
          <button class="btn primary" type="button" :disabled="!fileText || importBusy" @click="doImport">执行导入</button>
        </div>
      </div>
    </div>

    <!-- 办理入库（跨模块：选架位，遗物状态与架位件数同一事务提交） -->
    <div v-if="checkInVisible" class="modal-mask" @click.self="checkInVisible = false">
      <div class="modal">
        <div class="modal-head">
          <h3>办理入库：{{ checkInRow?.['器物编号'] }}</h3>
          <button class="modal-close" type="button" @click="checkInVisible = false">×</button>
        </div>
        <div class="modal-body">
          <p class="hint-line">选择目标库房架位。提交后遗物状态改为「已入库」，架位当前件数 +1、可用空间同步更新；任一写入失败两边一起退回。</p>
          <table class="data-table">
            <thead>
              <tr><th>选择</th><th>架位编号</th><th>库房</th><th>存放类别</th><th>当前/容纳</th><th>可用空间</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="shelf in shelves" :key="shelf.id">
                <td><input v-model="selectedShelfId" type="radio" name="shelf" :value="shelf.id" :disabled="shelf.unavailable" /></td>
                <td>{{ shelf.code }}</td>
                <td>{{ shelf.warehouse }}</td>
                <td>{{ shelf.category }}</td>
                <td>{{ shelf.current }}/{{ shelf.capacity }}</td>
                <td>{{ shelf.unavailable && Number.isNaN(shelf.available) ? '—' : shelf.available }}</td>
                <td>
                  <template v-if="shelf.unavailable"><span class="warning-text">{{ shelf.reason }}</span></template>
                  <template v-else>可存入</template>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="checkInError" class="error-text">{{ checkInError }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="checkInVisible = false">取消</button>
          <button class="btn primary" type="button" @click="confirmCheckIn">确认入库</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildArtifactPacket,
  downloadArtifactPacket,
  emptySelection,
  importArtifactPacket,
  selectArtifacts,
  type ArtifactSelection,
  type ExchangePacket,
  type ImportDecision,
  type ImportReport,
} from '@/api/exchange-packet'
import {
  checkInArtifact,
  downloadEntries,
  listEntries,
  listShelfOptions,
  moduleMeta,
  runAction as applyAction,
  type ShelfOption,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('artifact')
const columns = ["器物编号", "所属发掘区", "出土探方", "出土层位", "器物质地", "器物类型", "完残程度", "登记人", "登记状态"]
const actions = ["完成清洗", "分配编号", "办理入库"]
const statuses = ["已采集", "已清洗", "已编号", "已入库", "借出展示"]
const stats = [{ label: "遗物总数", value: 0 }, { label: "已入库数", value: 0 }, { label: "待清洗数", value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const textFilterFields = ["器物编号", "所属发掘区", "出土层位"]
const statusFilter = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '出土遗物登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    let matched = listEntries(meta.key, filters.value).items
    // 登记状态筛选走工作流 status，精确匹配
    if (statusFilter.value) {
      matched = matched.filter((row) => String(row.status) === statusFilter.value)
    }
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '出土遗物列表读取失败'
  }
}

// --- 外业交换封包：导出 -----------------------------------------------------

const exportVisible = ref(false)
const exportBuilding = ref(false)
const exportError = ref('')
const selection = ref<ArtifactSelection>(emptySelection())
const pendingPacket = ref<ExchangePacket | null>(null)
const selectionCount = computed(() => selectArtifacts(selection.value).length)

function openExport() {
  selection.value = emptySelection()
  pendingPacket.value = null
  exportError.value = ''
  exportVisible.value = true
}

async function buildPacket() {
  exportError.value = ''
  exportBuilding.value = true
  try {
    pendingPacket.value = await buildArtifactPacket(selection.value)
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : '封包生成失败'
  } finally {
    exportBuilding.value = false
  }
}

function downloadPacket() {
  if (pendingPacket.value) {
    downloadArtifactPacket(pendingPacket.value)
  }
}

// --- 外业交换封包：导入 -----------------------------------------------------

const importVisible = ref(false)
const importBusy = ref(false)
const importError = ref('')
const report = ref<ImportReport | null>(null)
const fileText = ref('')
const fileName = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

function openImport() {
  report.value = null
  fileText.value = ''
  fileName.value = ''
  importError.value = ''
  importVisible.value = true
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  fileName.value = file.name
  report.value = null
  importError.value = ''
  const reader = new FileReader()
  reader.onload = () => {
    fileText.value = typeof reader.result === 'string' ? reader.result : ''
  }
  reader.onerror = () => {
    importError.value = '文件读取失败，请重新选择封包文件'
  }
  reader.readAsText(file, 'utf-8')
}

async function doImport() {
  if (!fileText.value) {
    importError.value = '请先选择封包文件'
    return
  }
  importBusy.value = true
  importError.value = ''
  try {
    report.value = await importArtifactPacket(fileText.value, fileName.value)
    reload()
  } catch (error) {
    report.value = null
    importError.value = error instanceof Error ? error.message : '封包导入失败'
  } finally {
    importBusy.value = false
  }
}

function decisionLabel(decision: ImportDecision): string {
  return {
    inserted: '新增',
    updatedFromPacket: '按封包更新',
    keptLocal: '保留本地',
    unchanged: '一致未写入',
  }[decision]
}

function tagClass(decision: ImportDecision): string {
  return {
    inserted: 'tag-inserted',
    updatedFromPacket: 'tag-updated',
    keptLocal: 'tag-kept',
    unchanged: 'tag-unchanged',
  }[decision]
}

// --- 办理入库（跨模块事务） -------------------------------------------------

const checkInVisible = ref(false)
const checkInRow = ref<EntryRow | null>(null)
const shelves = ref<ShelfOption[]>([])
const selectedShelfId = ref<number | null>(null)
const checkInError = ref('')

function openCheckIn(row: EntryRow) {
  checkInRow.value = row
  checkInError.value = ''
  shelves.value = listShelfOptions()
  const firstAvailable = shelves.value.find((shelf) => !shelf.unavailable)
  selectedShelfId.value = firstAvailable ? firstAvailable.id : null
  checkInVisible.value = true
}

function confirmCheckIn() {
  checkInError.value = ''
  if (!checkInRow.value) {
    return
  }
  if (selectedShelfId.value === null) {
    checkInError.value = '请选择一个仍有可用空间的架位'
    return
  }
  const result = checkInArtifact(Number(checkInRow.value.id), selectedShelfId.value)
  if (!result.ok) {
    checkInError.value = result.message
    return
  }
  checkInVisible.value = false
  errorMessage.value = ''
  reload()
}

onMounted(reload)
</script>
