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

function TokanHud(props: { stats: Accessor<TokanStats> }): JSX.Element {
  const context = usePlugin()
  const stats = props.stats

  return (
    <>
      <text fg={context.theme.syntax.function}>{`┌${"─".repeat(WIDTH - 2)}┐`}</text>
      <text fg={context.theme.syntax.function}>{frame("TOKAN // DIET HUD")}</text>
      <text fg={context.theme.border.base}>{`├${"─".repeat(WIDTH - 2)}┤`}</text>

      <text fg={context.theme.text.base}>
        {frame(`CTX  ${contextBar(stats().contextUsed)} ${Math.round(stats().contextUsed * 100)}%`)}
      </text>
      <text fg={context.theme.text.muted}>
        {frame(`USED      ${formatTokens(stats().tokensUsed).padStart(9)} tok`)}
      </text>
      <text fg={context.theme.text.feedback.success.base}>
        {frame(`SAVED     ${formatTokens(stats().tokensSaved).padStart(9)} tok`)}
      </text>
      <text fg={context.theme.text.feedback.success.base}>
        {frame(`SAVINGS   $${stats().costSaved.toFixed(2).padStart(9)}`)}
      </text>
      <text fg={context.theme.text.base}>
        {frame(`AST DIET  ${String(stats().filesOptimized).padStart(9)} files`)}
      </text>
      <text fg={context.theme.text.muted}>
        {frame(`RATE      $${stats().pricePerMillion}/1M tok`)}
      </text>
      <text fg={context.theme.syntax.string}>
        {frame(`STATUS    ${stats().filesOptimized > 0 ? "OPTIMIZING" : "STANDBY"}`)}
      </text>

      <text fg={context.theme.border.base}>{`└${"─".repeat(WIDTH - 2)}┘`}</text>
    </>
  )
}

export default Plugin.define({
  id: "tokan.tui",
  async setup(context) {
    const [stats, setStats] = createSignal<TokanStats>(EMPTY_STATS)

    const refresh = async (): Promise<void> => {
      try {
        setStats(await context.client.rpc(Tokan).stats({}))
      } catch {
        // The server part may not be loaded yet (or the server may be down).
      }
    }
    await refresh()

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = context.client.rpc(Tokan).events.on("updated", (event) => {
        setStats(event.data)
      })
    } catch {
      // Live updates are best-effort; polling below keeps the HUD current.
    }

    const timer = setInterval(() => void refresh(), 2_000)

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => <TokanHud stats={stats} />,
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
      clearInterval(timer)
      unregisterSlot()
    }
  },
})
