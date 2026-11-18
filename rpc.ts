import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

/**
 * Shared, typed contract between the server part (`index.ts`) and the TUI part
 * (`tui.tsx`). This module is intentionally side-effect free apart from
 * defining the RPC so it is safe to import from either runtime.
 */
export const statsSchema = z.object({
  /** Estimated non-tool message tokens observed this session. */
  tokensUsed: z.number().nonnegative(),
  /** Estimated tokens removed from AST diet file reads. */
  tokensSaved: z.number().nonnegative(),
  /** Number of file reads that went through the AST diet. */
  filesOptimized: z.number().int().nonnegative(),
  /** Number of user messages observed. */
  messagesTracked: z.number().int().nonnegative(),
  /** Dietable read calls inspected. */
  readsSeen: z.number().int().nonnegative(),
  /** Dietable reads skipped (partial/small/short/low gain). */
  readsSkipped: z.number().int().nonnegative(),
  /** Tokens saved by the most recent diet. */
  lastSavedTokens: z.number().nonnegative(),
  /** Why the last dietable read was skipped, if any. */
  lastSkipReason: z.string().optional(),
  /** Model context window used by the HUD's context bar. */
  contextWindow: z.number().positive(),
  /** Context window utilization, clamped to [0, 1]. */
  contextUsed: z.number().min(0).max(1),
  /** Configured USD price per million tokens. */
  pricePerMillion: z.number().nonnegative(),
  /** tokensSaved / 1_000_000 * pricePerMillion. */
  costSaved: z.number().nonnegative(),
  /** Most recently dieted file, if any. */
  lastFilePath: z.string().optional(),
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
  },
  events: {
    updated: {
      schema: statsSchema,
    },
  },
})
