//
// - Settings y MCP: globalState (compartidos entre proyectos, es lo esperado
//   para credenciales de proveedor y preferencias de UI).
// - API keys: SecretStorage (cifrado del SO), nunca en texto plano.
// - Historial de chat: workspaceState, para que el contexto sea POR PROYECTO.
import { randomUUID } from 'crypto'
import * as vscode from 'vscode'
import { ChatTurn, Checkpoint, InvestigationMemory, Settings, UiTheme } from './types'
import { MCP_TEMPLATE } from './mcp'
import { redactSecrets } from './secretVault'

const THEMES: UiTheme[] = ['dark', 'light', 'midnight', 'ocean', 'forest', 'sunset', 'mono', 'solarized']
export const FONT_SIZE_MIN = 9
export const FONT_SIZE_MAX = 18
const MAX_HISTORY_TURNS = 100
/** La salida de comandos de turnos antiguos se recorta al persistir. */
const MAX_RUN_OUTPUT_CHARS = 16_000
/** Tope total de checkpoints persistidos (contienen archivos completos). */
const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024

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
  verificationCommand: '',
  mcpAutoApprove: false,
}

export class Store {
  private investigationMutation: Promise<void> = Promise.resolve()
  private settingsMutation: Promise<unknown> = Promise.resolve()
  private historyMutation: Promise<unknown> = Promise.resolve()

  constructor(private ctx: vscode.ExtensionContext) {}

  async getSettings(): Promise<Settings> {
    const saved = this.ctx.globalState.get<Settings>(KEY_SETTINGS)
    // Copia profunda: antes se mutaba DEFAULT_SETTINGS.provider o el objeto en
    // caché del Memento al hidratar la API key.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(saved || {}),
      provider: { ...DEFAULT_SETTINGS.provider, ...(saved?.provider || {}) },
      mcpEnabled: { ...(saved?.mcpEnabled || {}) },
    }
    if (!THEMES.includes(settings.theme)) settings.theme = 'dark'
    settings.fontSize = clampFontSize(settings.fontSize)
    // Migración: quien tenía validación automática conserva ese comportamiento.
    if (!saved?.verification) settings.verification = settings.autoValidate ? 'validate' : 'off'
    if (!['off', 'propose', 'validate', 'autofix'].includes(settings.verification)) settings.verification = 'off'
    settings.autoValidate = settings.verification !== 'off'
    settings.verificationCommand = String(settings.verificationCommand || '').trim().slice(0, 500)
    // La key vive en SecretStorage; se hidrata al leer.
    const key = await this.ctx.secrets.get(SECRET_PREFIX + settings.provider.provider)
    if (key) settings.provider.apiKey = key
    return settings
  }

  /** Settings aptos para la webview: nunca incluyen la API key, sólo si existe. */
  async getPublicSettings(): Promise<Settings> {
    return toPublicSettings(await this.getSettings())
  }

  /** Completa un ProviderConfig sin key con la guardada (validación desde la webview). */
  async withStoredKey<T extends { provider: Settings['provider']['provider']; apiKey?: string }>(config: T): Promise<T> {
    if (config.apiKey) return config
    const key = await this.ctx.secrets.get(SECRET_PREFIX + config.provider)
    return key ? { ...config, apiKey: key } : config
  }

  /** Serializado: dos guardados rápidos (+/-, tema) ya no se pisan entre sí. */
  saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const run = this.settingsMutation.then(() => this.saveSettingsNow(patch), () => this.saveSettingsNow(patch))
    this.settingsMutation = run.catch(() => undefined)
    return run
  }

  private async saveSettingsNow(patch: Partial<Settings>): Promise<Settings> {
    patch = { ...patch }
    if (patch.provider) {
      // La webview nunca conoce la key guardada: un campo vacío significa "conservarla".
      const { hasStoredKey: _ignored, ...provider } = patch.provider
      if (!provider.apiKey) delete provider.apiKey
      patch.provider = provider
    }
    if (patch.fontSize !== undefined) patch.fontSize = clampFontSize(patch.fontSize)
    if (patch.theme !== undefined && !THEMES.includes(patch.theme)) delete patch.theme
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
    const toPersist: Settings = { ...next, provider: { ...next.provider, apiKey: undefined, hasStoredKey: undefined } }
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
    const trimmed = prepareHistoryForStorage(history)
    await this.ctx.workspaceState.update(KEY_HISTORY, trimmed)
    return trimmed
  }

  /**
   * Lee-modifica-escribe el historial de forma serializada sobre la versión
   * persistida más reciente. Evita que una operación larga (una respuesta del
   * modelo) guarde su copia vieja y pise lo que otra hizo entretanto (aplicar
   * cambios, ejecutar un comando, deshacer, "Nueva").
   */
  mutateHistory(operation: (history: ChatTurn[]) => ChatTurn[] | void | Promise<ChatTurn[] | void>): Promise<ChatTurn[]> {
    const run = this.historyMutation.then(async () => {
      const history = this.getHistory().map((turn) => ({ ...turn }))
      const result = await operation(history)
      return this.saveHistory(result || history)
    })
    this.historyMutation = run.catch(() => undefined)
    return run
  }

  async clearHistory(): Promise<void> {
    await this.mutateHistory(() => [])
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
    const candidates = [checkpoint, ...this.getCheckpoints().filter((item) => item.id !== checkpoint.id)].slice(0, 20)
    // Los checkpoints guardan archivos completos: se descartan los más antiguos
    // si el total crece demasiado (el más reciente siempre se conserva).
    const checkpoints: Checkpoint[] = []
    let bytes = 0
    for (const item of candidates) {
      const size = checkpointBytes(item)
      if (checkpoints.length && bytes + size > MAX_CHECKPOINT_BYTES) break
      checkpoints.push(item)
      bytes += size
    }
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

/** Mismos marcadores reversibles que ve el modelo (ver secretVault.ts). */
function redactInvestigationText(value: string): string {
  return redactSecrets(value)
}

export function clampFontSize(value: unknown): number {
  const size = Math.round(Number(value))
  if (!Number.isFinite(size)) return 13
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))
}

export function toPublicSettings(settings: Settings): Settings {
  const { apiKey, ...provider } = settings.provider
  return { ...settings, provider: { ...provider, hasStoredKey: Boolean(apiKey) }, mcpEnabled: { ...settings.mcpEnabled } }
}

/** Ids estables por turno y salida de comandos acotada antes de persistir. */
function prepareHistoryForStorage(history: ChatTurn[]): ChatTurn[] {
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => {
    const prepared: ChatTurn = turn.id ? turn : { ...turn, id: randomUUID() }
    if (!prepared.runs?.some((run) => run.output.length > MAX_RUN_OUTPUT_CHARS)) return prepared
    return {
      ...prepared,
      runs: prepared.runs.map((run) => run.output.length > MAX_RUN_OUTPUT_CHARS
        ? { ...run, output: `${run.output.slice(0, 4_000)}\n\n[… salida recortada al guardar …]\n\n${run.output.slice(-(MAX_RUN_OUTPUT_CHARS - 4_000))}` }
        : run),
    }
  })
}

function checkpointBytes(checkpoint: Checkpoint): number {
  return checkpoint.files.reduce((sum, file) => sum + (file.before?.length || 0) + (file.after?.length || 0), 0)
}
