//
// - Settings y MCP: globalState (compartidos entre proyectos, es lo esperado
//   para credenciales de proveedor y preferencias de UI).
// - API keys: SecretStorage (cifrado del SO), nunca en texto plano.
// - Historial de chat: workspaceState, para que el contexto sea POR PROYECTO.
import * as vscode from 'vscode'
import { ChatTurn, Checkpoint, InvestigationMemory, Settings } from './types'
import { MCP_TEMPLATE } from './mcp'

const KEY_SETTINGS = 'qa-pi.settings'
const KEY_HISTORY = 'qa-pi.history'
const KEY_MEMORY = 'qa-pi.projectMemory'
const KEY_INVESTIGATION_MEMORY = 'qa-pi.investigationMemory'
const KEY_CHECKPOINTS = 'qa-pi.checkpoints'
const SECRET_PREFIX = 'qa-pi.apikey.'

const DEFAULT_SETTINGS: Settings = {
  provider: { provider: 'openai' },
  mcpJson: MCP_TEMPLATE,
  mcpEnabled: {},
  theme: 'dark',
  fontSize: 13,
  configured: false,
  autoValidate: false,
  verification: 'off',
}

export class Store {
  private investigationMutation: Promise<void> = Promise.resolve()

  constructor(private ctx: vscode.ExtensionContext) {}

  async getSettings(): Promise<Settings> {
    const saved = this.ctx.globalState.get<Settings>(KEY_SETTINGS)
    const settings = { ...DEFAULT_SETTINGS, ...(saved || {}) }
    // Migración: quien tenía validación automática conserva ese comportamiento.
    if (!saved?.verification) settings.verification = settings.autoValidate ? 'validate' : 'off'
    settings.autoValidate = settings.verification !== 'off'
    // La key vive en SecretStorage; se hidrata al leer.
    const key = await this.ctx.secrets.get(SECRET_PREFIX + settings.provider.provider)
    if (key) settings.provider.apiKey = key
    return settings
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings()
    const next: Settings = { ...current, ...patch }
    if (patch.provider) {
      const providerChanged = patch.provider.provider !== undefined && patch.provider.provider !== current.provider.provider
      if (providerChanged) {
        const storedKey = await this.ctx.secrets.get(SECRET_PREFIX + patch.provider.provider)
        next.provider = { ...patch.provider, apiKey: patch.provider.apiKey || storedKey }
      } else {
        next.provider = { ...current.provider, ...patch.provider }
      }
    }
    // Extrae la API key hacia SecretStorage y no la guarda en globalState.
    if (next.provider.apiKey) {
      await this.ctx.secrets.store(SECRET_PREFIX + next.provider.provider, next.provider.apiKey)
    }
    if (patch.verification) next.autoValidate = patch.verification !== 'off'
    else if (patch.autoValidate !== undefined) next.verification = patch.autoValidate ? 'validate' : 'off'
    const toPersist: Settings = { ...next, provider: { ...next.provider, apiKey: undefined } }
    await this.ctx.globalState.update(KEY_SETTINGS, toPersist)
    return next
  }

  async setMcpEnabled(name: string, enabled: boolean): Promise<Settings> {
    const s = await this.getSettings()
    return this.saveSettings({ mcpEnabled: { ...s.mcpEnabled, [name]: enabled } })
  }

  // Historial POR PROYECTO (workspaceState).
  getHistory(): ChatTurn[] {
    return this.ctx.workspaceState.get<ChatTurn[]>(KEY_HISTORY) || []
  }

  async saveHistory(history: ChatTurn[]): Promise<ChatTurn[]> {
    const trimmed = history.slice(-100)
    await this.ctx.workspaceState.update(KEY_HISTORY, trimmed)
    return trimmed
  }

  async clearHistory(): Promise<void> {
    await this.ctx.workspaceState.update(KEY_HISTORY, [])
  }

  getMemory(): string {
    return this.ctx.workspaceState.get<string>(KEY_MEMORY) || ''
  }

  async saveMemory(text: string): Promise<string> {
    const memory = text.trim().slice(0, 12_000)
    await this.ctx.workspaceState.update(KEY_MEMORY, memory)
    return memory
  }

  async clearMemory(): Promise<void> {
    await this.ctx.workspaceState.update(KEY_MEMORY, '')
  }

  getInvestigationMemory(): InvestigationMemory {
    const saved = this.ctx.workspaceState.get<InvestigationMemory>(KEY_INVESTIGATION_MEMORY)
    return normalizeInvestigationMemory(saved)
  }

