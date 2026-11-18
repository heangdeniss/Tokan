/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Tokan, type TokanStats } from "./rpc.js"

const EMPTY_STATS: TokanStats = {
  enabled: true,
  hooksReady: false,
  hookCalls: 0,
  tokensSaved: 0,
  filesOptimized: 0,
  readsSeen: 0,
  readsSkipped: 0,
  lastSavedTokens: 0,
  skipReasons: {},
  recent: [],
  minFileBytes: 4096,
  minFileLines: 120,
  minSavedTokens: 100,
  contextWindow: 200_000,
  pricePerMillion: 15,
  dailyBudgetUsd: 0,
  costSaved: 0,
}

const WIDTH = 34

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

function contextBar(ratio: number, segments = 12): string {
  const filled = Math.round(clamp(ratio, 0, 1) * segments)
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`
}

function formatTokens(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return "0"
  const v = Math.abs(n)
  if (v >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`
  if (v >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function frame(content: string): string {
  return `│ ${content.padEnd(WIDTH - 4)} │`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

type SessionLike = {
  id: string
  title?: string
  model?: any
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  time?: { updated?: number; created?: number; busy?: number; idle?: number }
  location?: { directory?: string }
}

function sessionModel(s: SessionLike | undefined): any {
  if (!s) return undefined
  const a = s as any
  if (s.model) return s.model
  if (a.providerID || a.modelID) return { providerID: a.providerID, modelID: a.modelID }
  return a.modelRef ?? a.info?.model
}

function tokenObj(s: SessionLike | undefined): any {
  const a = s as any
  return s?.tokens ?? a?.usage ?? a?.token ?? a?.tokenUsage
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sessionTotal(s: SessionLike | undefined): number {
  const t = tokenObj(s)
  if (!t) return 0
  const sum = num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read) + num(t.cache?.write)
  if (sum > 0) return sum
  return num(t.total) || num(t.totalTokens) || 0
}

function sessionParts(s: SessionLike | undefined) {
  const t = tokenObj(s)
  return {
    input: num(t?.input),
    output: num(t?.output),
    reasoning: num(t?.reasoning),
    cacheRead: num(t?.cache?.read),
    cacheWrite: num(t?.cache?.write),
  }
}

function sessionCost(s: SessionLike | undefined): number {
  return num(s?.cost ?? (s as any)?.usage?.cost)
}

function isBusy(s: SessionLike): boolean {
  const t = s.time
  if (!t) return false
  return (t.busy ?? 0) > (t.idle ?? 0)
}

function shortLabel(s: SessionLike, max: number, active = false): string {
  const dir = s.location?.directory?.split("/").filter(Boolean).pop() ?? ""
  const base = s.title?.trim() || dir || s.id.slice(-8)
  const prefix = isBusy(s) ? "● " : active ? "› " : "· "
  const label = prefix + base
  return label.length > max ? label.slice(0, max - 1) + "…" : label
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

type DayBucket = { tokens: number; cost: number }
type UsageLedger = {
  days: Record<string, DayBucket>
  models?: Record<string, DayBucket>
  totals?: DayBucket
  last: Record<string, { tokens: number; cost: number }>
  ui?: { view?: string }
}

const LEDGER_PATH = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "tokan-usage.json")

function loadLedger(): UsageLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as any
    if (raw && typeof raw === "object") {
      const days: Record<string, DayBucket> = {}
      if (typeof raw.days === "object" && raw.days) {
        for (const [k, v] of Object.entries(raw.days as Record<string, any>)) {
          days[k] = { tokens: Number(v?.tokens) || 0, cost: Number(v?.cost) || 0 }
        }
      }
      const models: Record<string, DayBucket> = {}
      if (typeof raw.models === "object" && raw.models) {
        for (const [k, v] of Object.entries(raw.models as Record<string, any>)) {
          models[k] = { tokens: Number(v?.tokens) || 0, cost: Number(v?.cost) || 0 }
        }
      }
      const last: Record<string, { tokens: number; cost: number }> = {}
      if (typeof raw.last === "object" && raw.last) {
        for (const [k, v] of Object.entries(raw.last as Record<string, any>)) {
          last[k] = { tokens: Number(v?.tokens) || 0, cost: Number(v?.cost) || 0 }
        }
      }
      let totals: DayBucket
      if (typeof raw.totals === "object" && raw.totals) {
        totals = { tokens: Number(raw.totals.tokens) || 0, cost: Number(raw.totals.cost) || 0 }
      } else {
        let t = 0
        let c = 0
        for (const b of Object.values(days)) {
          t += b.tokens
          c += b.cost
        }
        totals = { tokens: t, cost: c }
      }
      return {
        days,
        models,
        totals,
        last,
        ui: typeof raw.ui === "object" && raw.ui ? raw.ui : undefined,
      }
    }
  } catch {}
  return { days: {}, models: {}, totals: { tokens: 0, cost: 0 }, last: {} }
}

function saveLedger(l: UsageLedger): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true })
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(l))
  } catch {}
}

