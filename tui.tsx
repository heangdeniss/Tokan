/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"
import { Tokan, type TokanStats } from "./rpc.js"

const EMPTY_STATS: TokanStats = {
  tokensUsed: 0,
  tokensSaved: 0,
  filesOptimized: 0,
  messagesTracked: 0,
  readsSeen: 0,
  readsSkipped: 0,
  lastSavedTokens: 0,
  contextWindow: 200_000,
  contextUsed: 0,
  pricePerMillion: 15,
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
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function frame(content: string): string {
  return `│ ${content.padEnd(WIDTH - 4)} │`
}

type SessionLike = {
  id: string
  title?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  time?: { updated?: number; busy?: number; idle?: number }
  location?: { directory?: string }
}

function sessionTotal(s: SessionLike): number {
  const t = s.tokens
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

function isBusy(s: SessionLike): boolean {
  const t = s.time
  if (!t) return false
  return (t.busy ?? 0) > (t.idle ?? 0)
}

function shortLabel(s: SessionLike, max: number): string {
  const dir = s.location?.directory?.split("/").filter(Boolean).pop() ?? ""
  const base = s.title?.trim() || dir || s.id.slice(-8)
  const prefix = isBusy(s) ? "● " : "· "
  const label = prefix + base
  return label.length > max ? label.slice(0, max - 1) + "…" : label
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
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
      cost += s.cost ?? 0
    }
  }
  return { count, tokens, cost }
}

function TokanHud(props: { stats: Accessor<TokanStats>; activeTotal: Accessor<number> }): JSX.Element {
  const context = usePlugin()
  const stats = props.stats

  const ratio = () => Math.min(1, props.activeTotal() / (stats().contextWindow || 200_000))
  const ctxFg = () =>
    ratio() >= 0.9
      ? context.theme.text.feedback.error.base
      : ratio() >= 0.7
        ? context.theme.text.feedback.warning.base
        : context.theme.text.base

  const status = () => {
    const s = stats()
    if (s.filesOptimized > 0) return "OPTIMIZING"
    if (s.readsSeen > 0) return "NO GAIN"
    return "STANDBY"
  }
  const statusFg = () => {
    const st = status()
    if (st === "OPTIMIZING") return context.theme.text.feedback.success.base
    if (st === "NO GAIN") return context.theme.text.feedback.warning.base
    return context.theme.text.muted
  }

  const dietLine = () => {
    const s = stats()
    if (s.filesOptimized === 0 && s.readsSkipped > 0) return `DIET  ${s.readsSeen} seen, ${s.readsSkipped} skip`
    return `DIET  ${s.filesOptimized}/${s.readsSeen} reads`
  }

  const lastLine = () => {
    const s = stats()
    if (s.filesOptimized > 0) {
      const file = s.lastFilePath ? ` ${s.lastFilePath}` : ""
      return `LAST  +${formatTokens(s.lastSavedTokens)}${file}`.slice(0, WIDTH - 4)
    }
    if (s.lastSkipReason) return `SKIP  ${s.lastSkipReason}`.slice(0, WIDTH - 4)
    return "SKIP  need >=4KB,120L,100tok".slice(0, WIDTH - 4)
  }
  const lastFg = () => {
    const s = stats()
    if (s.filesOptimized > 0) return context.theme.text.feedback.success.base
    if (s.readsSeen > 0 || s.lastSkipReason) return context.theme.text.feedback.warning.base
    return context.theme.text.muted
  }

  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame("TOKAN // DIET HUD")}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>

      <text fg={ctxFg()}>
        {frame(`CTX ${contextBar(ratio(), 10)} ${Math.round(ratio() * 100)}% ${formatTokens(props.activeTotal())}`)}
      </text>
      <text fg={context.theme.text.muted}>
        {frame(`PROMPT    ${formatTokens(stats().tokensUsed).padStart(9)} est`)}
      </text>
      <text fg={context.theme.text.feedback.success.base}>
        {frame(`SAVED     ${formatTokens(stats().tokensSaved).padStart(9)} tok`)}
      </text>
      <text fg={context.theme.text.feedback.success.base}>
        {frame(`SAVINGS   $${stats().costSaved.toFixed(2).padStart(9)}`)}
      </text>
      <text fg={context.theme.text.base}>{frame(dietLine())}</text>
      <text fg={lastFg()}>{frame(lastLine())}</text>
      <text fg={statusFg()}>
        {frame(`STATUS    ${status().padStart(9)}`)}
      </text>

      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

