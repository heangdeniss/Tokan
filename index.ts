import { Plugin } from "@opencode/plugin"
import type { Hooks as V1Hooks, Plugin as V1Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import {
  LANGUAGE_VERSION,
  MIN_COMPATIBLE_VERSION,
  Language,
  Parser,
  type Tree,
} from "web-tree-sitter"
import { Tokan, type TokanStats } from "./rpc.js"

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

interface TokanConfig {
  /** Only diet reads of files at least this large. */
  minFileBytes: number
  /** Only diet reads of files with at least this many lines. */
  minFileLines: number
  /** Do not report a diet unless it removes at least this many estimated tokens. */
  minSavedTokens: number
  /** Context window size used by the HUD bar. */
  contextWindow: number
  /** USD per 1,000,000 saved tokens. */
  pricePerMillion: number
  /** Master switch. */
  enabled: boolean
  /** Optional overrides for grammar WASM specifiers or paths. */
  wasmPaths: Readonly<Record<string, string>>
}

const DEFAULT_CONFIG: TokanConfig = {
  minFileBytes: 4_096,
  minFileLines: 120,
  minSavedTokens: 100,
  contextWindow: 200_000,
  pricePerMillion: 15,
  enabled: true,
  wasmPaths: {},
}

function readConfig(options: unknown): TokanConfig {
  const raw = (options ?? {}) as Record<string, unknown>
  const number = (key: keyof TokanConfig, fallback: number, minimum: number): number => {
    const value = Number(raw[key])
    return Number.isFinite(value) && value >= minimum ? value : fallback
  }
  const wasmPaths =
    typeof raw.wasmPaths === "object" && raw.wasmPaths !== null
      ? (raw.wasmPaths as Record<string, string>)
      : {}

  return {
    minFileBytes: number("minFileBytes", DEFAULT_CONFIG.minFileBytes, 1),
    minFileLines: number("minFileLines", DEFAULT_CONFIG.minFileLines, 1),
    minSavedTokens: number("minSavedTokens", DEFAULT_CONFIG.minSavedTokens, 1),
    contextWindow: number("contextWindow", DEFAULT_CONFIG.contextWindow, 1),
    pricePerMillion: number("pricePerMillion", DEFAULT_CONFIG.pricePerMillion, 0),
    enabled: raw.enabled !== false,
    wasmPaths,
  }
}

const debug = (...message: unknown[]): void => {
  if (process.env.TOKAN_DEBUG === "1") console.warn("[tokan]", ...message)
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface State {
  tokensUsed: number
  tokensSaved: number
  filesOptimized: number
  messagesTracked: number
  readsSeen: number
  readsSkipped: number
  lastSavedTokens: number
  lastFilePath?: string
  lastSkipReason?: string
}

const emptyState = (): State => ({
  tokensUsed: 0,
  tokensSaved: 0,
  filesOptimized: 0,
  messagesTracked: 0,
  readsSeen: 0,
  readsSkipped: 0,
  lastSavedTokens: 0,
})

function coerceState(value: unknown): State {
  if (typeof value !== "object" || value === null) return emptyState()
  const raw = value as Record<string, unknown>
  const finite = (key: string): number => {
    const candidate = Number(raw[key])
    return Number.isFinite(candidate) && candidate >= 0 ? candidate : 0
  }
  const state: State = {
    tokensUsed: finite("tokensUsed"),
    tokensSaved: finite("tokensSaved"),
    filesOptimized: Math.floor(finite("filesOptimized")),
    messagesTracked: Math.floor(finite("messagesTracked")),
    readsSeen: Math.floor(finite("readsSeen")),
    readsSkipped: Math.floor(finite("readsSkipped")),
    lastSavedTokens: finite("lastSavedTokens"),
  }
  if (typeof raw.lastFilePath === "string") state.lastFilePath = raw.lastFilePath
  if (typeof raw.lastSkipReason === "string") state.lastSkipReason = raw.lastSkipReason
  return state
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Cheap, deterministic token estimate (roughly four characters per token). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const lines = text.split("\n").length
  return Math.max(1, Math.ceil(text.length / 4) + Math.floor(lines / 10))
}

class TokanState {
  private state: State
  private readonly listeners = new Set<(snapshot: TokanStats) => void>()

  constructor(
    initial: State,
    private readonly config: TokanConfig,
    private readonly persist?: (snapshot: TokanStats) => void,
  ) {
    this.state = initial
  }

  snapshot(): TokanStats {
    const {
      tokensUsed,
      tokensSaved,
      filesOptimized,
      messagesTracked,
      readsSeen,
      readsSkipped,
      lastSavedTokens,
      lastFilePath,
      lastSkipReason,
    } = this.state
    const snapshot: TokanStats = {
      tokensUsed: Math.round(tokensUsed),
      tokensSaved: Math.round(tokensSaved),
      filesOptimized,
      messagesTracked,
      readsSeen,
      readsSkipped,
      lastSavedTokens: Math.round(lastSavedTokens),
      contextWindow: this.config.contextWindow,
      contextUsed: Math.min(1, tokensUsed / this.config.contextWindow),
      pricePerMillion: this.config.pricePerMillion,
      costSaved: round((tokensSaved / 1_000_000) * this.config.pricePerMillion),
      ...(lastFilePath ? { lastFilePath } : {}),
      ...(lastSkipReason ? { lastSkipReason } : {}),
    }
    return snapshot
  }

  mutate(update: (draft: State) => void): TokanStats {
    update(this.state)
    const snapshot = this.snapshot()
    try {
      this.persist?.(snapshot)
    } catch (error) {
      debug("failed to persist stats", error)
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        debug("stats listener failed", error)
      }
    }
    return snapshot
  }

  reset(): TokanStats {
    this.state = emptyState()
    return this.mutate(() => {})
  }

  onChange(listener: (snapshot: TokanStats) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/* -------------------------------------------------------------------------- */
/* Tree-sitter WASM loading                                                   */
/* -------------------------------------------------------------------------- */

const require = createRequire(import.meta.url)
const languageCache = new Map<string, Language>()
let runtimeInit: Promise<void> | undefined

const GRAMMARS: Readonly<Record<string, string>> = {
  ".ts": "tree-sitter-typescript/tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-typescript/tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".py": "tree-sitter-python/tree-sitter-python.wasm",
  ".go": "tree-sitter-go/tree-sitter-go.wasm",
  ".rs": "tree-sitter-rust/tree-sitter-rust.wasm",
}

function resolveWasm(specifier: string): string | undefined {
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

async function ensureRuntime(): Promise<void> {
  if (!runtimeInit) {
    const wasm = resolveWasm("web-tree-sitter/tree-sitter.wasm")
    const options = (wasm ? { locateFile: () => wasm } : undefined) as Parameters<typeof Parser.init>[0]
    runtimeInit = Parser.init(options).catch((error: unknown) => {
      runtimeInit = undefined
      throw error
    })
  }
  await runtimeInit
}

async function loadLanguage(extension: string, config: TokanConfig): Promise<Language> {
  const cached = languageCache.get(extension)
  if (cached) return cached

  await ensureRuntime()
  const specifier = config.wasmPaths[extension] ?? GRAMMARS[extension]
  if (!specifier) throw new Error(`No tree-sitter grammar configured for ${extension}`)

  const wasmPath = path.isAbsolute(specifier) ? specifier : resolveWasm(specifier) ?? specifier
  const bytes = await readFile(wasmPath)
  const language = await Language.load(bytes)

  if (
    language.abiVersion < MIN_COMPATIBLE_VERSION ||
    language.abiVersion > LANGUAGE_VERSION
  ) {
    throw new Error(
      `Grammar ABI ${language.abiVersion} incompatible with web-tree-sitter ${LANGUAGE_VERSION}`,
    )
  }

  languageCache.set(extension, language)
  return language
}

/* -------------------------------------------------------------------------- */
/* AST diet                                                                   */
/* -------------------------------------------------------------------------- */

interface Replacement {
  start: number
  end: number
  text: string
}

const OMITTED = "/* TOKAN: body omitted */"

function stripBody(node: import("web-tree-sitter").Node, source: string): string {
  const body = node.childForFieldName("body")
  if (!body) return node.text
  const header = source.slice(node.startIndex, body.startIndex).trimEnd()
  return `${header} { ${OMITTED} }`
}

function dietClass(node: import("web-tree-sitter").Node, source: string): string {
  const body = node.childForFieldName("body")
  if (!body) return node.text

  const header = source.slice(node.startIndex, body.startIndex).trimEnd()
  const members: string[] = []

  for (const member of body.namedChildren) {
    if (!member) continue
    switch (member.type) {
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature":
        members.push(`  ${stripBody(member, source).trim()}`)
        break
      case "field_definition":
      case "public_field_definition": {
        const equals = member.text.indexOf("=")
        members.push(
          equals >= 0
            ? `  ${member.text.slice(0, equals).trimEnd()} = undefined /* TOKAN: initializer omitted */;`
            : `  ${member.text.trim()}`,
        )
        break
      }
      case "static_block":
        members.push(`  static { ${OMITTED} }`)
        break
      case "comment":
        members.push(`  ${member.text.trim()}`)
        break
      default:
        members.push(
          member.endIndex - member.startIndex <= 240
            ? `  ${member.text.trim()}`
            : "  /* TOKAN: member omitted */",
        )
    }
  }

  return `${header} {\n${members.join("\n")}\n}`
}

function dietVariable(node: import("web-tree-sitter").Node, source: string): string {
  if (node.endIndex - node.startIndex <= 240) return node.text
  const declarators = node.namedChildren.filter(
    (child): child is import("web-tree-sitter").Node => child?.type === "variable_declarator",
  )
  if (declarators.length === 0) return node.text

  const first = declarators[0]!
  const prefix = source.slice(node.startIndex, first.startIndex).trimEnd()
  const lines = declarators.map((declarator) => {
    const name = declarator.childForFieldName("name")?.text ?? "value"
    const type = declarator.childForFieldName("type")?.text
    return `  ${name}${type ? `: ${type}` : ""} = undefined /* TOKAN: initializer omitted */,`
  })
  return `${prefix}\n${lines.join("\n")}\n`
}

function renderNode(node: import("web-tree-sitter").Node, source: string): string {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "method_definition":
      return stripBody(node, source)

    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
      return dietClass(node, source)

    case "lexical_declaration":
    case "variable_statement":
      return dietVariable(node, source)

    case "export_statement": {
      const declaration = node.childForFieldName("declaration")
      if (!declaration) return node.text
      const prefix = source.slice(node.startIndex, declaration.startIndex)
      return `${prefix}${renderNode(declaration, source)}`
    }

    default:
      return node.text
  }
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  let result = ""
  let cursor = 0
  for (const replacement of replacements) {
    if (replacement.start < cursor || replacement.end > source.length) continue
    result += source.slice(cursor, replacement.start) + replacement.text
    cursor = replacement.end
  }
  return result + source.slice(cursor)
}

async function dietWithAst(
  source: string,
  extension: string,
  config: TokanConfig,
): Promise<string> {
  const language = await loadLanguage(extension, config)
  const parser = new Parser()
  let tree: Tree | null = null

  try {
    parser.setLanguage(language)
    tree = parser.parse(source)
    if (!tree) throw new Error("tree-sitter returned no tree")

    const replacements: Replacement[] = []
    for (const child of tree.rootNode.namedChildren) {
      if (!child) continue
      replacements.push({
        start: child.startIndex,
        end: child.endIndex,
        text: renderNode(child, source),
      })
    }
    return applyReplacements(source, replacements)
  } finally {
    tree?.delete()
    parser.delete()
  }
}

/** Heuristic fallback used when a grammar WASM module is unavailable. */
function dietWithRegex(source: string): string {
  const lines = source.split("\n")
  const output: string[] = []
  let skipping = false
  let depth = 0

  const braces = (line: string): number =>
    (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)

  for (const line of lines) {
    if (skipping) {
      depth += braces(line)
      if (depth <= 0) skipping = false
      continue
    }

    const trimmed = line.trim()
    if (/^(import\b|export\s+(type|interface|declare)\b|interface\b|type\s+\w+\s*=|enum\b|declare\b)/.test(trimmed)) {
      output.push(line)
      continue
    }

    const functionSignature =
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function\s*)?[\w$]+\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/.test(line)
    const arrowSignature =
      /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/.test(line)

    if (functionSignature || arrowSignature) {
      output.push(`${line.replace(/\s*\{\s*$/, "")} { ${OMITTED} }`)
      skipping = true
      depth = 0
      continue
    }

    output.push(line)
  }

  return output.join("\n")
}

const DIET_HEADER = [
  "// ─────────────────────────────────────────────────────────────",
  "// TOKAN AST DIET: implementation bodies omitted to save context.",
  "// Imports, signatures, classes and type definitions are preserved.",
  "// ─────────────────────────────────────────────────────────────",
  "",
].join("\n")

interface PreparedDiet {
  filePath: string
  content: string
  savedTokens: number
}

type DietOutcome = PreparedDiet | { skip: string }

function dietSkip(value: DietOutcome): value is { skip: string } {
  return "skip" in value
}

function resolveReadPath(root: string, requested: string): string | undefined {
  const resolved = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(root, requested)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return resolved
}

function isDietCandidate(filePath: string, config: TokanConfig): boolean {
  if (!config.enabled) return false
  const extension = path.extname(filePath).toLowerCase()
  if (!(extension in GRAMMARS) && !(extension in config.wasmPaths)) return false

  const normalized = filePath.split(path.sep).join("/")
  if (/(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(normalized)) return false

  const basename = path.basename(filePath)
  if (
    basename.startsWith(".env") ||
    /\.(min\.(js|jsx|ts|tsx)|d\.ts|lock|pem|key|map|wasm)$/.test(basename)
  ) {
    return false
  }
  return true
}

async function prepareDiet(filePath: string, config: TokanConfig): Promise<DietOutcome> {
  let source: string
  try {
    source = await readFile(filePath, "utf8")
  } catch {
    return { skip: "unreadable" }
  }
  if (Buffer.byteLength(source, "utf8") < config.minFileBytes) return { skip: `small <${config.minFileBytes}B` }
  if (source.split("\n").length < config.minFileLines) return { skip: `short <${config.minFileLines}L` }

  let body: string
  try {
    body = await dietWithAst(source, path.extname(filePath).toLowerCase(), config)
  } catch (error) {
    debug("AST diet unavailable, using heuristic fallback", error)
    body = dietWithRegex(source)
  }

  const content = `${DIET_HEADER}${body}`
  const savedTokens = estimateTokens(source) - estimateTokens(content)
  if (savedTokens < config.minSavedTokens) return { skip: `low gain <${config.minSavedTokens}tok` }

  return { filePath, content, savedTokens }
}

interface ReadArgs {
  filePath?: string
  offset?: number
  limit?: number
}

function readArgs(input: unknown): ReadArgs | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const raw = input as Record<string, unknown>
  return {
    filePath: typeof raw.filePath === "string" ? raw.filePath : undefined,
    offset: typeof raw.offset === "number" ? raw.offset : undefined,
    limit: typeof raw.limit === "number" ? raw.limit : undefined,
  }
}

interface MutableResult {
  content?: string | ReadonlyArray<{ type?: string; text?: string }>
}

function replaceResultContent(result: unknown, content: string): void {
  const mutable = result as MutableResult
  if (typeof mutable.content === "string") {
    mutable.content = content
    return
  }
  if (Array.isArray(mutable.content)) {
    const textPart = mutable.content.find((part) => part?.type === "text" && typeof part.text === "string")
    if (textPart) {
      ;(textPart as { text: string }).text = content
      return
    }
  }
  mutable.content = content
}

function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  let text = ""
  for (const part of parts) {
    if (typeof part === "object" && part !== null) {
      const candidate = part as { type?: string; text?: string }
      if (candidate.type === "text" && typeof candidate.text === "string") text += candidate.text
    }
  }
  return text
}

/* -------------------------------------------------------------------------- */
/* V2 plugin                                                                  */
/* -------------------------------------------------------------------------- */

const serverPlugin = Plugin.define({
  id: "tokan",
  async setup(ctx) {
    const config = readConfig(ctx.options)
    const stored = await ctx.storage.get("stats").catch(() => undefined)
    const state = new TokanState(coerceState(stored), config, (snapshot) => {
      void ctx.storage.set("stats", snapshot).catch(() => {})
    })

    const registration = await ctx.rpc.register(Tokan, {
      stats: async () => state.snapshot(),
      reset: async () => state.reset(),
    })

    const unsubscribeState = state.onChange((snapshot) => {
      void registration.events.emit("updated", snapshot).catch((error: unknown) => {
        debug("failed to emit stats event", error)
      })
    })

    const pending = new Map<string, PreparedDiet>()

    // V1 name: tool.execute.before. V2 equivalent: ctx.tool.hook("execute.before").
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "read") return
      try {
        const args = readArgs(event.input)
        if (!args?.filePath) return
        const filePath = resolveReadPath(ctx.location.directory, args.filePath)
        if (!filePath || !isDietCandidate(filePath, config)) return

        if (args.offset !== undefined || args.limit !== undefined) {
          state.mutate((draft) => {
            draft.readsSeen += 1
            draft.readsSkipped += 1
            draft.lastSkipReason = "partial read"
          })
          return
        }

        const outcome = await prepareDiet(filePath, config)
        if (dietSkip(outcome)) {
          state.mutate((draft) => {
            draft.readsSeen += 1
            draft.readsSkipped += 1
            draft.lastSkipReason = outcome.skip
          })
          return
        }
        pending.set(String(event.id), outcome)
        state.mutate((draft) => {
          draft.readsSeen += 1
          delete draft.lastSkipReason
        })
      } catch (error) {
        debug("read interception failed", error)
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "read" || event.status !== "completed") return
      const prepared = pending.get(String(event.id))
      if (!prepared) return
      pending.delete(String(event.id))

      try {
        replaceResultContent(event.result, prepared.content)
        state.mutate((draft) => {
          draft.filesOptimized += 1
          draft.tokensSaved += prepared.savedTokens
          draft.lastSavedTokens = prepared.savedTokens
          draft.lastFilePath = path.basename(prepared.filePath)
          delete draft.lastSkipReason
        })
      } catch (error) {
        debug("failed to apply AST diet", error)
      }
    })

    // V1 name: chat.message. V2 equivalent: ctx.session.hook("prompt").
    await ctx.session.hook("prompt", (event) => {
      try {
        const text = messageText([{ type: "text", text: (event.prompt as { text?: string }).text ?? "" }])
        if (!text) return
        state.mutate((draft) => {
          draft.messagesTracked += 1
          draft.tokensUsed += estimateTokens(text)
        })
      } catch (error) {
        debug("message tracking failed", error)
      }
    })

    return () => {
      unsubscribeState()
      pending.clear()
    }
  },
})