function sampleLedger(ledger: UsageLedger, list: SessionLike[]): boolean {
  const today = dayKey(Date.now())
  const models = (ledger.models ??= {})
  const totals = (ledger.totals ??= { tokens: 0, cost: 0 })
  let changed = false
  const seen = new Set<string>()
  for (const s of list) {
    if (!s?.id) continue
    seen.add(s.id)
    const curTok = sessionTotal(s)
    const curCost = sessionCost(s)
    const prev = ledger.last[s.id]
    if (prev) {
      const dt = Math.max(0, curTok - (Number(prev.tokens) || 0))
      const dc = Math.max(0, curCost - (Number(prev.cost) || 0))
      if (dt > 0 || dc > 0) {
        const b = ledger.days[today] ?? (ledger.days[today] = { tokens: 0, cost: 0 })
        b.tokens += dt
        b.cost += dc
        totals.tokens += dt
        totals.cost += dc
        const label = modelLabel(sessionModel(s))
        const mb = models[label] ?? (models[label] = { tokens: 0, cost: 0 })
        mb.tokens += dt
        mb.cost += dc
        changed = true
      }
    }
    if (!prev || prev.tokens !== curTok || prev.cost !== curCost) {
      ledger.last[s.id] = { tokens: curTok, cost: curCost }
      changed = true
    }
  }
  // prune stale last entries not seen for long not tracked; keep simple
  if (Object.keys(ledger.last).length > 2000) {
    const keep: typeof ledger.last = {}
    for (const id of seen) if (ledger.last[id]) keep[id] = ledger.last[id]
    ledger.last = keep
    changed = true
  }
  pruneLedgerDays(ledger)
  pruneLedgerModels(ledger)
  return changed
}

function todayDelta(ledger: UsageLedger): { tokens: number; cost: number } {
  const b = ledger.days[dayKey(Date.now())]
  return b ? { tokens: b.tokens || 0, cost: b.cost || 0 } : { tokens: 0, cost: 0 }
}

function overallDelta(ledger: UsageLedger): { tokens: number; cost: number } {
  if (ledger.totals) return { tokens: ledger.totals.tokens || 0, cost: ledger.totals.cost || 0 }
  let tokens = 0
  let cost = 0
  for (const b of Object.values(ledger.days)) {
    tokens += b?.tokens || 0
    cost += b?.cost || 0
  }
  return { tokens, cost }
}

function dailyDeltaRows(ledger: UsageLedger, max = 5): { day: string; tokens: number; cost: number }[] {
  return Object.entries(ledger.days)
    .map(([day, b]) => ({ day, tokens: b?.tokens || 0, cost: b?.cost || 0 }))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, max)
}

function modelDeltaRows(ledger: UsageLedger): ModelUsage[] {
  const models = ledger.models || {}
  return Object.entries(models)
    .map(([model, b]) => ({ model, tokens: b?.tokens || 0, cost: b?.cost || 0, sessions: 0 }))
    .filter((m) => m.tokens > 0 || m.cost > 0)
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost)
}

function pruneLedgerDays(ledger: UsageLedger, keep = 90): void {
  const keys = Object.keys(ledger.days || {}).sort()
  if (keys.length <= keep) return
  for (const d of keys.slice(0, keys.length - keep)) delete ledger.days[d]
}

function pruneLedgerModels(ledger: UsageLedger, keep = 50): void {
  const entries = Object.entries(ledger.models || {})
  if (entries.length <= keep) return
  entries.sort((a, b) => (b[1]?.tokens || 0) - (a[1]?.tokens || 0) || (b[1]?.cost || 0) - (a[1]?.cost || 0))
  const out: Record<string, DayBucket> = {}
  for (const [k, v] of entries.slice(0, keep)) {
    if (v) out[k] = v
  }
  ledger.models = out
}

function todayStats(list: SessionLike[]): { count: number; tokens: number; cost: number } {
  const start = startOfToday()
  let count = 0
  let tokens = 0
  let cost = 0
  for (const s of list) {
    if ((s.time?.updated ?? 0) >= start) {
      count++
      tokens += sessionTotal(s)
      cost += sessionCost(s)
    }
  }
  return { count, tokens, cost }
}

function allTimeStats(list: SessionLike[]): { count: number; tokens: number; cost: number } {
  let tokens = 0
  let cost = 0
  for (const s of list) {
    tokens += sessionTotal(s)
    cost += sessionCost(s)
  }
  return { count: list.length, tokens, cost }
}

type ModelUsage = { model: string; tokens: number; cost: number; sessions: number }

function modelLabel(m: any): string {
  if (!m) return "unknown"
  let raw = ""
  if (typeof m === "string") raw = m
  else if (typeof m === "object") {
    const pid = m.providerID ?? m.provider ?? m.providerId
    const mid = m.modelID ?? m.id ?? m.model ?? m.modelId ?? m.name
    raw = pid && mid ? `${pid}/${mid}` : String(mid ?? pid ?? "")
  }
  if (!raw || raw === "undefined" || raw === "null") return "unknown"
  const parts = raw.split("/").filter(Boolean)
  return parts.length > 1 ? parts.slice(-2).join("/") : raw
}