function UsageHud(props: {
  sessions: Accessor<SessionLike[]>
  burn: Accessor<number>
  window: Accessor<number>
}): JSX.Element {
  const context = usePlugin()
  const rows = () => props.sessions().slice(0, 6)
  const win = () => (props.window() > 0 ? props.window() : 200_000)
  const today = () => todayStats(props.sessions())
  const todayLine = () => {
    const t = today()
    const cost = t.cost > 0 ? ` $${t.cost.toFixed(2)}` : ""
    return `TODAY ${t.count}s ${formatTokens(t.tokens).padStart(6)}${cost}`.slice(0, WIDTH - 4)
  }

  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>
        {frame(props.burn() > 0 ? `USAGE // LIVE   +${formatTokens(props.burn())}` : "USAGE // LIVE")}
      </text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>
      <text fg={context.theme.text.base}>{frame(todayLine())}</text>
      {rows().length === 0 ? (
        <text fg={context.theme.text.muted}>{frame("No sessions")}</text>
      ) : (
        rows().map((s) => {
          const total = sessionTotal(s)
          const ratio = Math.min(1, total / win())
          const busy = isBusy(s)
          const barFg =
            ratio >= 0.9
              ? context.theme.text.feedback.error.base
              : ratio >= 0.7
                ? context.theme.text.feedback.warning.base
                : busy
                  ? context.theme.syntax.function
                  : context.theme.text.base
          return (
            <>
              <text fg={busy ? context.theme.text.feedback.warning.base : context.theme.text.muted}>
                {frame(shortLabel(s, WIDTH - 4))}
              </text>
              <text fg={barFg}>
                {frame(`${contextBar(ratio, 10)} ${String(Math.round(ratio * 100)).padStart(3)}% ${formatTokens(total)}`)}
              </text>
            </>
          )
        })
      )}
      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

export default Plugin.define({
  id: "tokan.tui",
  async setup(context) {
    const [stats, setStats] = createSignal<TokanStats>(EMPTY_STATS)
    const [sessions, setSessions] = createSignal<SessionLike[]>([])
    const [burn, setBurn] = createSignal(0)

    const refreshStats = async (): Promise<void> => {
      try {
        setStats(await context.client.rpc(Tokan).stats({}))
      } catch {
        // The server part may not be loaded yet (or the server may be down).
      }
    }
    let prevSum: number | undefined
    const refreshSessions = (): void => {
      try {
        const list = (context.data.session.list?.() ?? []) as SessionLike[]
        const sorted = [...list].sort((a, b) => {
          const db = (isBusy(b) ? 1 : 0) - (isBusy(a) ? 1 : 0)
          return db !== 0 ? db : (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        })
        const sum = sorted.reduce((n, s) => n + sessionTotal(s), 0)
        if (prevSum !== undefined) setBurn(sum > prevSum ? sum - prevSum : 0)
        prevSum = sum
        setSessions(sorted)
      } catch {
        // session data may be unavailable
      }
    }

    await refreshStats()
    refreshSessions()

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = context.client.rpc(Tokan).events.on("updated", (event) => {
        setStats(event.data)
      })
    } catch {
      // Live updates are best-effort; polling below keeps the HUD current.
    }

    let unlisten: (() => void) | undefined
    try {
      unlisten = context.data.listen(() => refreshSessions())
    } catch {
      // fallback to polling
    }

    const timer = setInterval(() => {
      void refreshStats()
      refreshSessions()
    }, 2_000)

    const activeTotal = () => sessionTotal(sessions()[0] ?? { id: "" })

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <>
          <TokanHud stats={stats} activeTotal={activeTotal} />
          <UsageHud sessions={sessions} burn={burn} window={() => stats().contextWindow} />
        </>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tokan.reset",
          title: "Reset Tokan savings HUD",
          group: "Tokan",
          palette: true,
          run: async () => {
            try {
              setStats(await context.client.rpc(Tokan).reset({}))
              context.ui.toast.show({ message: "Tokan stats reset", variant: "success" })
            } catch {
              context.ui.toast.show({ message: "Tokan server unavailable", variant: "warning" })
            }
          },
        },
      ],
    }))

    return () => {
      unsubscribe?.()
      unlisten?.()
      clearInterval(timer)
      unregisterSlot()
    }
  },
})
