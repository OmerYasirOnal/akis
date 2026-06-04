import type { SharedContext } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { ApprovedSpec } from '../../gates/specGate.js'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'
import { parseAIJson } from './critic/json-extract.js'
import { renderKnowledge } from './context-prompt.js'

export interface ProtoInput {
  sessionId: string
  laneId: string
  /** Gate 1: Proto cannot run without an ApprovedSpec token (only approve() mints it). */
  approved: ApprovedSpec
  feedback?: string
  /** Read view of the shared context (F2-AC16). Data only — no gate capability. */
  ctx?: SharedContext
  /**
   * EDIT MODE (Phase B.5): the existing app this build edits. When present, Proto sees the
   * current files and is instructed to return ONLY the files it changes or adds (full
   * contents each) — the orchestrator merges them over this base. Data only, no capability.
   */
  baseFiles?: RepoFile[]
}

/** Render the existing app for EDIT MODE: the current files + strict edit semantics. */
function renderBase(files: RepoFile[]): string {
  const listing = files.map(f => `--- ${f.filePath} ---\n${f.content}`).join('\n\n')
  return [
    '',
    'EDIT MODE — this build MODIFIES the existing app below. These rules OVERRIDE the base',
    'instruction to "produce a COMPLETE app": here, COMPLETE means base files + your emission',
    'merged together — the system keeps every file you do not emit. The JSON reply format is unchanged.',
    '1) Return ONLY the files you CHANGE or ADD (each with its FULL final content). Do NOT re-emit unchanged files — they are kept automatically.',
    '2) NEVER rewrite the whole app from scratch; preserve its working structure, style and behavior except where the spec asks for changes.',
    '3) Keep every emitted file consistent with the files you did not emit (imports, ids, script/css references).',
    '4) Files cannot be DELETED by omission. If the spec requires removing a feature, edit the affected files so the feature is gone (you may leave a file empty if truly obsolete).',
    '',
    'CURRENT APP FILES:',
    listing,
  ].join('\n')
}

export const PROTO_SYSTEM = [
  'You are Proto, the code author for the AKIS agentic build pipeline.',
  'Given an approved spec, produce a COMPLETE, ACTUALLY-WORKING app that satisfies it — never a static mockup.',
  'Respond with ONLY a JSON object, no prose: {"files":[{"filePath":"index.html","content":"...full file contents..."}, ...]}',
  'HARD RULES (an app that does not run is a FAILED build):',
  '1) DEFAULT to ONE self-contained, instantly-previewable "index.html" (inline CSS + VANILLA JS). Every button, input and feature must be WIRED UP and functional when the file is opened directly — no build step, no package.json.',
  '2) In that single file you may load a library ONLY via a plain <script src="https://cdn..."> that exposes a GLOBAL and runs with NO build step (a UMD/IIFE bundle). NEVER use React/JSX, Vue SFCs, TypeScript, ES-module `import`, or anything that needs a bundler in the single-file path — it will NOT execute in the browser and the app will render blank. (e.g. for QR codes use a vanilla CDN lib that exposes a global like `QRCode` — davidshimjs/qrcodejs — NOT qrcode.react.)',
  '3) Persist client state with localStorage. Emit a real BACKEND only when the spec genuinely needs a server/API/DB: then produce a "node-service" — a package.json whose start runs a server file that listens on process.env.PORT and serves the client (the preview runs it with `node .`). Keep dependencies minimal and prefer the Node standard library.',
  '4) Make it polished + responsive AND verify in your head that the core flow works end-to-end before returning. Do NOT include tests (the verifier writes those). Keep files focused.',
].join('\n')

/**
 * Proto — spec → code. LIVE: it calls the injected LLM provider with the approved
 * spec and parses the result into typed RepoFile[] (CORE-AC1). It REQUIRES an
 * ApprovedSpec token, so code-write cannot run without approval (Gate 1). Emits
 * agent_start, tool_call (dispatch_proto) + tool_result (CF2). Proto returns
 * files only — the push happens once behind the push gate.
 */
export class ProtoAgent {
  /** The base system prompt this Proto sends. Defaults to PROTO_SYSTEM, so an
   *  agent built without a `systemPrompt` dep is byte-identical to today. The DI
   *  layer injects the skill-composed prompt here (P3-AGENT-1). */
  private readonly base: string

  constructor(
    private deps: {
      bus: EventBus
      provider: LlmProvider
      /** Skill-composed base system prompt (P3-AGENT-1). Omitted ⇒ PROTO_SYSTEM,
       *  so a no-skills build sends the byte-identical prompt of today. */
      systemPrompt?: string
    },
  ) {
    this.base = deps.systemPrompt ?? PROTO_SYSTEM
  }

  async run(input: ProtoInput): Promise<{ files: RepoFile[] }> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'tool_call', tool: 'dispatch_proto', args: { spec: input.approved.spec.title, feedback: input.feedback ?? null }, agent: 'proto', laneId, sessionId, ts: nextTs() })

    const user = [
      `SPEC: ${input.approved.spec.title}`,
      input.approved.spec.body,
      input.feedback ? `\nADDRESS THIS REVIEW FEEDBACK:\n${input.feedback}` : '',
      input.baseFiles?.length ? renderBase(input.baseFiles) : '',
      renderKnowledge(input.ctx),
    ].join('\n')

    let res
    try {
      // A single non-streaming chat with an explicit, generous output budget — Proto returns the
      // whole app as one JSON reply that the parser below consumes in full.
      // maxTokens 16384: Proto writes the WHOLE app in one JSON reply, so a small budget truncates
      // it mid-string → unparseable JSON → a failed build (observed at both 4096 and 8192 on a
      // modern single-page app). 16384 fits a sizeable app and is well within every catalog model's
      // output limit (all Claude 4.x support ≥64k; OpenAI/Gemini providers clamp to their ceiling).
      res = await this.deps.provider.chat({ system: this.base, messages: [{ role: 'user', content: user }], maxTokens: 16384 })
    } catch (err) {
      // A throwing provider must still CLOSE the event frame (failed tool_result +
      // agent_end) so the live stream never has an orphaned tool_call, then re-throw.
      this.deps.bus.emit({ kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: { error: errMsg(err) }, agent: 'proto', laneId, sessionId, ts: nextTs() })
      this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: false, agent: 'proto', laneId, sessionId, ts: nextTs() })
      throw err
    }

    const { files, parsed } = this.parse(res.text ?? '', input.approved.spec.title)

    // `ok` reflects whether the LLM output parsed into real files — the placeholder
    // fallback is a DEGRADED result, so the event must not claim success.
    this.deps.bus.emit({ kind: 'tool_result', tool: 'dispatch_proto', ok: parsed, result: { files: files.length, parsed }, agent: 'proto', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: parsed, agent: 'proto', laneId, sessionId, ts: nextTs() })
    return { files }
  }

  private parse(text: string, title: string): { files: RepoFile[]; parsed: boolean } {
    try {
      const j = parseAIJson<{ files?: unknown }>(text)
      if (Array.isArray(j.files)) {
        const files = j.files
          .map(f => f as { filePath?: unknown; content?: unknown })
          .filter(f => typeof f.filePath === 'string' && typeof f.content === 'string')
          .map(f => ({ filePath: f.filePath as string, content: f.content as string }))
        if (files.length) return { files, parsed: true }
      }
    } catch {
      /* fall through */
    }
    // Never block the pipeline on a parse miss; emit a single placeholder file.
    return { files: [{ filePath: 'index.ts', content: `// ${title}\nexport const app = (): string => 'ok'\n` }], parsed: false }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