function modelUsage(list: SessionLike[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>()
  for (const s of list) {
    const label = modelLabel(sessionModel(s))
    const cur = map.get(label) ?? { model: label, tokens: 0, cost: 0, sessions: 0 }
    cur.tokens += sessionTotal(s)
    cur.cost += sessionCost(s)
    cur.sessions += 1
    map.set(label, cur)
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost)
}

function modelKeys(m: any): string[] {
  if (!m) return []
  if (typeof m === "string") return [m]
  if (typeof m === "object") {
    const pid = m.providerID ?? m.provider ?? m.providerId
    const mid = m.modelID ?? m.id ?? m.model ?? m.modelId ?? m.name
    const keys: string[] = []
    if (pid && mid) {
      keys.push(`${pid}/${mid}`)
      keys.push(String(mid))
    } else if (mid) {
      keys.push(String(mid))
    }
    return keys
  }
  return []
}

function resolveWindow(s: SessionLike | undefined, map: Record<string, number>, fallback: number): number {
  for (const k of modelKeys(sessionModel(s))) {
    const w = map[k]
    if (typeof w === "number" && w > 0) return w
  }
  return fallback > 0 ? fallback : 200_000
}

// Per-turn context tokens (prompt occupancy proxy): last assistant usage after last completed compaction.
function turnContext(msgs: any[]): number | undefined {
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined
  let comp = -1
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m?.type === "compaction" && m?.status === "completed") comp = i
  }
  for (let i = msgs.length - 1; i > comp; i--) {
    const m = msgs[i]
    const isAssistant = m?.type === "assistant" || m?.role === "assistant"
    const t = isAssistant ? (m.tokens ?? m.usage ?? m.token) : undefined
    if (t) {
      const v = (Number(t.input) || 0) + (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0)
      if (Number.isFinite(v) && v >= 0) return v
    }
  }
  return undefined
}

