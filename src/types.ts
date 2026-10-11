// Tipos compartidos entre la extensión (host) y el webview.

export type ProviderId = 'gemini' | 'claude' | 'openai' | 'ollama'
export type AgentMode = 'chat' | 'plan'
export type UiLanguage = 'es' | 'en'

/**
 * Temas visuales de la interfaz. `dark`/`light` son los base; el resto son
 * estilos opcionales que redefinen la paleta de variables CSS.
 */
export type UiTheme =
  | 'dark'
  | 'light'
  | 'midnight'
  | 'ocean'
  | 'forest'
  | 'sunset'
  | 'mono'
  | 'solarized'

export interface ProviderConfig {
  provider: ProviderId
  apiKey?: string
  model?: string
  /** Base URL para Ollama u OpenAI-compatible. */
  baseUrl?: string
  /** Límite real de contexto del modelo (tokens), si la API lo expuso. */
  contextLimit?: number
  /** Sólo hacia la webview: hay una key guardada en SecretStorage (la key nunca se envía). */
  hasStoredKey?: boolean
}

export interface McpServerDef {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpServerIssue {
  name: string
  ok: boolean
  message: string
}

export interface McpValidation {
  ok: boolean
  servers: McpServerDef[]
  issues: McpServerIssue[]
  error?: string
}

export interface Settings {
  /** Ausente hasta que el usuario elige un idioma en el primer inicio. */
  language?: UiLanguage
  provider: ProviderConfig
  mcpJson: string
  mcpEnabled: Record<string, boolean>
  /** Ejecuta las tools de los servidores MCP activos sin pedir confirmación en cada llamada. */
  mcpAutoApprove: boolean
  theme: UiTheme
  fontSize: number
  configured: boolean
  /** Ejecuta un comando detectado después de aplicar cambios. */
  autoValidate: boolean
  /**
   * `off` no valida; `validate` ejecuta la validación detectada; `autofix`
   * además corrige y reintenta cuando la validación falla.
   */
  verification: VerificationMode
  /**
   * Comando de verificación definido por el usuario. Admite `{tests}` (sólo los
   * archivos de prueba cambiados) y `{files}` (todos los archivos cambiados).
   * Vacío: no se verifica nada; QAPI nunca elige la suite por su cuenta.
   */
  verificationCommand: string
}

/**
 * `off` no verifica; `propose` deja el comando listo para que el usuario lo
 * ejecute; `validate` lo ejecuta tras aplicar; `autofix` además corrige y reintenta.
 */
export type VerificationMode = 'off' | 'propose' | 'validate' | 'autofix'

export interface IdeDiagnostic {
  path: string
  line: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface IdeContextSnapshot {
  activeFile?: { path: string; content: string }
  selection?: { path: string; text: string; startLine: number; endLine: number }
  visibleFiles: string[]
  diagnostics: IdeDiagnostic[]
  gitStatus: string
  gitDiff: string
  changedFiles: string[]
  terminals: string[]
  capturedAt: number
}

export interface ArtifactInfo {
  path: string
  kind: 'report' | 'log' | 'screenshot' | 'trace'
  size: number
  modifiedAt: number
}

export interface TestImpact {
  changedFiles: string[]
  probableTests: string[]
  suggestedCommands: string[]
  fallback: boolean
}

export interface DiffHunk {
  id: string
  label: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  oldLines: string[]
  newLines: string[]
}

export interface FileProposal {
  id?: string
  path: string
  /** Explicación breve para que el usuario entienda qué cambia y por qué. */
  purpose?: string
  content: string
  existed: boolean
  /** Base usada por el diff y por undo. */
  previous?: string | null
  baseHash?: string
  hunks?: DiffHunk[]
}

export interface CommandProposal {
  id: string
  command: string
  reason: string
  timeoutMs: number
}

export interface ExecutionRun {
  id: string
  command: string
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'timeout'
  exitCode?: number
  output: string
  durationMs: number
  automatic?: boolean
}

export interface CheckpointFile {
  path: string
  before: string | null
  after: string | null
  beforeHash: string
  afterHash: string
}

export interface Checkpoint {
  id: string
  label: string
  createdAt: number
  files: CheckpointFile[]
  undone?: boolean
  pending?: boolean
  conflict?: string
}

export interface TraceabilitySummary {
  generatedAt: number
  requirements: string[]
  scenarios: number
  steps: number
  stepDefinitions: number
  tests: number
  linkedSteps: number
  gaps: string[]
  evidence: string[]
}

export type HookTrigger = 'PostFileSave' | 'PostFileCreate' | 'PostFileDelete'

export type HookAction =
  | { type: 'agent'; prompt: string }
  | { type: 'command'; command: string }

export interface HookDefinition {
  name: string
  trigger: HookTrigger
  matcher?: string
  action: HookAction
}

export type CustomAgentOutputMode = 'chat' | 'file'
/** "files": elige archivos del proyecto por glob. "freeText": pega texto o adjunta un archivo local. */
export type CustomAgentInputMode = 'files' | 'freeText'

export interface CustomAgentDefinition {
  /** Nombre de archivo sin extensión; identifica al agente. */
  slug: string
  name: string
  description: string
  /** Icono/emoji corto para la tarjeta. */
  icon?: string
  instructions: string
  inputMode?: CustomAgentInputMode
  /** Glob para preseleccionar archivos de entrada (p. ej. "**\/*.feature"); usado cuando inputMode es "files". */
  inputGlob?: string
  outputMode: CustomAgentOutputMode
  /** Plantilla de ruta de salida cuando outputMode es "file"; admite {name} y {date}. */
  outputPathTemplate?: string
  /** true para los agentes incluidos con la extensión (no editables, sí duplicables). */
  builtIn?: boolean
}

/**
 * Cuándo entra una skill al contexto del agente:
 * - `auto`: el agente ve el nombre y la descripción y la carga con load_skill si le sirve.
 * - `always`: en todos los mensajes.
 * - `fileMatch`: cuando hay archivos en juego que coinciden con el glob.
 * - `event`: ante un evento (resultado de prueba, preparar un archivo).
 * - `manual`: sólo con `#skill:nombre`.
 */
export type SkillActivation = 'auto' | 'always' | 'fileMatch' | 'event' | 'manual'
/** `testResult`: se obtuvo un resultado de prueba. `beforeWrite`: el agente prepara un archivo. */
export type SkillEvent = 'testResult' | 'beforeWrite'

export interface SkillDefinition {
  slug: string
  name: string
  /** En modo `auto` es lo que el agente lee para decidir si la usa. */
  description: string
  activation: SkillActivation
  /** Glob para `fileMatch` y, opcionalmente, para el evento `beforeWrite`. */
  fileMatchPattern?: string
  events?: SkillEvent[]
  /** Sólo aplica en proyectos con alguno de estos frameworks o lenguajes. Vacío: todos. */
  frameworks?: string[]
  instructions: string
  enabled: boolean
}

export type SpecDocumentKind = 'requirements' | 'design' | 'tasks'
export type SpecPhase = 'requirements' | 'design' | 'tasks' | 'execution' | 'done'

export interface SpecTask {
  id: string
  title: string
  status: 'pending' | 'in-progress' | 'completed'
  children: SpecTask[]
}

export interface SpecSummary {
  slug: string
  title: string
  phase: SpecPhase
  hasRequirements: boolean
  hasDesign: boolean
  hasTasks: boolean
  tasks: SpecTask[]
}

export type SteeringInclusion = 'always' | 'fileMatch' | 'manual'

export interface SteeringRule {
  name: string
  inclusion: SteeringInclusion
  body: string
  fileMatchPattern?: string
}

export interface InvestigationFileMemory {
  path: string
  /** Hash SHA-256 del contenido completo observado en el índice. */
  hash: string
  /** Contenido ya redactado que recibió el modelo al leer el archivo. */
  content: string
  cues: string[]
  updatedAt: number
}

export interface InvestigationQueryMemory {
  kind: 'list_files' | 'search_code'
  key: string
  result: string
  cues: string[]
  updatedAt: number
}

export interface InvestigationMemory {
  version: 1
  /** Incrementa al limpiar o invalidar para impedir que una escritura concurrente restaure datos obsoletos. */
  generation: number
  indexFingerprint: string
  files: InvestigationFileMemory[]
  queries: InvestigationQueryMemory[]
}

export interface ChatTurn {
  /** Identidad estable (el índice cambia al recortar o compactar el historial). */
  id?: string
  role: 'user' | 'assistant'
  text: string
  mode?: AgentMode
  proposals?: FileProposal[]
  commandProposals?: CommandProposal[]
  runs?: ExecutionRun[]
  checkpointId?: string
  applied?: boolean
  undone?: boolean
  /** Resultado del ciclo de verificación posterior a aplicar cambios. */
  verificationNote?: string
  /** El turno creó o actualizó documentos/estado de un spec. */
  specTouched?: boolean
  /** Hallazgos del sub-agente revisor sobre las propuestas de este turno. */
  reviewFindings?: string
  tools?: string[]
  contextSources?: string[]
  summary?: boolean
}

export interface ProposalSelection {
  proposalId: string
  hunkIds: string[]
}

// ── Mensajería webview <-> host ─────────────────────────────────────────────

export type ToHost =
  | { type: 'ready' }
  | { type: 'sendMessage'; text: string; mode?: AgentMode }
  | { type: 'clearChat' }
  | { type: 'cancel' }
  | { type: 'applyProposals'; turnIndex: number; turnId?: string; selections: ProposalSelection[] }
  | { type: 'undoProposals'; turnIndex: number; turnId?: string; proposals: FileProposal[] }
  | { type: 'runCommand'; turnIndex: number; turnId?: string; commandId: string }
  | { type: 'undoCheckpoint'; checkpointId: string }
  | { type: 'saveMemory'; text: string }
  | { type: 'analyzeImpact' }
  | { type: 'diagnoseLatestArtifact' }
  | { type: 'rebuildTraceability' }
  | { type: 'refreshSpecs' }
  | { type: 'suggestContextRefs'; query: string }
  | { type: 'refreshCustomAgents' }
  | { type: 'saveCustomAgent'; agent: CustomAgentDefinition; previousSlug?: string }
  | { type: 'deleteCustomAgent'; slug: string }
  | { type: 'runCustomAgent'; slug: string; files: string[]; freeText?: string }
  | { type: 'suggestAgentFiles'; glob: string }
  | { type: 'openSpecDocument'; slug: string; kind: SpecDocumentKind }
  | { type: 'runSpecTask'; slug: string; taskId: string }
  | { type: 'advanceSpecPhase'; slug: string; phase: SpecPhase }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: Partial<Settings> }
  | { type: 'validateProvider'; provider: ProviderConfig }
  | { type: 'toggleMcp'; name: string; enabled: boolean }
  | { type: 'validateMcp'; json: string }
  | { type: 'saveMcpJson'; json: string }
  | { type: 'probeMcp'; name: string }
  | { type: 'listModels' }
  | { type: 'suggestVerificationCommand' }
  | { type: 'refreshSkills' }
  | { type: 'saveSkill'; skill: SkillDefinition; previousSlug?: string }
  | { type: 'deleteSkill'; slug: string }
  | { type: 'toggleSkill'; slug: string; enabled: boolean }
  | { type: 'openSkillFile'; slug: string }
  | { type: 'reindex' }

export interface ContextUsage {
  used: number
  limit: number
  ratio: number
  needsSummary: boolean
}

export type ToWebview =
  | { type: 'init'; settings: Settings; history: ChatTurn[]; projectName: string; usage: ContextUsage; memory: string; checkpoints: Checkpoint[] }
  | { type: 'project'; projectName: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'history'; history: ChatTurn[]; usage: ContextUsage }
  | { type: 'assistantStart' }
  | { type: 'assistantChunk'; text: string }
  | { type: 'assistantDone'; turn: ChatTurn; usage: ContextUsage }
  /** Falla que termina la operación en curso (apaga el indicador de "pensando"). */
  | { type: 'error'; message: string }
  /** Aviso no fatal: la operación en curso continúa. */
  | { type: 'notice'; message: string }
  /** Fin de una petición al agente, con o sin resultado (también tras cancelar o fallar). */
  | { type: 'assistantEnd'; cancelled?: boolean }
  /** Devuelve al compositor un texto cuyo envío falló. */
  | { type: 'restoreDraft'; text: string }
  | { type: 'openSettings' }
  | { type: 'validationResult'; ok: boolean; models: string[]; limits?: Record<string, number>; message?: string }
  | { type: 'indexStatus'; indexing: boolean; files: number }
  | { type: 'summarized'; usage: ContextUsage }
  | { type: 'mcpValidation'; result: McpValidation }
  | { type: 'models'; provider: ProviderId; models: string[]; limits?: Record<string, number>; message?: string }
  | { type: 'verificationSuggestion'; command?: string }
  | {
    type: 'skills'
    skills: SkillDefinition[]
    templates: SkillDefinition[]
    /** Frameworks y lenguajes detectados en el proyecto, para el filtro visual. */
    detected: string[]
    trusted: boolean
  }
  | {
    type: 'mcpProbe'
    name: string
    ok: boolean
    tools: { name: string; description?: string }[]
    message?: string
    durationMs: number
  }
  | { type: 'toolProgress'; tool: string; detail: string }
  /** `automatic`: lo lanzó la verificación tras aplicar cambios, no una aprobación del usuario. */
  | { type: 'executionProgress'; command: string; automatic?: boolean }
  | { type: 'memory'; text: string; silent?: boolean }
  | { type: 'checkpoints'; checkpoints: Checkpoint[] }
  | { type: 'traceability'; summary: TraceabilitySummary }
  | { type: 'specs'; specs: SpecSummary[] }
  | { type: 'contextRefSuggestions'; suggestions: string[] }
  | { type: 'customAgents'; agents: CustomAgentDefinition[] }
  | { type: 'agentFileSuggestions'; files: string[] }
