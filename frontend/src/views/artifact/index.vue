<template>
  <section class="page" data-module="artifact">
    <header class="page-head">
      <div>
        <h2>出土遗物管理</h2>
        <p class="page-desc">维护出土遗物，围绕器物编号、出土探方、出土层位、器物质地做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记出土遗物</button>
        <button class="btn" type="button" @click="exportRows">导出出土遗物清单</button>
      </div>
    </header>

    <section class="exchange-panel">
      <h3 class="exchange-title">外业交换封包</h3>
      <p class="exchange-desc">
        按器物编号、发掘区、出土层位、登记状态挑选遗物，生成带 SHA-256 校验摘要的离线封包文件；
        换一台设备导入后继续清洗、编号、入库。同一封包反复导入不会重复登记，也不会漏掉现场改过的记录；
        封包与本地版本冲突时按「修订号高者优先 → 状态更靠后者优先 → 修改时间更晚者优先 → 仍并列保留本地」裁决。
      </p>
      <form class="filter-bar" @submit.prevent="buildPackage">
        <label class="filter-item">
          <span>器物编号</span>
          <input v-model="exchangeFilters.器物编号" placeholder="如 ARTI-0001" />
        </label>
        <label class="filter-item">
          <span>发掘区</span>
          <input v-model="exchangeFilters.发掘区" placeholder="按出土探方/发掘区检索" />
        </label>
        <label class="filter-item">
          <span>出土层位</span>
          <input v-model="exchangeFilters.出土层位" placeholder="按出土层位检索" />
        </label>
        <label class="filter-item">
          <span>登记状态</span>
          <select v-model="exchangeFilters.登记状态">
            <option value="">全部状态</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <button class="btn primary" type="submit">生成封包</button>
      </form>
      <div class="import-bar">
        <input type="file" accept=".json,application/json" @change="onPackageFile" />
        <button class="btn" type="button" :disabled="!packageText" @click="runImport">导入封包</button>
      </div>
      <p v-if="exchangeMessage" class="exchange-message">{{ exchangeMessage }}</p>
      <ul v-if="importConflicts.length" class="conflict-list">
        <li v-for="item in importConflicts" :key="item.器物编号">
          {{ item.器物编号 }}：{{ item.decision }}
        </li>
      </ul>
    </section>

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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
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
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  downloadTextFile,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  buildExchangePackage,
  importExchangePackage,
  type ExchangeFilters,
  type ImportConflict,
} from '@/api/exchange'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('artifact')
const columns = ["器物编号", "出土探方", "出土层位", "器物质地", "器物类型", "完残程度", "登记人", "登记状态"]
const actions = ["完成清洗", "分配编号", "办理入库"]
const statuses = ["已采集", "已清洗", "已编号", "已入库", "借出展示"]
const stats = [{"label": "遗物总数", "value": 0}, {"label": "已入库数", "value": 0}, {"label": "待清洗数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const exchangeFilters = ref<ExchangeFilters>({ 器物编号: '', 发掘区: '', 出土层位: '', 登记状态: '' })
const exchangeMessage = ref('')
const importConflicts = ref<ImportConflict[]>([])
const packageText = ref('')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '出土遗物登记入口尚未接入审批流'
}

function buildPackage() {
  errorMessage.value = ''
  const pkg = buildExchangePackage(exchangeFilters.value)
  downloadTextFile(`${pkg.packageId}.json`, JSON.stringify(pkg, null, 2), 'application/json;charset=utf-8')
  exchangeMessage.value = `已生成封包 ${pkg.packageId}，共 ${pkg.count} 件，校验摘要 ${pkg.checksum.slice(0, 16)}…`
  importConflicts.value = []
}

function onPackageFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    packageText.value = String(reader.result ?? '')
    exchangeMessage.value = `已读取封包文件 ${file.name}，点击「导入封包」执行`
    importConflicts.value = []
  }
  reader.onerror = () => {
    exchangeMessage.value = `封包文件 ${file.name} 读取失败`
  }
  reader.readAsText(file)
}

function runImport() {
  errorMessage.value = ''
  try {
    const report = importExchangePackage(packageText.value)
    importConflicts.value = report.conflicts
    exchangeMessage.value = `封包 ${report.packageId} 导入完成：新增 ${report.inserted} 件，更新 ${report.updated} 件，无变化 ${report.unchanged} 件，保留本地 ${report.keptLocal} 件`
    packageText.value = ''
    reload()
  } catch (error) {
    importConflicts.value = []
    exchangeMessage.value = error instanceof Error ? error.message : '封包导入失败，本地数据未改动'
  }
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '出土遗物列表读取失败'
  }
}

onMounted(reload)
</script>