function TokanHud(props: {
  stats: Accessor<TokanStats>
  active: Accessor<SessionLike | undefined>
  activeWindow: Accessor<number>
  turn: Accessor<number | undefined>
  serverOk: Accessor<boolean>
  lastOk: Accessor<number>
}): JSX.Element {
  const context = usePlugin()
  const stats = props.stats

  const cumTotal = () => sessionTotal(props.active())
  const parts = () => sessionParts(props.active())
  const pressure = () => {
    const turn = props.turn()
    if (typeof turn === "number") return { value: turn, mode: "turn" as const }
    if (props.active()) return { value: cumTotal(), mode: "est" as const }
    return { value: 0, mode: "none" as const }
  }
  const win = () => props.activeWindow() || stats().contextWindow || 200_000
  const raw = () => {
    const p = pressure()
    if (p.mode === "none" || win() <= 0) return 0
    return p.value / win()
  }
  const barRatio = () => clamp(raw(), 0, 1)
  const loadFg = () =>
    raw() >= 0.9
      ? context.theme.text.feedback.error.base
      : raw() >= 0.7
        ? context.theme.text.feedback.warning.base
        : context.theme.text.base

  const st = () => {
    const s = stats()
    if (!s.enabled) return { label: "Diet off", level: "off" as const }
    if (!props.serverOk()) return { label: "Server off", level: "warn" as const }
    if (!s.hooksReady) return { label: "Hooks unavailable", level: "warn" as const }
    if (raw() >= 0.9 && pressure().mode !== "none") return { label: "Near context limit", level: "warn" as const }
    if (s.filesOptimized > 0) return { label: "Saving tokens", level: "ok" as const }
    if (s.readsSeen > 0) return { label: "No savings yet", level: "warn" as const }
    if (s.hookCalls > 0) return { label: "Watching reads", level: "muted" as const }
    return { label: "Idle", level: "muted" as const }
  }
  const statusFg = () => {
    const level = st().level
    if (level === "ok") return context.theme.text.feedback.success.base
    if (level === "warn") return context.theme.text.feedback.warning.base
    if (level === "off") return context.theme.text.feedback.error.base
    return context.theme.text.muted
  }

  const savedLine = () => {
    const s = stats()
    if (s.filesOptimized > 0) {
      const avg = Math.round(s.tokensSaved / s.filesOptimized)
      return `Saved ${formatTokens(s.tokensSaved)} tok (~$${s.costSaved.toFixed(2)}, ${formatTokens(avg)}/file)`.slice(0, WIDTH - 4)
    }
    if (!s.enabled) return "Diet is off · use tokan.toggle".slice(0, WIDTH - 4)
    if (s.readsSeen > 0) return "No savings from recent reads".slice(0, WIDTH - 4)
    return undefined
  }

  const dietLine = () => {
    const s = stats()
    if (s.filesOptimized === 0 && s.readsSeen === 0) {
      if (s.hookCalls > 0) return `${s.hookCalls} reads seen · no dietable files`.slice(0, WIDTH - 4)
      return undefined
    }
    const pct = s.readsSeen > 0 ? Math.round((s.filesOptimized / s.readsSeen) * 100) : 0
    return `Dieted ${s.filesOptimized}/${s.readsSeen} files (${pct}%)`.slice(0, WIDTH - 4)
  }

  const reasonName = (k: string) =>
    ({ small: "too small", short: "too short", low: "low gain", partial: "partial read", disabled: "diet off", unreadable: "unreadable", other: "other" }[k] ?? k)

  const skipLine = () => {
    const s = stats()
    const parts = Object.entries(s.skipReasons || {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${v} ${reasonName(k)}`)
    return parts.length ? `Skipped: ${parts.join(", ")}`.slice(0, WIDTH - 4) : undefined
  }

  const lastLine = () => {
    const s = stats()
    const file = s.lastFilePath ? ` ${s.lastFilePath}` : ""
    if (s.filesOptimized > 0) return `Last: saved ${formatTokens(s.lastSavedTokens)} tok${file}`.slice(0, WIDTH - 4)
    if (s.lastSkipReason) return `Last: ${s.lastSkipReason}${file}`.slice(0, WIDTH - 4)
    if (!props.serverOk()) return "Server not connected"
    if (s.hookCalls === 0) return "No file reads observed yet"
    if (s.readsSeen === 0) return "Reads seen, but none dietable".slice(0, WIDTH - 4)
    return undefined
  }
  const lastFg = () => {
    const s = stats()
    if (s.filesOptimized > 0) return context.theme.text.feedback.success.base
    if (s.readsSeen > 0 || s.lastSkipReason) return context.theme.text.feedback.warning.base
    if (!props.serverOk()) return context.theme.text.feedback.error.base
    return context.theme.text.muted
  }

  const srvLine = () => {
    const s = stats()
    if (!props.serverOk()) return "Server: not connected"
    if (!s.hooksReady) return `Server: ok · hooks unavailable`.slice(0, WIDTH - 4)
    return `Server: ok · checked ${ago(props.lastOk())} ago`.slice(0, WIDTH - 4)
  }

  const loadLine = () => {
    const p = pressure()
    if (p.mode === "none") return "Context: no active session"
    const pct = Math.round(raw() * 100)
    const tag = p.mode === "turn" ? "This turn" : "Session est."
    return `${tag} ${contextBar(barRatio(), 7)} ${pct}%`.slice(0, WIDTH - 4)
  }
  const loadDetail = () => {
    const p = pressure()
    if (p.mode === "none") return undefined
    return `${formatTokens(p.value)} of ${formatTokens(win())} tokens used`.slice(0, WIDTH - 4)
  }

  const breakLine = () => {
    const p = parts()
    const cache = p.cacheRead + p.cacheWrite
    const r = p.reasoning > 0 ? ` r ${formatTokens(p.reasoning)}` : ""
    return `in ${formatTokens(p.input)} out ${formatTokens(p.output)} c ${formatTokens(cache)}${r}`.slice(0, WIDTH - 4)
  }

  const modelLine = () => {
    const m = modelLabel(sessionModel(props.active()))
    return m !== "unknown" ? `Model: ${m}`.slice(0, WIDTH - 4) : undefined
  }

  const saved = savedLine()
  const diet = dietLine()
  const skip = skipLine()
  const last = lastLine()
  const detail = loadDetail()
  const model = modelLine()
  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame("TOKAN // DIET")}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>

      <text fg={loadFg()}>{frame(loadLine())}</text>
      {detail ? <text fg={context.theme.text.muted}>{frame(detail)}</text> : <></>}
      <text fg={context.theme.text.muted}>{frame(breakLine())}</text>
      {model ? <text fg={context.theme.text.muted}>{frame(model)}</text> : <></>}
      {saved ? <text fg={stats().filesOptimized > 0 ? context.theme.text.feedback.success.base : context.theme.text.feedback.warning.base}>{frame(saved)}</text> : <></>}
      {diet ? <text fg={context.theme.text.base}>{frame(diet)}</text> : <></>}
      {skip ? <text fg={context.theme.text.feedback.warning.base}>{frame(skip)}</text> : <></>}
      {last ? <text fg={lastFg()}>{frame(last)}</text> : <></>}
      <text fg={props.serverOk() ? context.theme.text.muted : context.theme.text.feedback.error.base}>
        {frame(srvLine())}
      </text>
      <text fg={statusFg()}>{frame(`Status: ${st().label}`)}</text>

      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

function UsageHud(props: {
  sessions: Accessor<SessionLike[]>
  activeId: Accessor<string | undefined>
  activePerSec: Accessor<number>
  globalPerSec: Accessor<number>
  defaultWindow: Accessor<number>
  modelWindows: Accessor<Record<string, number>>
  todayDelta: Accessor<{ tokens: number; cost: number }>
  budget: Accessor<number>
}): JSX.Element {
  const context = usePlugin()
  const rows = () => props.sessions().slice(0, 5)
  const todayFallback = () => todayStats(props.sessions())
  const todayInfo = () => {
    const d = props.todayDelta()
    const hasDelta = d.tokens > 0 || d.cost > 0
    const t = hasDelta ? d : { tokens: todayFallback().tokens, cost: todayFallback().cost }
    const b = props.budget()
    return { t, hasDelta, count: todayFallback().count, over: b > 0 && t.cost > b, b }
  }
  const todayLine = () => {
    const { t, hasDelta, count, over, b } = todayInfo()
    const prefix = hasDelta ? "Today: +" : "Today: "
    let cost = t.cost > 0 ? ` $${t.cost.toFixed(2)}` : ""
    if (b > 0) {
      cost = t.cost > 0 ? ` $${t.cost.toFixed(2)}/$${b.toFixed(2)}` : ` $0.00/$${b.toFixed(2)}`
      if (over) cost += " over"
    } else if (t.cost > 0) {
      cost = ` · $${t.cost.toFixed(2)}`
    }
    return `${prefix}${formatTokens(t.tokens)} tok${cost} · ${count} sessions`.slice(0, WIDTH - 4)
  }
  const header = () => {
    const a = props.activePerSec()
    const g = props.globalPerSec()
    const active = props.sessions().find((x) => x.id === props.activeId())
    const m = modelLabel(sessionModel(active))
    const ms = m !== "unknown" ? ` · ${m.split("/").pop() ?? m}` : ""
    if (a > 0) return `USAGE // LIVE  +${formatTokens(a)}/s${ms}`.slice(0, WIDTH - 4)
    if (g > 0) return `USAGE // LIVE  ${formatTokens(g)}/s`.slice(0, WIDTH - 4)
    return "USAGE // LIVE"
  }
  const winFor = (s: SessionLike) => resolveWindow(s, props.modelWindows(), props.defaultWindow())

  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame(header())}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
      <text fg={todayInfo().over ? context.theme.text.feedback.warning.base : context.theme.text.base}>{frame(todayLine())}</text>
      {rows().length === 0 ? (
        <text fg={context.theme.text.muted}>{frame("No sessions yet")}</text>
      ) : (
        rows().map((s) => {
          const total = sessionTotal(s)
          const raw = winFor(s) > 0 ? total / winFor(s) : 0
          const busy = isBusy(s)
          const active = props.activeId() === s.id
          const c = sessionCost(s)
          const cost = c > 0 ? ` $${c.toFixed(2)}` : ""
          const barFg =
            raw >= 0.9
              ? context.theme.text.feedback.error.base
              : raw >= 0.7
                ? context.theme.text.feedback.warning.base
                : busy || active
                  ? context.theme.syntax.function
                  : context.theme.text.base
          const pct = `${Math.round(raw * 100)}%`
          const line = `${contextBar(clamp(raw, 0, 1), 8)} ${pct} ${formatTokens(total)}${cost}`
          const labelFg = busy
            ? context.theme.text.feedback.warning.base
            : active
              ? context.theme.text.base
              : context.theme.text.muted
          return (
            <>
              <text fg={labelFg}>{frame(shortLabel(s, WIDTH - 4, props.activeId() === s.id))}</text>
              <text fg={barFg}>{frame(line.slice(0, WIDTH - 4))}</text>
            </>
          )
        })
      )}
      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

function readPonytailMode(): string {
  try {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
    const p = path.join(base, "opencode", ".ponytail-active")
    const m = fs.readFileSync(p, "utf8").trim().toLowerCase()
    if (m === "lite" || m === "full" || m === "ultra" || m === "off") return m
  } catch {}
  return "unknown"
}

function TotalsHud(props: {
  sessions: Accessor<SessionLike[]>
  ponytail: Accessor<string>
  ledgerDays: Accessor<{ day: string; tokens: number; cost: number }[]>
  ledgerOverall: Accessor<{ tokens: number; cost: number }>
  budget: Accessor<number>
}): JSX.Element {
  const context = usePlugin()
  const visible = () => allTimeStats(props.sessions())
  const days = () => props.ledgerDays()
  const today = dayKey(Date.now())
  const pony = () => props.ponytail()

  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame("USAGE // OVERALL & DAILY")}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
      {(() => {
        const o = props.ledgerOverall()
        const has = o.tokens > 0 || o.cost > 0
        const t = has ? o : visible()
        const cost = t.cost > 0 ? ` · $${t.cost.toFixed(2)}` : ""
        const prefix = has ? "Overall: +" : "Overall: "
        const extra = has ? "" : ` · ${visible().count} sessions`
        return (
          <text fg={context.theme.text.base}>
            {frame(`${prefix}${formatTokens(t.tokens)} tok${cost}${extra}`.slice(0, WIDTH - 4))}
          </text>
        )
      })()}
      {(() => {
        const ds = days()
        if (ds.length < 2) return <></>
        const avgT = Math.round(ds.reduce((n, d) => n + d.tokens, 0) / ds.length)
        const avgC = ds.reduce((n, d) => n + d.cost, 0) / ds.length
        const c = avgC > 0 ? ` $${avgC.toFixed(2)}` : ""
        return <text fg={context.theme.text.muted}>{frame(`Avg (${ds.length}d): +${formatTokens(avgT)}${c}`.slice(0, WIDTH - 4))}</text>
      })()}
      {days().length === 0 ? (
        <text fg={context.theme.text.muted}>{frame("No daily history yet")}</text>
      ) : (
        days().map((d) => {
          const label = d.day === today ? "Today" : d.day.slice(5)
          const cost = d.cost > 0 ? ` $${d.cost.toFixed(2)}` : ""
          const b = d.day === today ? props.budget() : 0
          const over = b > 0 && d.day === today && d.cost > b
          const budget = b > 0 ? `/$${b.toFixed(2)}` : ""
          const mark = over ? " !" : ""
          const line = `${label.padEnd(6)} +${formatTokens(d.tokens)} tok${cost}${budget}${mark}`
          return (
            <text fg={over ? context.theme.text.feedback.warning.base : d.day === today ? context.theme.text.base : context.theme.text.muted}>
              {frame(line.slice(0, WIDTH - 4))}
            </text>
          )
        })
      )}
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
      {pony() !== "unknown" ? (
        <text fg={pony() === "off" ? context.theme.text.muted : context.theme.text.feedback.success.base}>
          {frame(`Ponytail: ${pony()}`)}
        </text>
      ) : (
        <></>
      )}
      <text fg={context.theme.text.muted}>{frame("Tip: tokan.view · resetLedger clears history")}</text>
      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

function ModelsHud(props: {
  sessions: Accessor<SessionLike[]>
  ledgerModels: Accessor<ModelUsage[]>
}): JSX.Element {
  const context = usePlugin()
  const d = () => {
    const liveAll = modelUsage(props.sessions()).filter((u) => u.tokens > 0 || u.cost > 0)
    if (liveAll.length > 0) {
      const sessions = liveAll.reduce((n, u) => n + u.sessions, 0)
      return { rows: liveAll.slice(0, 5), live: true, total: liveAll.length, sessions }
    }
    const hist = props.ledgerModels().filter((u) => u.tokens > 0 || u.cost > 0)
    return { rows: hist.slice(0, 5), live: false, total: hist.length, sessions: 0 }
  }
  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame("USAGE // BY MODEL")}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
      {(() => {
        const data = d()
        if (data.rows.length === 0) return <text fg={context.theme.text.muted}>{frame("No model usage yet")}</text>
        const hint = data.live ? `Visible · ${data.total} models` : `Saved history · ${data.total} models`
        return (
          <>
            <text fg={context.theme.text.muted}>{frame(hint)}</text>
            {data.rows.map((u) => {
              const cost = u.cost > 0 ? ` $${u.cost.toFixed(2)}` : ""
              const tok = data.live ? formatTokens(u.tokens) : `+${formatTokens(u.tokens)}`
              const line = `${u.model.slice(0, 12).padEnd(12)} ${tok.padStart(7)}${cost}`
              return <text fg={context.theme.text.base}>{frame(line.slice(0, WIDTH - 4))}</text>
            })}
          </>
        )
      })()}
      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

export default Plugin.define({
  id: "tokan.tui",
  async setup(context) {
    const [stats, setStats] = createSignal<TokanStats>(EMPTY_STATS)
    const [sessions, setSessions] = createSignal<SessionLike[]>([])
    const [activePerSec, setActivePerSec] = createSignal(0)
    const [globalPerSec, setGlobalPerSec] = createSignal(0)
    const [serverOk, setServerOk] = createSignal(false)
    const [lastOk, setLastOk] = createSignal(Date.now())
    const [modelWindows, setModelWindows] = createSignal<Record<string, number>>({})
    const [turnCtx, setTurnCtx] = createSignal<number | undefined>(undefined)
    const [activeId, setActiveId] = createSignal<string | undefined>(undefined)
    const [ponytail, setPonytail] = createSignal<string>(readPonytailMode())
    const ledger = loadLedger()
    const [ledgerDays, setLedgerDays] = createSignal(dailyDeltaRows(ledger))
    const [ledgerOverall, setLedgerOverall] = createSignal(overallDelta(ledger))
    const [ledgerToday, setLedgerToday] = createSignal(todayDelta(ledger))
    const [ledgerModels, setLedgerModels] = createSignal(modelDeltaRows(ledger))
    const [view, setView] = createSignal<string>((ledger.ui?.view as string) || "full")
    let ledgerDirty = false
    let ledgerLastSave = 0
    const flushLedger = (force = false) => {
      const now = Date.now()
      if (!ledgerDirty || (!force && now - ledgerLastSave < 10000)) return
      ledger.ui = { ...(ledger.ui || {}), view: view() }
      saveLedger(ledger)
      ledgerDirty = false
      ledgerLastSave = now
    }

    let lastOptimized = 0
    const refreshStats = async (): Promise<void> => {
      try {
        const s = await context.client.rpc(Tokan).stats({})
        setStats(s)
        setServerOk(true)
        setLastOk(Date.now())
        if (lastOptimized === 0) lastOptimized = s.filesOptimized
      } catch {
        setServerOk(false)
      }
    }

    const currentId = (): string | undefined => {
      try {
        const r = context.ui.router.current()
        return r?.type === "session" ? r.sessionID : undefined
      } catch {
        return undefined
      }
    }

    const pickActive = (list: SessionLike[]): SessionLike | undefined => {
      const id = currentId()
      return (id ? list.find((x) => x.id === id) : undefined) ?? list.find(isBusy) ?? list[0]
    }

    let prevActive = { id: "", sum: 0, t: 0 }
    let prevGlobal = { sum: 0, t: 0 }
    let budgetWarnedDay = ""
    const refreshSessions = (): void => {
      try {
        const list = (context.data.session.list?.() ?? []) as SessionLike[]
        const sorted = [...list].sort((a, b) => {
          const db = (isBusy(b) ? 1 : 0) - (isBusy(a) ? 1 : 0)
          return db !== 0 ? db : (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        })
        const now = Date.now()
        const gsum = sorted.reduce((n, s) => n + sessionTotal(s), 0)
        if (prevGlobal.t > 0) {
          const dt = (now - prevGlobal.t) / 1000
          const d = gsum - prevGlobal.sum
          setGlobalPerSec(dt > 0 && d > 0 ? d / dt : 0)
        }
        prevGlobal = { sum: gsum, t: now }

        const act = pickActive(sorted)
        setActiveId(act?.id)
        if (act) {
          const asum = sessionTotal(act)
          if (prevActive.id === act.id && prevActive.t > 0) {
            const dt = (now - prevActive.t) / 1000
            const d = asum - prevActive.sum
            setActivePerSec(dt > 0 && d > 0 ? d / dt : 0)
          } else {
            setActivePerSec(0)
          }
          prevActive = { id: act.id, sum: asum, t: now }
        } else {
          setActivePerSec(0)
          prevActive = { id: "", sum: 0, t: now }
        }

        // Per-turn context for active session (best-effort).
        try {
          if (act?.id) {
            const msgs = (context.data.session.message.list?.(act.id) ?? []) as any[]
            setTurnCtx(turnContext(msgs))
          } else {
            setTurnCtx(undefined)
          }
        } catch {
          setTurnCtx(undefined)
        }

        setSessions(sorted)
        if (sampleLedger(ledger, sorted)) {
          ledgerDirty = true
          setLedgerDays(dailyDeltaRows(ledger))
          setLedgerOverall(overallDelta(ledger))
          setLedgerToday(todayDelta(ledger))
          setLedgerModels(modelDeltaRows(ledger))
          flushLedger()
        }
        const b = stats().dailyBudgetUsd
        const td = todayDelta(ledger)
        const dk = dayKey(Date.now())
        if (b > 0 && td.cost > b && budgetWarnedDay !== dk) {
          budgetWarnedDay = dk
          context.ui.toast.show({ message: `Daily budget exceeded: $${td.cost.toFixed(2)} / $${b.toFixed(2)}`, variant: "warning" })
        }
      } catch {
        // session data may be unavailable
      }
    }

    const refreshModels = (): void => {
      try {
        const sources: any[] = [
          (context.data as any).location?.model?.list?.(),
          (context.data as any).model?.list?.(),
          (context.data as any).provider?.model?.list?.(),
        ]
        const providers = (context.data as any).provider?.list?.()
        if (Array.isArray(providers)) {
          for (const p of providers) {
            if (Array.isArray(p?.models)) sources.push(p.models)
            if (p?.models && typeof p.models === "object" && !Array.isArray(p.models)) {
              sources.push(Object.values(p.models))
            }
          }
        }
        const map: Record<string, number> = {}
        for (const src of sources) {
          if (!Array.isArray(src)) continue
          for (const m of src) {
            const lim = m?.limit?.context ?? m?.limit?.input ?? m?.context ?? m?.contextWindow ?? m?.maxContext
            if (typeof lim !== "number" || lim <= 0) continue
            const id = m?.modelID ?? m?.id ?? m?.name
            const pid = m?.providerID ?? m?.provider
            const keys = [
              pid && id ? `${pid}/${id}` : undefined,
              id,
              m?.modelID,
              m?.id,
            ].filter((x): x is string => typeof x === "string" && x.length > 0)
            for (const k of keys) map[k] = lim
          }
        }
        if (Object.keys(map).length) setModelWindows((prev) => ({ ...prev, ...map }))
      } catch {
        // model info may be unavailable
      }
    }

    await refreshStats()
    lastOptimized = stats().filesOptimized
    refreshSessions()
    refreshModels()

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = context.client.rpc(Tokan).events.on("updated", (event) => {
        const data = event.data
        if (data.filesOptimized > lastOptimized && data.lastFilePath) {
          context.ui.toast.show({
            message: `Dieted ${data.lastFilePath} −${formatTokens(data.lastSavedTokens)} tok`,
            variant: "success",
          })
        }
        lastOptimized = data.filesOptimized
        setStats(data)
        setServerOk(true)
        setLastOk(Date.now())
      })
    } catch {
      // Live updates are best-effort; polling below keeps the HUD current.
    }

    let unlisten: (() => void) | undefined
    try {
      unlisten = context.data.listen(() => {
        refreshSessions()
        refreshModels()
      })
    } catch {
      // fallback to polling
    }

    let tick = 0
    const timer = setInterval(() => {
      void refreshStats()
      refreshSessions()
      setPonytail(readPonytailMode())
      tick++
      if (tick % 30 === 0) refreshModels()
    }, 1_000)

    const activeSession = () => {
      const id = activeId()
      const list = sessions()
      return (id ? list.find((x) => x.id === id) : undefined) ?? pickActive(list)
    }
    const activeWindow = () => resolveWindow(activeSession(), modelWindows(), stats().contextWindow)

    const CompactHud = (): JSX.Element => {
      const context = usePlugin()
      const s = stats()
      const a = activePerSec()
      const g = globalPerSec()
      const d = ledgerToday()
      const rate = a > 0 ? `+${formatTokens(a)}/s` : g > 0 ? `${formatTokens(g)}/s` : "no activity"
      const act = activeSession()
      const p = (() => {
        const t = turnCtx()
        if (!act) return { text: "Context: none", ratio: 0 }
        const v = typeof t === "number" ? t : sessionTotal(act)
        const w = activeWindow() || s.contextWindow || 200000
        const ratio = w > 0 ? v / w : 0
        const pct = Math.round(ratio * 100)
        const tag = typeof t === "number" ? "Turn" : "Est."
        return { text: `${tag} ${pct}%`, ratio }
      })()
      const m = modelLabel(sessionModel(act))
      const model = m !== "unknown" ? ` · ${m.split("/").pop() ?? m}` : ""
      const b = s.dailyBudgetUsd
      const over = b > 0 && d.cost > b
      const todayLine = (() => {
        const base = `Today +${formatTokens(d.tokens)} tok`
        if (b > 0) return `${base} $${d.cost.toFixed(2)}/$${b.toFixed(2)}${over ? " !" : ""}`.slice(0, WIDTH - 4)
        if (d.cost > 0) return `${base} $${d.cost.toFixed(2)}`.slice(0, WIDTH - 4)
        return base.slice(0, WIDTH - 4)
      })()
      const pFg =
        p.ratio >= 0.9
          ? context.theme.text.feedback.error.base
          : p.ratio >= 0.7
            ? context.theme.text.feedback.warning.base
            : context.theme.text.base
      return (
        <>
          <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
          <text fg={context.theme.syntax.function}>{frame("TOKAN // COMPACT")}</text>
          <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
          <text fg={pFg}>{frame(`${p.text} · ${rate}`.slice(0, WIDTH - 4))}</text>
          <text fg={context.theme.text.muted}>{frame(`Model${model || ": -"}`.slice(0, WIDTH - 4))}</text>
          <text fg={context.theme.text.feedback.success.base}>{frame(`Saved ${formatTokens(s.tokensSaved)} tok (~$${s.costSaved.toFixed(2)})`.slice(0, WIDTH - 4))}</text>
          <text fg={over ? context.theme.text.feedback.warning.base : context.theme.text.base}>{frame(todayLine)}</text>
          <text fg={serverOk() && s.hooksReady ? context.theme.text.muted : context.theme.text.feedback.warning.base}>
            {frame(`Server ${serverOk() ? (s.hooksReady ? "ok" : "no hooks") : "off"} · ${view()}`.slice(0, WIDTH - 4))}
          </text>
          <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
        </>
      )
    }

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const v = view()
        if (v === "compact") return <CompactHud />
        return (
          <>
            {v === "full" || v === "diet" ? (
              <TokanHud
                stats={stats}
                active={activeSession}
                activeWindow={activeWindow}
                turn={turnCtx}
                serverOk={serverOk}
                lastOk={lastOk}
              />
            ) : (
              <></>
            )}
            {v === "full" || v === "usage" ? (
              <UsageHud
                sessions={sessions}
                activeId={activeId}
                activePerSec={activePerSec}
                globalPerSec={globalPerSec}
                defaultWindow={() => stats().contextWindow}
                modelWindows={modelWindows}
                todayDelta={ledgerToday}
                budget={() => stats().dailyBudgetUsd}
              />
            ) : (
              <></>
            )}
            {v === "full" || v === "total" ? (
              <TotalsHud
                sessions={sessions}
                ponytail={ponytail}
                ledgerDays={ledgerDays}
                ledgerOverall={ledgerOverall}
                budget={() => stats().dailyBudgetUsd}
              />
            ) : (
              <></>
            )}
            {v === "full" || v === "models" ? <ModelsHud sessions={sessions} ledgerModels={ledgerModels} /> : <></>}
          </>
        )
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tokan.toggle",
          title: "Toggle Tokan AST diet",
          group: "Tokan",
          palette: true,
          run: async () => {
            try {
              const next = await context.client.rpc(Tokan).toggle({})
              setStats(next)
              setServerOk(true)
              setLastOk(Date.now())
              context.ui.toast.show({
                message: `Tokan diet ${next.enabled ? "enabled" : "disabled"}`,
                variant: "info",
              })
            } catch {
              setServerOk(false)
              context.ui.toast.show({ message: "Tokan server unavailable", variant: "warning" })
            }
          },
        },
        {
          id: "tokan.reset",
          title: "Reset Tokan savings HUD",
          group: "Tokan",
          palette: true,
          run: async () => {
            try {
              const next = await context.client.rpc(Tokan).reset({})
              setStats(next)
              lastOptimized = 0
              setServerOk(true)
              setLastOk(Date.now())
              context.ui.toast.show({ message: "Tokan stats reset", variant: "success" })
            } catch {
              setServerOk(false)
              context.ui.toast.show({ message: "Tokan server unavailable", variant: "warning" })
            }
          },
        },
        {
          id: "tokan.view",
          title: "Switch Tokan HUD view",
          group: "Tokan",
          palette: true,
          run: () => {
            const order = ["full", "compact", "diet", "usage", "total", "models"]
            const i = order.indexOf(view())
            const next = order[(i + 1) % order.length]
            setView(next)
            ledgerDirty = true
            flushLedger(true)
            context.ui.toast.show({ message: `Tokan view: ${next}`, variant: "info" })
          },
        },
        {
          id: "tokan.resetLedger",
          title: "Reset Tokan usage history",
          group: "Tokan",
          palette: true,
          run: () => {
            ledger.days = {}
            ledger.models = {}
            ledger.totals = { tokens: 0, cost: 0 }
            ledger.last = {}
            setLedgerDays([])
            setLedgerOverall({ tokens: 0, cost: 0 })
            setLedgerToday({ tokens: 0, cost: 0 })
            setLedgerModels([])
            budgetWarnedDay = ""
            ledgerDirty = true
            flushLedger(true)
            context.ui.toast.show({ message: "Tokan usage history reset", variant: "success" })
          },
        },
        {
          id: "tokan.ledgerPath",
          title: "Show Tokan usage ledger path",
          group: "Tokan",
          palette: true,
          run: () => {
            context.ui.toast.show({ message: LEDGER_PATH, variant: "info" })
          },
        },
        {
          id: "tokan.summary",
          title: "Show Tokan usage summary",
          group: "Tokan",
          palette: true,
          run: () => {
            const s = stats()
            const t = ledgerToday()
            const o = ledgerOverall()
            const msg = `Today +${formatTokens(t.tokens)} $${t.cost.toFixed(2)} · Overall +${formatTokens(o.tokens)} · Saved ${formatTokens(s.tokensSaved)} tok $${s.costSaved.toFixed(2)}`
            context.ui.toast.show({ message: msg, variant: "info" })
          },
        },
      ],
    }))

    return () => {
      flushLedger(true)
      unsubscribe?.()
      unlisten?.()
      clearInterval(timer)
      unregisterSlot()
    }
  },
})