/* -------------------------------------------------------------------------- */
/* V1 compatibility                                                           */
/* -------------------------------------------------------------------------- */

/**
 * OpenCode V1 loads the `server` member of a default export. V2 ignores it.
 * This keeps `opencode-tokan` usable on both major versions while the V2 API
 * above remains the primary implementation.
 */
const server: V1Plugin = async (input, options) => {
  const config = readConfig(options)
  const state = new TokanState(emptyState(), config)
  const pending = new Map<string, PreparedDiet>()

  const hooks: V1Hooks = {
    "tool.execute.before": async (call, output) => {
      if (call.tool !== "read") return
      try {
        const args = readArgs(output.args)
        if (!args?.filePath) return
        const filePath = resolveReadPath(input.directory, args.filePath)
        if (!filePath || !isDietCandidate(filePath, config)) return
        if (args.offset !== undefined || args.limit !== undefined) {
          state.mutate((draft) => {
            draft.readsSeen += 1
            draft.readsSkipped += 1
            draft.lastSkipReason = "partial read"
          })
          return
        }
        const outcome = await prepareDiet(filePath, config)
        if (dietSkip(outcome)) {
          state.mutate((draft) => {
            draft.readsSeen += 1
            draft.readsSkipped += 1
            draft.lastSkipReason = outcome.skip
          })
          return
        }
        pending.set(call.callID, outcome)
        state.mutate((draft) => {
          draft.readsSeen += 1
          delete draft.lastSkipReason
        })
      } catch (error) {
        debug("v1 read interception failed", error)
      }
    },

    "tool.execute.after": async (call, output) => {
      if (call.tool !== "read") return
      const prepared = pending.get(call.callID)
      if (!prepared) return
      pending.delete(call.callID)
      try {
        output.output = prepared.content
        output.title = "Tokan AST diet"
        state.mutate((draft) => {
          draft.filesOptimized += 1
          draft.tokensSaved += prepared.savedTokens
          draft.lastSavedTokens = prepared.savedTokens
          draft.lastFilePath = path.basename(prepared.filePath)
          delete draft.lastSkipReason
        })
      } catch (error) {
        debug("v1 diet application failed", error)
      }
    },

    "chat.message": async (_call, output) => {
      try {
        const text = messageText(output.parts)
        if (!text) return
        state.mutate((draft) => {
          draft.messagesTracked += 1
          draft.tokensUsed += estimateTokens(text)
        })
      } catch (error) {
        debug("v1 message tracking failed", error)
      }
    },

    dispose: async () => {
      pending.clear()
    },
  }

  return hooks
}

export default {
  ...serverPlugin,
  server,
}
