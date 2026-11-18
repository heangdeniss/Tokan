import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

/**
 * Shared contract between the server part (`index.ts`) and the TUI part
 * (`tui.tsx`). Side-effect free apart from defining the RPC.
 */
export const statsSchema = z.object({
  /** Whether the AST diet is active. */
  enabled: z.boolean(),
  /** Server hooks registered and stats RPC reachable. */
  hooksReady: z.boolean(),
  /** Read-tool hook invocations observed (dietable or not). */
  hookCalls: z.number().int().nonnegative(),
  /** Estimated tokens removed from AST-dieted reads. */
  tokensSaved: z.number().nonnegative(),
  /** Reads that were AST-dieted. */
  filesOptimized: z.number().int().nonnegative(),
  /** Diet-candidate reads inspected (qualified for size/path checks). */
  readsSeen: z.number().int().nonnegative(),
  /** Diet-candidate reads skipped (partial/small/short/low gain/unreadable). */
  readsSkipped: z.number().int().nonnegative(),
  /** Tokens saved by the most recent diet. */
  lastSavedTokens: z.number().nonnegative(),
  /** Skip counts by reason key. */
  skipReasons: z.record(z.string(), z.number().int().nonnegative()),
  /** Recent diet outcomes (newest first). */
  recent: z.array(z.object({
    file: z.string().optional(),
    reason: z.string().optional(),
    saved: z.number().nonnegative().optional(),
    at: z.number(),
  })),
  /** Why the last diet-candidate read was skipped, if any. */
  lastSkipReason: z.string().optional(),
  /** Most recently dieted file, if any. */
  lastFilePath: z.string().optional(),
  /** Epoch ms of last read-hook activity, if any. */
  lastHookAt: z.number().optional(),
  /** Effective diet thresholds. */
  minFileBytes: z.number().positive(),
  minFileLines: z.number().positive(),
  minSavedTokens: z.number().positive(),
  /** Configured fallback context window (tokens). */
  contextWindow: z.number().positive(),
  /** Configured USD price per million saved tokens. */
  pricePerMillion: z.number().nonnegative(),
  /** Optional daily spend budget in USD (0 = none). */
  dailyBudgetUsd: z.number().nonnegative(),
  /** tokensSaved / 1_000_000 * pricePerMillion. */
  costSaved: z.number().nonnegative(),
})

export type TokanStats = z.infer<typeof statsSchema>

export const Tokan = Rpc.define({
  id: "tokan",
  methods: {
    stats: {
      input: z.object({}),
      output: statsSchema,
    },
    reset: {
      input: z.object({}),
      output: statsSchema,
    },
    toggle: {
      input: z.object({}),
      output: statsSchema,
    },
  },
  events: {
    updated: {
      schema: statsSchema,
    },
  },
})