  async saveInvestigationMemory(memory: InvestigationMemory): Promise<InvestigationMemory> {
    return this.mutateInvestigationMemory(async () => {
      const current = this.getInvestigationMemory()
      // Una limpieza o invalidación concurrente siempre gana: nunca resucitar su copia anterior.
      if (current.generation !== memory.generation) return current
      const normalized = normalizeInvestigationMemory(memory)
      await this.ctx.workspaceState.update(KEY_INVESTIGATION_MEMORY, normalized)
      return normalized
    })
  }

  async clearInvestigationMemory(): Promise<void> {
    await this.mutateInvestigationMemory(async () => {
      const current = this.getInvestigationMemory()
      await this.ctx.workspaceState.update(KEY_INVESTIGATION_MEMORY, emptyInvestigationMemory(current.generation + 1))
    })
  }

  async invalidateInvestigationMemory(paths: string[]): Promise<void> {
    if (!paths.length) return
    await this.mutateInvestigationMemory(async () => {
      const changed = new Set(paths.map(cleanMemoryPath))
      const memory = this.getInvestigationMemory()
      memory.files = memory.files.filter((entry) => !changed.has(entry.path))
      memory.queries = []
      memory.indexFingerprint = ''
      memory.generation++
      await this.ctx.workspaceState.update(KEY_INVESTIGATION_MEMORY, normalizeInvestigationMemory(memory))
    })
  }

  getCheckpoints(): Checkpoint[] {
    return this.ctx.workspaceState.get<Checkpoint[]>(KEY_CHECKPOINTS) || []
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint[]> {
    const checkpoints = [checkpoint, ...this.getCheckpoints().filter((item) => item.id !== checkpoint.id)].slice(0, 20)
    await this.ctx.workspaceState.update(KEY_CHECKPOINTS, checkpoints)
    return checkpoints
  }

  async updateCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint[]> {
    const checkpoints = this.getCheckpoints().map((item) => item.id === checkpoint.id ? checkpoint : item)
    await this.ctx.workspaceState.update(KEY_CHECKPOINTS, checkpoints)
    return checkpoints
  }

  async clearCheckpoints(): Promise<void> {
    await this.ctx.workspaceState.update(KEY_CHECKPOINTS, [])
  }

  private mutateInvestigationMemory<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.investigationMutation.then(operation, operation)
    this.investigationMutation = run.then(() => undefined, () => undefined)
    return run
  }
}

function emptyInvestigationMemory(generation = 0): InvestigationMemory {
  return { version: 1, generation, indexFingerprint: '', files: [], queries: [] }
}

function normalizeInvestigationMemory(memory?: InvestigationMemory): InvestigationMemory {
  if (!memory || memory.version !== 1) return emptyInvestigationMemory()

  const seenFiles = new Set<string>()
  const files = (Array.isArray(memory.files) ? memory.files : [])
    .filter((item) => item && typeof item.path === 'string' && typeof item.hash === 'string' && typeof item.content === 'string')
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .filter((item) => {
      const path = cleanMemoryPath(item.path)
      if (!path || seenFiles.has(path)) return false
      seenFiles.add(path)
      return true
    })
    .slice(0, 18)
    .map((item) => ({
      path: cleanMemoryPath(item.path).slice(0, 500),
      hash: item.hash.slice(0, 128),
      content: redactInvestigationText(item.content).slice(0, 20_000),
      cues: (Array.isArray(item.cues) ? item.cues : [])
        .filter((cue) => typeof cue === 'string')
        .slice(-3)
        .map((cue) => redactInvestigationText(cue).slice(0, 500)),
      updatedAt: Number(item.updatedAt || Date.now()),
    }))

  const seenQueries = new Set<string>()
  const queries = (Array.isArray(memory.queries) ? memory.queries : [])
    .filter((item) => item
      && (item.kind === 'list_files' || item.kind === 'search_code')
      && typeof item.key === 'string'
      && typeof item.result === 'string'
      && /^(?:list_files|search_code):sha256:[a-f0-9]{64}$/.test(item.key))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .filter((item) => {
      if (seenQueries.has(item.key)) return false
      seenQueries.add(item.key)
      return true
    })
    .slice(0, 12)
    .map((item) => ({
      kind: item.kind,
      key: item.key.slice(0, 1_000),
      result: redactInvestigationText(item.result).slice(0, 12_000),
      cues: (Array.isArray(item.cues) ? item.cues : [])
        .filter((cue) => typeof cue === 'string')
        .slice(-3)
        .map((cue) => redactInvestigationText(cue).slice(0, 500)),
      updatedAt: Number(item.updatedAt || Date.now()),
    }))

  return {
    version: 1,
    generation: Math.max(0, Math.trunc(Number(memory.generation) || 0)),
    indexFingerprint: typeof memory.indexFingerprint === 'string' ? memory.indexFingerprint.slice(0, 128) : '',
    files,
    queries,
  }
}

function cleanMemoryPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
}

function redactInvestigationText(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
}
