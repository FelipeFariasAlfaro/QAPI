// UI del webview QAPI (TS vanilla, sin framework, para un bundle liviano).
import { renderMarkdown } from './markdown'
import type {
  AgentMode, ChatTurn, Checkpoint, ContextUsage, CustomAgentDefinition, CustomAgentOutputMode, DiffHunk,
  ExecutionRun, FileProposal, McpValidation, ProviderId, Settings, SkillActivation, SkillDefinition, SkillEvent,
  SpecPhase, SpecSummary, SpecTask, ToWebview,
  TraceabilitySummary, UiLanguage, UiTheme, VerificationMode,
} from '../types'

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void
  getState(): unknown
  setState(s: unknown): void
}
const vscode = acquireVsCodeApi()

const PROVIDERS: { id: ProviderId; label: string; needsKey: boolean }[] = [
  { id: 'gemini', label: 'Gemini', needsKey: true },
  { id: 'claude', label: 'Claude', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false },
]

// El primer valor es el tema base; los siguientes son estilos opcionales.
const THEME_OPTIONS: [UiTheme, string][] = [
  ['dark', 'Oscuro'],
  ['light', 'Claro'],
  ['midnight', 'Medianoche'],
  ['ocean', 'Océano'],
  ['forest', 'Bosque'],
  ['sunset', 'Atardecer'],
  ['mono', 'Monocromo'],
  ['solarized', 'Solarizado'],
]
const THEME_CLASSES = THEME_OPTIONS.map(([value]) => `theme-${value}`)

const FONT_MIN = 9
const FONT_MAX = 18

type TabId = 'chat' | 'agents' | 'skills' | 'mcp' | 'settings' | 'centyc'
type SelectionState = Record<string, Record<string, string[]>>
interface ProviderDraftState {
  provider: ProviderId
  model?: string
  baseUrl?: string
  contextLimit?: number
}
interface LocalState {
  tab?: TabId
  mode?: AgentMode
  selections?: SelectionState
  composerDraft?: string
  memoryDraft?: string
  providerDraft?: ProviderDraftState
  agentSelectedFiles?: Record<string, string[]>
}

const saved = (vscode.getState() || {}) as LocalState
let settings: Settings | null = null
let history: ChatTurn[] = []
let projectName = ''
let usage: ContextUsage | null = null
let tab: TabId = (['settings', 'centyc', 'agents', 'mcp', 'skills'] as string[]).includes(saved.tab || '') ? saved.tab! : 'chat'
let thinking = false
let toolTrace: string[] = []
let streamedText = ''
let validation: { ok: boolean; models: string[]; limits?: Record<string, number>; message?: string } | null = null
let draftProvider: Settings['provider'] | null = saved.providerDraft ? { ...saved.providerDraft } : null
let mcpDraft: string | null = null
let mcpValidation: McpValidation | null = null
// Sin selector de modo: el compositor siempre usa el agente. Un 'plan' guardado
// en el estado local de versiones anteriores se ignora.
const mode: AgentMode = 'chat'
let selections: SelectionState = saved.selections || {}
let composerDraft = saved.composerDraft || ''
let memory = ''
let memoryDraft = saved.memoryDraft || ''
let checkpoints: Checkpoint[] = []
let specs: SpecSummary[] = []
let customAgents: CustomAgentDefinition[] = []
let agentFileSuggestions: string[] = []
let agentFileFilter: Record<string, string> = {}
let agentSelectedFiles: Record<string, string[]> = saved.agentSelectedFiles || {}
let agentFreeText: Record<string, string> = {}
let fileModalAgentSlug: string | null = null
let editingAgent: CustomAgentDefinition | null = null
let editingAgentPreviousSlug: string | undefined
let refSuggestions: string[] = []
let refIndex = 0
let refQueryStart = -1
const openAccordions = new Set<string>()
let traceability: TraceabilitySummary | null = null
let executionCommand = ''
/** Comando de verificación que el usuario está editando (sin guardar). */
let verificationDraft: string | null = null
/** El comando en curso lo lanzó la verificación automática, no el usuario. */
let executionAutomatic = false
let indexing = false
let indexedFiles = 0

const root = document.getElementById('root')!
const centycLogoUri = root.dataset.centycLogo || ''

function tr(es: string, en: string): string { return settings?.language === 'en' ? en : es }
function dateLocale(): string { return settings?.language === 'en' ? 'en-US' : 'es-ES' }

function post(msg: unknown) { vscode.postMessage(msg) }
function saveLocalState() {
  const providerDraft: ProviderDraftState | undefined = draftProvider ? {
    provider: draftProvider.provider,
    model: draftProvider.model,
    baseUrl: draftProvider.baseUrl,
    contextLimit: draftProvider.contextLimit,
  } : undefined
  vscode.setState({
    tab, mode, selections, composerDraft, memoryDraft,
    providerDraft, agentSelectedFiles,
  } satisfies LocalState)
}

window.addEventListener('message', (ev) => {
  try {
    const msg = ev.data as ToWebview | { type: 'openSettings' }
    switch (msg.type) {
      case 'init': {
        const firstInitialization = settings === null
        settings = msg.settings
        history = msg.history
        projectName = msg.projectName
        usage = msg.usage
        memory = msg.memory
        if (firstInitialization && saved.memoryDraft === undefined) memoryDraft = msg.memory
        checkpoints = msg.checkpoints
        post({ type: 'refreshCustomAgents' })
        if (firstInitialization) {
          draftProvider = draftProvider
            ? { ...msg.settings.provider, ...draftProvider }
            : { ...msg.settings.provider }
        }
        applyTheme()
        if (firstInitialization && !saved.tab) tab = msg.settings.configured ? 'chat' : 'settings'
        saveLocalState()
        render()
        break
      }
      case 'project':
        projectName = msg.projectName
        render()
        break
      case 'settings': {
        const previousProvider = settings?.provider
        settings = msg.settings
        // El borrador MCP ya quedó guardado: se vuelve a mostrar la versión persistida.
        if (mcpDraft !== null && mcpDraft === msg.settings.mcpJson) mcpDraft = null
        // Guardar el tema o la fuente no debe borrar una key o un modelo que el
        // usuario está escribiendo: el borrador sólo se reemplaza si cambió el
        // proveedor guardado.
        if (!draftProvider || !sameProvider(previousProvider, msg.settings.provider)) {
          draftProvider = { ...msg.settings.provider }
        } else {
          draftProvider = { ...draftProvider, hasStoredKey: msg.settings.provider.hasStoredKey }
        }
        applyTheme()
        render()
        break
      }
      case 'history':
        history = msg.history
        usage = msg.usage
        executionCommand = ''
        render()
        break
      case 'assistantStart':
        thinking = true
        toolTrace = []
        streamedText = ''
        render()
        break
      case 'assistantChunk':
        streamedText += msg.text
        // Actualización incremental: reconstruir todo el DOM por cada fragmento
        // causaba lag, perdía el foco del compositor y movía el scroll.
        if (!updateStreamingNode()) render()
        break
      case 'assistantDone':
        thinking = false
        toolTrace = []
        streamedText = ''
        usage = msg.usage
        render()
        break
      case 'assistantEnd':
        if (thinking || streamedText || toolTrace.length) {
          thinking = false
          toolTrace = []
          streamedText = ''
          render()
        }
        break
      case 'toolProgress':
        toolTrace.push(`${msg.tool}: ${msg.detail}`)
        if (toolTrace.length > 50) toolTrace = toolTrace.slice(-50)
        if (!updateTraceNode()) render()
        break
      case 'notice':
        toast(msg.message)
        break
      case 'restoreDraft':
        if (!composerDraft.trim()) {
          composerDraft = msg.text
          saveLocalState()
          render()
        }
        break
      case 'summarized':
        usage = msg.usage
        toast('Contexto lleno: resumí la conversación y continué')
        render()
        break
      case 'mcpValidation':
        mcpValidation = msg.result
        render()
        break
      case 'models':
        chatModels = msg
        render()
        break
      case 'verificationSuggestion':
        if (msg.command) {
          verificationDraft = msg.command
          toast(tr(`Sugerencia: ${msg.command} · revísala y guárdala`, `Suggestion: ${msg.command} · review and save it`))
        } else {
          toast(tr('No detecté un framework de pruebas; escribe el comando a mano.', 'No test framework detected; type the command manually.'))
        }
        render()
        break
      case 'mcpProbe':
        mcpProbes[msg.name] = { running: false, result: msg }
        render()
        break
      case 'error':
        // No apaga "pensando": el host avisa el fin real de la petición con assistantEnd.
        executionCommand = ''
        toast(msg.message)
        render()
        break
      case 'validationResult':
        validation = { ok: msg.ok, models: msg.models, limits: msg.limits, message: msg.message }
        if (msg.ok && draftProvider && msg.models.length && !msg.models.includes(draftProvider.model || '')) {
          draftProvider.model = msg.models[0]
        }
        render()
        break
      case 'memory':
        memory = msg.text
        memoryDraft = msg.text
        if (!msg.silent) toast('Memoria actualizada')
        render()
        break
      case 'specs':
        specs = msg.specs
        render()
        break
      case 'skills':
        skillsState = { skills: msg.skills, templates: msg.templates, detected: msg.detected, trusted: msg.trusted }
        render()
        break
      case 'customAgents':
        customAgents = msg.agents
        render()
        break
      case 'agentFileSuggestions':
        agentFileSuggestions = msg.files
        render()
        break
      case 'contextRefSuggestions':
        refSuggestions = msg.suggestions
        refIndex = 0
        render()
        break
      case 'checkpoints':
        checkpoints = msg.checkpoints
        render()
        break
      case 'traceability':
        traceability = msg.summary
        render()
        break
      case 'executionProgress':
        executionCommand = msg.command
        executionAutomatic = Boolean(msg.automatic)
        render()
        break
      case 'indexStatus': {
        indexing = msg.indexing
        indexedFiles = msg.files
        const badge = root.querySelector<HTMLElement>('.index-badge')
        if (badge) badge.textContent = translateUiText(indexing ? 'Indexando…' : `${indexedFiles} archivos`)
        else render()
        break
      }
      case 'openSettings':
        tab = 'settings'
        render()
        break
    }
  } catch (e) {
    root.innerHTML = ''
    const error = div('fatal-error')
    error.textContent = tr(`Error en la interfaz: ${String((e as Error).message || e)}`, `Interface error: ${String((e as Error).message || e)}`)
    root.appendChild(error)
  }
})

function applyTheme() {
  if (!settings) return
  document.documentElement.lang = settings.language || 'es'
  document.body.classList.remove(...THEME_CLASSES)
  // 'dark' es la paleta base de :root; el resto se activa con su clase.
  if (settings.theme && settings.theme !== 'dark') document.body.classList.add(`theme-${settings.theme}`)
  document.documentElement.style.setProperty('--qp-font', `${settings.fontSize}px`)
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  // render() reconstruye el DOM: se conserva el foco y la selección del campo
  // activo (p. ej. el compositor) para poder escribir mientras llega una respuesta.
  const active = document.activeElement as (HTMLInputElement | HTMLTextAreaElement | null)
  const focusId = active && root.contains(active) && active.id ? active.id : ''
  const selection = focusId && 'selectionStart' in active!
    ? { start: active!.selectionStart, end: active!.selectionEnd }
    : undefined
  rememberMessagesScroll()
  renderInner()
  if (focusId) {
    const target = document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null
    if (target) {
      target.focus({ preventScroll: true })
      if (selection && selection.start !== null && typeof target.setSelectionRange === 'function') {
        try { target.setSelectionRange(selection.start, selection.end ?? selection.start) } catch { /* tipo sin selección */ }
      }
    }
  }
}

/** Posición del historial: sólo se baja al final si el usuario ya estaba abajo. */
const messagesScroll = { top: 0, atBottom: true }
function rememberMessagesScroll() {
  const current = root.querySelector<HTMLElement>('.messages')
  if (!current) return
  messagesScroll.top = current.scrollTop
  messagesScroll.atBottom = current.scrollHeight - current.scrollTop - current.clientHeight < 40
}
function restoreMessagesScroll(msgs: HTMLElement) {
  if (messagesScroll.atBottom) msgs.scrollTop = msgs.scrollHeight
  else msgs.scrollTop = messagesScroll.top
}

/** Actualiza sólo el texto en streaming. Devuelve false si hace falta un render completo. */
function updateStreamingNode(): boolean {
  if (tab !== 'chat' || !thinking) return false
  const node = root.querySelector<HTMLElement>('.streaming-content')
  if (!node) return false
  const msgs = root.querySelector<HTMLElement>('.messages')
  const atBottom = msgs ? msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40 : false
  node.textContent = streamedText
  if (msgs && atBottom) msgs.scrollTop = msgs.scrollHeight
  return true
}

/** Actualiza sólo las líneas de progreso de herramientas. */
function updateTraceNode(): boolean {
  if (tab !== 'chat' || !thinking || streamedText) return false
  const box = root.querySelector<HTMLElement>('.tool-trace')
  if (!box) return false
  box.replaceChildren(...traceLines())
  const label = root.querySelector<HTMLElement>('.thinking-label')
  if (label) label.textContent = translateUiText(toolTrace.length ? 'Investigando el proyecto…' : 'Pensando…')
  return true
}

function traceLines(): HTMLElement[] {
  return toolTrace.slice(-6).map((line) => {
    const trace = div('tool-line')
    trace.textContent = `↳ ${line}`
    return trace
  })
}

function sameProvider(a: Settings['provider'] | undefined, b: Settings['provider']): boolean {
  return Boolean(a) && a!.provider === b.provider && a!.model === b.model && a!.baseUrl === b.baseUrl
}

function renderInner() {
  root.innerHTML = ''
  if (!settings) {
    const loading = div('empty')
    loading.textContent = 'QAPI'
    root.appendChild(loading)
    return
  }
  if (!settings.language) {
    root.appendChild(languageView())
    return
  }
  root.appendChild(tabsBar())
  root.appendChild(
    tab === 'chat' ? chatView()
      : tab === 'agents' ? agentsView()
      : tab === 'mcp' ? mcpView()
      : tab === 'skills' ? skillsView()
      : tab === 'settings' ? settingsView()
      : centycView(),
  )
  localizeUi(root)
  saveLocalState()
}

function languageView(): HTMLElement {
  const view = div('language-view')
  const card = div('language-card')
  const brand = document.createElement('h1')
  brand.textContent = 'QAPI'
  const title = document.createElement('h2')
  title.textContent = 'Selecciona tu idioma / Choose your language'
  const description = document.createElement('p')
  description.textContent = 'Podrás cambiarlo después en Configuración. / You can change it later in Settings.'
  const actions = div('language-actions')
  actions.appendChild(button('Español', 'btn btn-primary language-btn', () => chooseLanguage('es')))
  actions.appendChild(button('English', 'btn btn-ghost language-btn', () => chooseLanguage('en')))
  card.appendChild(brand)
  card.appendChild(title)
  card.appendChild(description)
  card.appendChild(actions)
  view.appendChild(card)
  return view
}

function chooseLanguage(language: UiLanguage) {
  if (!settings) return
  settings = { ...settings, language }
  draftProvider = { ...settings.provider }
  tab = settings.configured ? 'chat' : 'settings'
  applyTheme()
  post({ type: 'saveSettings', settings: { language } })
  render()
}

function tabsBar(): HTMLElement {
  const el = div('tabs')
  el.appendChild(tabBtn('chat', 'Agente QAPI'))
  el.appendChild(tabBtn('agents', 'Agentes'))
  el.appendChild(tabBtn('skills', 'Skills'))
  el.appendChild(tabBtn('mcp', 'MCP'))
  el.appendChild(tabBtn('settings', 'Configuración'))
  el.appendChild(tabBtn('centyc', 'Sobre Centyc'))
  return el
}

function tabBtn(id: TabId, label: string): HTMLElement {
  const b = div(`tab ${tab === id ? 'active' : ''}`)
  b.textContent = label
  b.onclick = () => { tab = id; validation = null; render() }
  return b
}

// ── Chat ────────────────────────────────────────────────────────────────────

function chatView(): HTMLElement {
  const view = div('view')
  const header = div('chat-header')
  const badge = div('badge')
  badge.textContent = projectName || 'sin proyecto'
  header.appendChild(badge)
  const indexBadge = div('index-badge')
  indexBadge.textContent = indexing ? 'Indexando…' : `${indexedFiles} archivos`
  header.appendChild(indexBadge)
  header.appendChild(div('spacer'))
  header.appendChild(fontControls())
  header.appendChild(iconBtn('Nueva conversación', 'Nueva', () => {
    selections = {}
    saveLocalState()
    post({ type: 'clearChat' })
  }))
  view.appendChild(header)

  if (usage) view.appendChild(contextBar(usage))

  const msgs = div('messages')
  if (history.length === 0) {
    const empty = div('empty')
    empty.textContent = 'Pregúntame sobre pruebas, cobertura, bugs o pídeme crear/editar archivos. Tengo el contexto del proyecto abierto.'
    msgs.appendChild(empty)
  }
  history.forEach((turn, index) => msgs.appendChild(bubble(turn, index)))
  if (executionCommand) msgs.appendChild(executionProgress(executionCommand))
  if (thinking) {
    if (streamedText) {
      const streaming = div('msg assistant')
      const streamingBubble = div('bubble')
      const streamingContent = div('message-content streaming-content')
      streamingContent.textContent = streamedText
      streamingBubble.appendChild(streamingContent)
      streamingBubble.appendChild(div('stream-caret'))
      streaming.appendChild(streamingBubble)
      msgs.appendChild(streaming)
    } else {
      const t = div('thinking')
      t.appendChild(div('dot-spin'))
      const label = document.createElement('span')
      label.className = 'thinking-label'
      label.textContent = toolTrace.length ? 'Investigando el proyecto…' : 'Pensando…'
      t.appendChild(label)
      msgs.appendChild(t)
      const trace = div('tool-trace')
      trace.append(...traceLines())
      msgs.appendChild(trace)
    }
  }
  view.appendChild(msgs)

  const composer = div('composer')
  const ta = document.createElement('textarea')
  ta.id = 'composer-input'
  ta.placeholder = mode === 'plan'
    ? 'Describe el objetivo del plan QA…'
    : 'Escribe tu consulta o petición… usa # para añadir contexto'
  ta.value = composerDraft
  ta.oninput = () => {
    composerDraft = ta.value
    saveLocalState()
    updateRefQuery(ta)
  }
  ta.onkeydown = (e) => {
    if (refSuggestions.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      applyContextRef(ta, refSuggestions[refIndex] || refSuggestions[0])
      return
    }
    if (refSuggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      refIndex = (refIndex + (e.key === 'ArrowDown' ? 1 : -1) + refSuggestions.length) % refSuggestions.length
      render()
      return
    }
    if (e.key === 'Escape' && refSuggestions.length) {
      e.preventDefault()
      clearRefSuggestions()
      render()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposer(ta) }
  }
  // Mientras hay una petición o un comando en curso, el botón pasa a "Detener".
  const busy = thinking || Boolean(executionCommand)
  const sendButton = busy
    ? button('Detener', 'btn btn-danger btn-sm', () => post({ type: 'cancel' }))
    : button('Enviar', 'btn btn-primary btn-sm', () => sendComposer(ta))
  if (busy) sendButton.title = 'Detener la solicitud en curso'

  const footer = div('composer-footer')
  footer.appendChild(modelPicker(busy))
  footer.appendChild(div('spacer'))
  const mcpSwitch = mcpAutoApproveSwitch()
  if (mcpSwitch) footer.appendChild(mcpSwitch)
  footer.appendChild(sendButton)
  composer.appendChild(ta)
  composer.appendChild(footer)
  if (refSuggestions.length) view.appendChild(contextRefList(ta))
  view.appendChild(composer)

  msgs.addEventListener('scroll', () => {
    messagesScroll.top = msgs.scrollTop
    messagesScroll.atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40
  })
  setTimeout(() => restoreMessagesScroll(msgs), 0)
  return view
}

/** Modelos del proveedor guardado, pedidos al host una vez por proveedor. */
let chatModels: Extract<ToWebview, { type: 'models' }> | null = null
let modelsRequestedFor = ''

/** Selector de modelo en el chat: cambia el modelo guardado sin ir a Configuración. */
function modelPicker(busy: boolean): HTMLElement {
  const current = settings!.provider
  if (current.provider !== modelsRequestedFor && settings!.configured) {
    modelsRequestedFor = current.provider
    post({ type: 'listModels' })
  }
  const models = chatModels?.provider === current.provider ? [...chatModels.models] : []
  if (current.model && !models.includes(current.model)) models.unshift(current.model)

  const select = document.createElement('select')
  select.id = 'composer-model'
  select.className = 'model-select'
  select.title = chatModels?.message
    ? tr(`No pude listar los modelos: ${chatModels.message}`, `Could not list models: ${chatModels.message}`)
    : tr('Modelo para los próximos mensajes', 'Model for the next messages')
  if (!models.length) {
    const option = document.createElement('option')
    option.textContent = tr('Sin modelo', 'No model')
    select.appendChild(option)
    select.disabled = true
    return select
  }
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    option.selected = model === current.model
    select.appendChild(option)
  }
  // Se cambia entre mensajes: la respuesta en curso ya usa el modelo con el que empezó.
  select.disabled = busy
  select.onchange = () => {
    if (!settings) return
    const model = select.value
    const contextLimit = chatModels?.limits?.[model]
    settings = { ...settings, provider: { ...settings.provider, model, contextLimit } }
    post({
      type: 'saveSettings',
      settings: { provider: { provider: current.provider, baseUrl: current.baseUrl, model, contextLimit } },
    })
    toast(tr(`Modelo: ${model}`, `Model: ${model}`))
  }
  return select
}

/** Switch de autoaprobación MCP; sólo aparece si hay algún servidor activo. */
function mcpAutoApproveSwitch(): HTMLElement | undefined {
  if (!Object.values(settings!.mcpEnabled).some(Boolean)) return undefined
  const label = document.createElement('label')
  label.className = 'toggle'
  label.title = tr(
    'Ejecuta las tools de los servidores MCP activos sin pedir confirmación en cada llamada. Úsalo sólo con servidores confiables.',
    'Runs tools from enabled MCP servers without asking for confirmation on each call. Use it only with trusted servers.',
  )
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = 'composer-mcp-auto'
  input.checked = Boolean(settings!.mcpAutoApprove)
  input.setAttribute('role', 'switch')
  input.onchange = () => {
    if (!settings) return
    settings = { ...settings, mcpAutoApprove: input.checked }
    post({ type: 'saveSettings', settings: { mcpAutoApprove: input.checked } })
  }
  const text = document.createElement('span')
  text.textContent = 'Autoaprobar MCP'
  label.append(text, input)
  return label
}

function sendComposer(ta: HTMLTextAreaElement) {
  const text = ta.value.trim()
  if (!text || thinking) return
  composerDraft = ''
  ta.value = ''
  clearRefSuggestions()
  saveLocalState()
  sendText(text, mode)
}

function sendText(text: string, messageMode: AgentMode) {
  if (!text.trim() || thinking) return
  tab = 'chat'
  // Al enviar, el usuario quiere ver la respuesta: se vuelve al final del historial.
  messagesScroll.atBottom = true
  post({ type: 'sendMessage', text, mode: messageMode })
}

/** Botones -a/+A para ajustar el tamaño de fuente desde el encabezado del chat. */
function fontControls(): HTMLElement {
  const wrap = div('font-controls')
  const current = settings?.fontSize ?? 13
  const minus = document.createElement('button')
  minus.className = 'font-btn'
  minus.title = tr('Reducir tamaño de fuente', 'Decrease font size')
  minus.innerHTML = '<span class="font-minus">a</span>'
  minus.disabled = current <= FONT_MIN
  minus.onclick = () => changeFontSize(-1)
  const plus = document.createElement('button')
  plus.className = 'font-btn'
  plus.title = tr('Aumentar tamaño de fuente', 'Increase font size')
  plus.innerHTML = '<span class="font-plus">A</span>'
  plus.disabled = current >= FONT_MAX
  plus.onclick = () => changeFontSize(1)
  wrap.appendChild(minus)
  wrap.appendChild(plus)
  return wrap
}

let fontSaveTimer: ReturnType<typeof setTimeout> | undefined
function changeFontSize(delta: number) {
  if (!settings) return
  const next = Math.max(FONT_MIN, Math.min(FONT_MAX, (settings.fontSize || 13) + delta))
  if (next === settings.fontSize) return
  settings = { ...settings, fontSize: next }
  document.documentElement.style.setProperty('--qp-font', `${next}px`)
  // Clics rápidos se agrupan en un solo guardado: evita que respuestas
  // intermedias del host devuelvan un tamaño viejo.
  if (fontSaveTimer) clearTimeout(fontSaveTimer)
  fontSaveTimer = setTimeout(() => post({ type: 'saveSettings', settings: { fontSize: settings?.fontSize ?? next } }), 300)
  render()
}

// ── Agentes personalizados ────────────────────────────────────────────────

function agentsView(): HTMLElement {
  const view = div('view agents-view')

  if (editingAgent) {
    view.appendChild(agentEditor(editingAgent))
    return view
  }

  const header = div('agents-header')
  const title = document.createElement('p')
  title.className = 'hint'
  title.textContent = tr(
    'Presets con instrucción fija y archivos de entrada. Ejecútalos con un clic o crea los tuyos.',
    'Presets with a fixed instruction and input files. Run them with one click or create your own.',
  )
  header.appendChild(title)
  header.appendChild(button(tr('+ Crear agente', '+ Create agent'), 'btn btn-primary btn-sm', () => {
    editingAgent = { slug: '', name: '', description: '', instructions: '', outputMode: 'chat' }
    editingAgentPreviousSlug = undefined
    render()
  }))
  view.appendChild(header)

  const list = div('agents-grid')
  if (!customAgents.length) {
    const empty = div('muted')
    empty.textContent = tr('Cargando agentes…', 'Loading agents…')
    list.appendChild(empty)
  }
  for (const agent of customAgents) list.appendChild(agentCard(agent))
  view.appendChild(list)

  if (fileModalAgentSlug) {
    const agent = customAgents.find((item) => item.slug === fileModalAgentSlug)
    if (agent) view.appendChild(agentFileModal(agent))
    else fileModalAgentSlug = null
  }
  return view
}

function agentCard(agent: CustomAgentDefinition): HTMLElement {
  const card = div('agent-card')
  const header = div('agent-card-header')
  const icon = div('agent-icon')
  icon.textContent = agent.icon || '🤖'
  header.appendChild(icon)
  const title = div('agent-title')
  title.textContent = agent.name
  header.appendChild(title)
  if (!agent.builtIn) {
    const actions = div('agent-card-actions')
    actions.appendChild(iconBtn(tr('Editar', 'Edit'), '✎', () => {
      editingAgent = { ...agent }
      editingAgentPreviousSlug = agent.slug
      render()
    }))
    actions.appendChild(iconBtn(tr('Eliminar', 'Delete'), '✕', () => {
      post({ type: 'deleteCustomAgent', slug: agent.slug })
    }))
    header.appendChild(actions)
  }
  card.appendChild(header)

  const description = div('agent-description')
  description.textContent = agent.description || tr('Sin descripción.', 'No description.')
  card.appendChild(description)

  const isFilesMode = (agent.inputMode || 'files') === 'files' && agent.inputGlob
  const isFreeTextMode = agent.inputMode === 'freeText'

  if (isFilesMode) {
    const selectedCount = (agentSelectedFiles[agent.slug] || []).length
    const pickRow = div('agent-pick-row')
    pickRow.appendChild(button(
      selectedCount
        ? tr(`${selectedCount} archivo(s) seleccionado(s)`, `${selectedCount} file(s) selected`)
        : tr('Seleccionar archivos…', 'Select files…'),
      'btn btn-ghost btn-sm',
      () => {
        fileModalAgentSlug = agent.slug
        agentFileFilter[agent.slug] = ''
        post({ type: 'suggestAgentFiles', glob: agent.inputGlob || '' })
        render()
      },
    ))
    card.appendChild(pickRow)
  }

  if (isFreeTextMode) {
    card.appendChild(agentFreeTextInput(agent))
  }

  const runRow = div('agent-run-row')
  const selectedFiles = agentSelectedFiles[agent.slug] || []
  const freeText = agentFreeText[agent.slug] || ''
  const canRun = isFreeTextMode ? Boolean(freeText.trim()) : (isFilesMode ? selectedFiles.length > 0 : true)
  const runBtn = button(tr('Ejecutar', 'Run'), 'btn btn-primary btn-sm', () => {
    tab = 'chat'
    post({ type: 'runCustomAgent', slug: agent.slug, files: selectedFiles, freeText: freeText || undefined })
    render()
  })
  runBtn.disabled = thinking || !canRun
  runRow.appendChild(runBtn)
  card.appendChild(runRow)
  return card
}

function agentFreeTextInput(agent: CustomAgentDefinition): HTMLElement {
  const wrap = div('agent-freetext')
  const textarea = document.createElement('textarea')
  textarea.className = 'memory-editor'
  textarea.placeholder = tr(
    'Pega el texto, requisito o especificación aquí…',
    'Paste the text, requirement, or specification here…',
  )
  textarea.value = agentFreeText[agent.slug] || ''
  textarea.oninput = () => {
    agentFreeText[agent.slug] = textarea.value
    saveLocalState()
  }
  wrap.appendChild(textarea)

  const attachRow = div('row')
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.md,.txt,.feature,.json,.yaml,.yml,.csv'
  fileInput.className = 'agent-file-attach'
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    // Un archivo enorme congelaba la webview; el host igual recorta a ~200k caracteres.
    if (file.size > 1024 * 1024) {
      toast(tr('El archivo supera 1 MB; adjunta un extracto.', 'The file exceeds 1 MB; attach an excerpt.'))
      fileInput.value = ''
      return
    }
    const text = await file.text()
    agentFreeText[agent.slug] = text
    saveLocalState()
    render()
  }
  attachRow.appendChild(fileInput)
  const hint = div('muted')
  hint.textContent = tr('Formatos: .md, .txt, .feature, .json, .yaml, .csv', 'Formats: .md, .txt, .feature, .json, .yaml, .csv')
  attachRow.appendChild(hint)
  wrap.appendChild(attachRow)
  return wrap
}

function agentFileModal(agent: CustomAgentDefinition): HTMLElement {
  const overlay = div('agent-modal-overlay')
  overlay.onclick = (event) => { if (event.target === overlay) closeAgentFileModal() }

  const modal = div('agent-modal')
  const header = div('agent-modal-header')
  const title = document.createElement('h3')
  title.textContent = tr(`Seleccionar archivos — ${agent.name}`, `Select files — ${agent.name}`)
  header.appendChild(title)
  header.appendChild(iconBtn(tr('Cerrar', 'Close'), '✕', closeAgentFileModal))
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'agent-modal-filter'
  input.placeholder = tr(`Filtrar (${agent.inputGlob})…`, `Filter (${agent.inputGlob})…`)
  input.value = agentFileFilter[agent.slug] || ''
  input.oninput = () => { agentFileFilter[agent.slug] = input.value; render() }
  modal.appendChild(input)

  const filterText = (agentFileFilter[agent.slug] || '').toLowerCase()
  const selected = new Set(agentSelectedFiles[agent.slug] || [])
  const candidates = agentFileSuggestions
    .filter((path) => !filterText || path.toLowerCase().includes(filterText))
    .slice(0, 200)

  const list = div('agent-modal-list')
  if (!candidates.length) {
    const empty = div('muted')
    empty.textContent = tr('Sin archivos que coincidan.', 'No matching files.')
    list.appendChild(empty)
  }
  for (const path of candidates) {
    const row = div('agent-file-row')
    const check = checkbox(selected.has(path), () => {
      if (check.checked) selected.add(path); else selected.delete(path)
      agentSelectedFiles[agent.slug] = [...selected]
      saveLocalState()
      render()
    })
    row.appendChild(labeledControl(check, path))
    list.appendChild(row)
  }
  modal.appendChild(list)

  const actions = div('row agent-modal-actions')
  actions.appendChild(button(tr('Seleccionar todos', 'Select all'), 'btn btn-ghost btn-sm', () => {
    agentSelectedFiles[agent.slug] = [...new Set([...selected, ...candidates])]
    saveLocalState()
    render()
  }))
  actions.appendChild(button(tr('Limpiar', 'Clear'), 'btn btn-ghost btn-sm', () => {
    agentSelectedFiles[agent.slug] = []
    saveLocalState()
    render()
  }))
  actions.appendChild(button(tr('Listo', 'Done'), 'btn btn-primary btn-sm', closeAgentFileModal))
  modal.appendChild(actions)

  overlay.appendChild(modal)
  return overlay
}

function closeAgentFileModal() {
  fileModalAgentSlug = null
  render()
}

function agentEditor(agent: CustomAgentDefinition): HTMLElement {
  const view = div('agent-editor')
  const title = document.createElement('h3')
  title.textContent = editingAgentPreviousSlug
    ? tr('Editar agente', 'Edit agent')
    : tr('Nuevo agente', 'New agent')
  view.appendChild(title)

  const nameField = field(tr('Nombre', 'Name'), inputEl('text', agent.name, (value) => { agent.name = value }))
  view.appendChild(nameField)

  const descriptionField = field(
    tr('Descripción', 'Description'),
    inputEl('text', agent.description, (value) => { agent.description = value }),
  )
  view.appendChild(descriptionField)

  const iconField = field(
    tr('Icono (emoji, opcional)', 'Icon (emoji, optional)'),
    inputEl('text', agent.icon || '', (value) => { agent.icon = value }),
  )
  view.appendChild(iconField)

  const inputModeSelect = document.createElement('select')
  for (const [value, es, en] of [
    ['files', 'Seleccionar archivos del proyecto', 'Select files from the project'],
    ['freeText', 'Texto libre o archivo adjunto', 'Free text or attached file'],
  ] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = tr(es, en)
    option.selected = (agent.inputMode || 'files') === value
    inputModeSelect.appendChild(option)
  }
  inputModeSelect.onchange = () => { agent.inputMode = inputModeSelect.value as CustomAgentDefinition['inputMode']; render() }
  view.appendChild(field(tr('Entrada', 'Input'), inputModeSelect))

  if ((agent.inputMode || 'files') === 'files') {
    const globField = field(
      tr('Glob de archivos de entrada', 'Input files glob'),
      inputEl('text', agent.inputGlob || '', (value) => { agent.inputGlob = value }),
    )
    view.appendChild(globField)
  }

  const instructionsWrap = div('field')
  const instructionsLabel = document.createElement('label')
  instructionsLabel.textContent = tr('Instrucciones', 'Instructions')
  instructionsWrap.appendChild(instructionsLabel)
  const instructionsEditor = document.createElement('textarea')
  instructionsEditor.className = 'memory-editor'
  instructionsEditor.value = agent.instructions
  instructionsEditor.oninput = () => { agent.instructions = instructionsEditor.value }
  instructionsWrap.appendChild(instructionsEditor)
  view.appendChild(instructionsWrap)

  const outputSelect = document.createElement('select')
  for (const [value, es, en] of [['chat', 'Responder en el chat', 'Reply in chat'], ['file', 'Crear/actualizar un archivo', 'Create/update a file']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = tr(es, en)
    option.selected = agent.outputMode === value
    outputSelect.appendChild(option)
  }
  outputSelect.onchange = () => { agent.outputMode = outputSelect.value as CustomAgentOutputMode; render() }
  view.appendChild(field(tr('Salida', 'Output'), outputSelect))

  if (agent.outputMode === 'file') {
    const pathField = field(
      tr('Ruta de salida (admite {name} y {date})', 'Output path (supports {name} and {date})'),
      inputEl('text', agent.outputPathTemplate || 'docs/{name}.md', (value) => { agent.outputPathTemplate = value }),
    )
    view.appendChild(pathField)
  }

  const actions = div('row')
  actions.appendChild(button(tr('Guardar', 'Save'), 'btn btn-primary btn-sm', () => {
    if (!agent.name.trim() || !agent.instructions.trim()) {
      toast(tr('Nombre e instrucciones son obligatorios.', 'Name and instructions are required.'))
      return
    }
    post({ type: 'saveCustomAgent', agent: { ...agent, slug: agent.slug || agent.name }, previousSlug: editingAgentPreviousSlug })
    editingAgent = null
    render()
  }))
  actions.appendChild(button(tr('Cancelar', 'Cancel'), 'btn btn-ghost btn-sm', () => {
    editingAgent = null
    render()
  }))
  view.appendChild(actions)
  return view
}

// ── Specs ───────────────────────────────────────────────────────────────────

function specsCard(): HTMLElement {
  const box = card(
    tr('Specs', 'Specs'),
    tr(
      'Convierte una solicitud compleja en requisitos, diseño y tareas versionables en .qapi/specs.',
      'Turn a complex request into versioned requirements, design and tasks under .qapi/specs.',
    ),
  )

  const head = div('trace-head')
  head.appendChild(button(tr('Actualizar', 'Refresh'), 'btn btn-ghost btn-sm', () => post({ type: 'refreshSpecs' })))
  head.appendChild(button(tr('Nuevo spec', 'New spec'), 'btn btn-primary btn-sm', () => {
    tab = 'chat'
    composerDraft = tr(
      'Crea un spec para: ',
      'Create a spec for: ',
    )
    saveLocalState()
    render()
  }))
  box.appendChild(head)

  if (!specs.length) {
    const empty = div('muted')
    empty.textContent = tr('Todavía no hay specs.', 'There are no specs yet.')
    box.appendChild(empty)
    return box
  }

  for (const spec of specs) {
    const item = div('spec-item')
    const header = div('spec-header')
    const title = div('spec-title')
    title.textContent = spec.title
    const phase = div(`spec-phase phase-${spec.phase}`)
    phase.textContent = phaseLabel(spec.phase)
    header.appendChild(title)
    header.appendChild(phase)
    item.appendChild(header)

    const all = flattenTasks(spec.tasks)
    const done = all.filter((task) => task.status === 'completed').length
    const meta = div('spec-meta')
    meta.textContent = all.length
      ? tr(`${spec.slug} · ${done}/${all.length} tareas completadas`, `${spec.slug} · ${done}/${all.length} tasks completed`)
      : spec.slug
    item.appendChild(meta)

    const docs = div('spec-docs')
    for (const [kind, label] of [['requirements', tr('Requisitos', 'Requirements')], ['design', tr('Diseño', 'Design')], ['tasks', tr('Tareas', 'Tasks')]] as const) {
      const available = kind === 'requirements' ? spec.hasRequirements : kind === 'design' ? spec.hasDesign : spec.hasTasks
      if (!available) continue
      docs.appendChild(linkBtn(label, () => post({ type: 'openSpecDocument', slug: spec.slug, kind })))
    }
    if (docs.childElementCount) item.appendChild(docs)

    const nextPhase = pendingPhase(spec)
    if (nextPhase) {
      item.appendChild(button(phaseAction(nextPhase), 'btn btn-primary btn-sm', () => {
        post({ type: 'advanceSpecPhase', slug: spec.slug, phase: nextPhase })
      }))
    }

    if (spec.tasks.length) {
      const list = div('spec-tasks')
      for (const task of spec.tasks) list.appendChild(specTaskRow(spec, task))
      item.appendChild(list)
    }

    box.appendChild(item)
  }
  return box
}

// ── Referencias de contexto (#) ──────────────────────────────────────────────

/** Detecta el token `#…` que el usuario está escribiendo junto al caret. */
function activeRefToken(ta: HTMLTextAreaElement): { start: number; query: string } | undefined {
  const caret = ta.selectionStart ?? ta.value.length
  const before = ta.value.slice(0, caret)
  const start = before.lastIndexOf('#')
  if (start < 0) return undefined
  const token = before.slice(start)
  if (/\s/.test(token)) return undefined
  return { start, query: token.slice(1) }
}

function updateRefQuery(ta: HTMLTextAreaElement) {
  const token = activeRefToken(ta)
  if (!token) {
    if (refSuggestions.length) {
      clearRefSuggestions()
      render()
    }
    return
  }
  refQueryStart = token.start
  post({ type: 'suggestContextRefs', query: token.query })
}

function applyContextRef(ta: HTMLTextAreaElement, reference: string) {
  if (refQueryStart < 0) return
  const caret = ta.selectionStart ?? ta.value.length
  const next = `${ta.value.slice(0, refQueryStart)}${reference} ${ta.value.slice(caret)}`
  composerDraft = next
  clearRefSuggestions()
  saveLocalState()
  render()
  const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (textarea) {
    const position = refQueryStart + reference.length + 1
    textarea.focus()
    textarea.setSelectionRange(position, position)
  }
}

function clearRefSuggestions() {
  refSuggestions = []
  refIndex = 0
  refQueryStart = -1
}

function contextRefList(ta: HTMLTextAreaElement): HTMLElement {
  const box = div('ref-suggestions')
  refSuggestions.slice(0, 8).forEach((reference, position) => {
    const item = div(`ref-item ${position === refIndex ? 'active' : ''}`)
    item.textContent = reference
    item.onmousedown = (event) => {
      event.preventDefault()
      applyContextRef(ta, reference)
    }
    box.appendChild(item)
  })
  return box
}

function specTaskRow(spec: SpecSummary, task: SpecTask): HTMLElement {
  const row = div(`spec-task status-${task.status}`)
  const label = div('spec-task-label')
  label.textContent = `${statusMark(task.status)} ${task.id}. ${task.title}`
  row.appendChild(label)
  if (task.status !== 'completed') {
    const run = button(tr('Ejecutar', 'Run'), 'btn btn-ghost btn-xs', () => {
      post({ type: 'runSpecTask', slug: spec.slug, taskId: task.id })
    })
    run.disabled = thinking
    row.appendChild(run)
  }
  return row
}

function flattenTasks(tasks: SpecTask[]): SpecTask[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.children)])
}

function statusMark(status: SpecTask['status']): string {
  return status === 'completed' ? '✓' : status === 'in-progress' ? '◐' : '○'
}

function phaseLabel(phase: SpecPhase): string {
  const labels: Record<SpecPhase, [string, string]> = {
    requirements: ['requisitos', 'requirements'],
    design: ['diseño', 'design'],
    tasks: ['tareas', 'tasks'],
    execution: ['ejecución', 'execution'],
    done: ['completado', 'done'],
  }
  return tr(...labels[phase])
}

function phaseAction(phase: SpecPhase): string {
  const labels: Record<SpecPhase, [string, string]> = {
    requirements: ['Generar requisitos', 'Generate requirements'],
    design: ['Generar diseño', 'Generate design'],
    tasks: ['Generar tareas', 'Generate tasks'],
    execution: ['Ejecutar siguiente tarea', 'Run next task'],
    done: ['Revisar cierre', 'Review completion'],
  }
  return tr(...labels[phase])
}

/** Fase que el usuario puede aprobar a continuación. */
function pendingPhase(spec: SpecSummary): SpecPhase | undefined {
  if (!spec.hasRequirements) return 'requirements'
  if (!spec.hasDesign) return 'design'
  if (!spec.hasTasks) return 'tasks'
  const all = flattenTasks(spec.tasks)
  if (all.some((task) => task.status !== 'completed')) return 'execution'
  return undefined
}

function contextBar(u: ContextUsage): HTMLElement {
  const wrap = div('ctx')
  const pct = Math.round(u.ratio * 100)
  const usedLabel = u.used >= 1000 ? `${(u.used / 1000).toFixed(1)}k` : String(u.used)
  const kMax = u.limit >= 1000 ? `${Math.round(u.limit / 1000)}k` : String(u.limit)
  const label = div('ctx-label')
  label.textContent = `Memoria del chat · ${usedLabel} / ${kMax} tokens (${pct}%)`
  const track = div('ctx-track')
  const fill = div('ctx-fill')
  fill.style.width = pct === 0 ? '0%' : `${Math.max(2, Math.min(100, pct))}%`
  if (u.needsSummary) fill.classList.add('danger')
  else if (u.ratio >= 0.6) fill.classList.add('warn')
  track.appendChild(fill)
  wrap.appendChild(label)
  wrap.appendChild(track)
  if (u.needsSummary) {
    const note = div('ctx-note')
    note.textContent = 'Al enviar, resumiré la conversación para liberar contexto.'
    wrap.appendChild(note)
  }
  return wrap
}

function bubble(turn: ChatTurn, index: number): HTMLElement {
  const wrap = div(`msg ${turn.role}`)
  const content = div('bubble')
  const messageContent = div('message-content')
  if (turn.summary) content.classList.add('summary')

  if (turn.mode) {
    const modeRow = div('message-mode')
    const modeBadge = div(`mode-badge mode-${turn.mode}`)
    modeBadge.textContent = turn.mode === 'plan' ? 'Plan QA' : (turn.role === 'user' ? 'Usuario' : 'Agente')
    modeRow.appendChild(modeBadge)
    content.appendChild(modeRow)
  }

  if (turn.role === 'assistant') messageContent.innerHTML = renderMarkdown(turn.text)
  else messageContent.textContent = turn.text
  content.appendChild(messageContent)

  if (turn.tools?.length) {
    const tools = div('tool-badges')
    tools.textContent = `herramientas: ${turn.tools.join(', ')}`
    content.appendChild(tools)
  }
  if (turn.contextSources?.length) content.appendChild(contextSources(turn.contextSources))
  if (turn.role === 'assistant' && turn.mode === 'plan') {
    content.appendChild(button(tr('Ejecutar plan', 'Execute plan'), 'btn btn-primary btn-sm plan-action', () => {
      sendText(`${tr('Implementa el siguiente Plan QA aprobado:', 'Implement the following approved QA Plan:')}\n\n${turn.text}`, 'chat')
    }))
  }
  if (turn.proposals?.length) content.appendChild(proposalsView(turn, index))
  if (turn.commandProposals?.length) content.appendChild(commandsView(turn.commandProposals, index))
  if (turn.runs?.length) content.appendChild(runsView(turn.runs))
  if (turn.verificationNote) {
    const note = div('verification-note')
    note.textContent = turn.verificationNote
    content.appendChild(note)
  }

  if (turn.applied && !turn.undone) {
    const state = div('change-state')
    const ok = div('applied')
    ok.textContent = '✓ Cambios aplicados'
    state.appendChild(ok)
    if (turn.checkpointId) state.appendChild(linkBtn('Deshacer', () => post({ type: 'undoCheckpoint', checkpointId: turn.checkpointId! })))
    else if (turn.proposals) state.appendChild(linkBtn('Deshacer', () => post({ type: 'undoProposals', turnIndex: index, turnId: turn.id, proposals: turn.proposals! })))
    content.appendChild(state)
  }
  if (turn.undone) {
    const undone = div('undone')
    undone.textContent = '↩ Deshecho'
    content.appendChild(undone)
  }
  wrap.appendChild(content)
  return wrap
}

function contextSources(sources: string[]): HTMLElement {
  const box = div('context-sources')
  const title = div('section-label')
  title.textContent = 'Contexto usado'
  box.appendChild(title)
  const chips = div('source-chips')
  for (const source of sources) {
    const chip = div('source-chip')
    chip.textContent = source
    chips.appendChild(chip)
  }
  box.appendChild(chips)
  return box
}

function proposalsView(turn: ChatTurn, turnIndex: number): HTMLElement {
  const proposals = turn.proposals || []
  const box = div('proposals')
  const title = div('section-label')
  title.textContent = `${proposals.length} cambio(s) propuesto(s)`
  box.appendChild(title)

  if (turn.applied) {
    if (turn.reviewFindings) {
      const applliedReview = div('review-findings')
      const label = div('section-label')
      label.textContent = tr('Revisión automática', 'Automatic review')
      applliedReview.appendChild(label)
      const body = div('review-body')
      body.textContent = turn.reviewFindings
      applliedReview.appendChild(body)
      box.appendChild(applliedReview)
    }
    for (const proposal of proposals) box.appendChild(proposalDiff(proposal, turnIndex, false))
    return box
  }

  if (turn.reviewFindings) {
    const review = div('review-findings')
    const reviewTitle = div('section-label')
    reviewTitle.textContent = tr('Revisión automática', 'Automatic review')
    review.appendChild(reviewTitle)
    const body = div('review-body')
    body.textContent = turn.reviewFindings
    review.appendChild(body)
    box.appendChild(review)
  }

  const eligible = proposals.filter(isSelectableProposal)
  ensureSelectionDefaults(turnIndex, eligible)
  const selected = selectedCount(turnIndex, eligible)
  const total = eligible.reduce((sum, proposal) => sum + proposal.hunks!.length, 0)
  const globalRow = div('selection-toolbar')
  const global = checkbox(selected === total && total > 0, () => {
    setAllSelections(turnIndex, eligible, global.checked)
    render()
  })
  global.indeterminate = selected > 0 && selected < total
  global.disabled = total === 0
  globalRow.appendChild(labeledControl(global, `Todos los cambios · ${selected}/${total}`))
  box.appendChild(globalRow)

  for (const proposal of proposals) box.appendChild(proposalDiff(proposal, turnIndex, true))

  const actions = div('proposal-actions')
  const applySelected = button('Aplicar seleccionados', 'btn btn-primary btn-sm', () => {
    disableWhileApplying(applySelected, applyAll)
    post({ type: 'applyProposals', turnIndex, turnId: turnId(turnIndex), selections: proposalSelections(turnIndex, eligible, false) })
  })
  applySelected.disabled = selected === 0
  const applyAll = button('Aplicar todo', 'btn btn-ghost btn-sm', () => {
    disableWhileApplying(applySelected, applyAll)
    post({ type: 'applyProposals', turnIndex, turnId: turnId(turnIndex), selections: proposalSelections(turnIndex, eligible, true) })
  })
  applyAll.disabled = total === 0
  actions.appendChild(applySelected)
  actions.appendChild(applyAll)
  box.appendChild(actions)
  return box
}

/** Evita el doble clic mientras el host aplica; el siguiente render los rehabilita. */
function disableWhileApplying(...buttons: HTMLButtonElement[]) {
  for (const item of buttons) item.disabled = true
}

function proposalDiff(proposal: FileProposal, turnIndex: number, selectable: boolean): HTMLElement {
  const details = trackOpen(document.createElement('details'), `prop:${turnKey(turnIndex)}:${proposal.path}`)
  details.className = 'prop'
  const summary = document.createElement('summary')
  const info = div('prop-summary-info')
  const path = div('prop-path')
  path.textContent = proposal.path
  const meta = div('prop-meta')
  meta.textContent = proposal.existed ? 'modifica' : 'nuevo'
  info.appendChild(path)
  info.appendChild(meta)

  if (selectable && isSelectableProposal(proposal)) {
    const ids = selections[turnKey(turnIndex)]?.[proposal.id!] || []
    const fileCheck = checkbox(ids.length === proposal.hunks!.length, () => {
      setProposalSelection(turnIndex, proposal.id!, fileCheck.checked ? proposal.hunks!.map((h) => h.id) : [])
      render()
    })
    fileCheck.indeterminate = ids.length > 0 && ids.length < proposal.hunks!.length
    fileCheck.onclick = (event) => event.stopPropagation()
    summary.appendChild(fileCheck)
  }
  summary.appendChild(info)
  details.appendChild(summary)

  const purpose = div('prop-purpose')
  purpose.textContent = proposal.purpose || (proposal.existed
    ? tr(`Actualizar ${proposal.path} como parte del cambio solicitado.`, `Update ${proposal.path} as part of the requested change.`)
    : tr(`Crear ${proposal.path} para implementar el cambio solicitado.`, `Create ${proposal.path} to implement the requested change.`))
  details.appendChild(purpose)

  const hunks = visibleHunks(proposal)
  if (!isSelectableProposal(proposal) && selectable) {
    const warning = div('prop-warning')
    warning.textContent = 'Vista histórica: esta propuesta no tiene IDs de selección aplicables.'
    details.appendChild(warning)
  }
  for (const hunk of hunks) details.appendChild(hunkView(proposal, hunk, turnIndex, selectable && isSelectableProposal(proposal)))
  return details
}

function hunkView(proposal: FileProposal, hunk: DiffHunk, turnIndex: number, selectable: boolean): HTMLElement {
  const block = div('diff-hunk')
  const header = div('hunk-header')
  if (selectable) {
    const selected = selections[turnKey(turnIndex)]?.[proposal.id!] || []
    const control = checkbox(selected.includes(hunk.id), () => {
      const next = new Set(selections[turnKey(turnIndex)]?.[proposal.id!] || [])
      if (control.checked) next.add(hunk.id)
      else next.delete(hunk.id)
      setProposalSelection(turnIndex, proposal.id!, proposal.hunks!.filter((item) => next.has(item.id)).map((item) => item.id))
      render()
    })
    header.appendChild(control)
  }
  const label = div('hunk-label')
  label.textContent = hunk.label || `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  header.appendChild(label)
  block.appendChild(header)

  const code = div('diff-code')
  hunk.oldLines.forEach((line, offset) => code.appendChild(diffLine('old', '-', hunk.oldStart + offset, line)))
  hunk.newLines.forEach((line, offset) => code.appendChild(diffLine('new', '+', hunk.newStart + offset, line)))
  if (!hunk.oldLines.length && !hunk.newLines.length) {
    const empty = div('diff-empty')
    empty.textContent = 'Sin cambios de contenido.'
    code.appendChild(empty)
  }
  block.appendChild(code)
  return block
}

function diffLine(kind: 'old' | 'new', marker: string, lineNumber: number, text: string): HTMLElement {
  const row = div(`diff-line ${kind}`)
  const number = div('diff-number')
  number.textContent = String(lineNumber)
  const sign = div('diff-sign')
  sign.textContent = marker
  const code = document.createElement('code')
  code.textContent = text
  row.appendChild(number)
  row.appendChild(sign)
  row.appendChild(code)
  return row
}

function visibleHunks(proposal: FileProposal): DiffHunk[] {
  if (proposal.hunks?.length) return proposal.hunks
  const oldLines = splitPreviewLines(proposal.previous || '')
  const newLines = splitPreviewLines(proposal.content)
  return [{
    id: `preview-${proposal.path}`,
    label: 'Cambio completo (vista previa)',
    oldStart: 1,
    oldCount: oldLines.length,
    newStart: 1,
    newCount: newLines.length,
    oldLines,
    newLines,
  }]
}

/** Clave estable de un turno: su id (los índices cambian al recortar el historial). */
function turnKey(turnIndex: number): string {
  return history[turnIndex]?.id || String(turnIndex)
}
function turnId(turnIndex: number): string | undefined {
  return history[turnIndex]?.id
}

/** Recuerda si un <details> estaba abierto entre renders completos. */
function trackOpen(element: HTMLDetailsElement, key: string): HTMLDetailsElement {
  element.open = openAccordions.has(key)
  element.addEventListener('toggle', () => {
    if (element.open) openAccordions.add(key)
    else openAccordions.delete(key)
  })
  return element
}

function splitPreviewLines(text: string): string[] { return text ? text.replace(/\r\n/g, '\n').split('\n') : [] }
function isSelectableProposal(proposal: FileProposal): boolean { return Boolean(proposal.id && proposal.hunks?.length) }

function ensureSelectionDefaults(turnIndex: number, proposals: FileProposal[]) {
  const key = turnKey(turnIndex)
  let changed = false
  if (!selections[key]) { selections[key] = {}; changed = true }
  for (const proposal of proposals) {
    if (!(proposal.id! in selections[key])) {
      selections[key][proposal.id!] = proposal.hunks!.map((hunk) => hunk.id)
      changed = true
    }
  }
  if (changed) saveLocalState()
}

function setProposalSelection(turnIndex: number, proposalId: string, hunkIds: string[]) {
  const key = turnKey(turnIndex)
  selections[key] ||= {}
  selections[key][proposalId] = hunkIds
  saveLocalState()
}

function setAllSelections(turnIndex: number, proposals: FileProposal[], checked: boolean) {
  for (const proposal of proposals) setProposalSelection(turnIndex, proposal.id!, checked ? proposal.hunks!.map((h) => h.id) : [])
}

function selectedCount(turnIndex: number, proposals: FileProposal[]): number {
  return proposals.reduce((sum, proposal) => sum + (selections[turnKey(turnIndex)]?.[proposal.id!]?.length || 0), 0)
}

function proposalSelections(turnIndex: number, proposals: FileProposal[], all: boolean) {
  return proposals.map((proposal) => ({
    proposalId: proposal.id!,
    hunkIds: all ? proposal.hunks!.map((hunk) => hunk.id) : (selections[turnKey(turnIndex)]?.[proposal.id!] || []),
  }))
}

function commandsView(commands: NonNullable<ChatTurn['commandProposals']>, turnIndex: number): HTMLElement {
  const box = div('commands')
  const title = div('section-label')
  title.textContent = 'Comandos propuestos'
  box.appendChild(title)
  for (const command of commands) {
    const item = div('command-item')
    const info = div('command-info')
    const code = document.createElement('code')
    code.textContent = command.command
    const reason = div('command-reason')
    reason.textContent = command.reason
    info.appendChild(code)
    info.appendChild(reason)
    item.appendChild(info)
    const run = button('Ejecutar', 'btn btn-ghost btn-sm', () => {
      run.disabled = true
      post({ type: 'runCommand', turnIndex, turnId: turnId(turnIndex), commandId: command.id })
    })
    run.disabled = Boolean(executionCommand)
    item.appendChild(run)
    box.appendChild(item)
  }
  return box
}

function runsView(runs: ExecutionRun[]): HTMLElement {
  const box = div('runs')
  const title = div('section-label')
  title.textContent = 'Ejecuciones'
  box.appendChild(title)
  for (const run of runs) {
    const details = trackOpen(document.createElement('details'), `run:${run.id}`)
    details.className = `run run-${run.status}`
    const summary = document.createElement('summary')
    const status = div('run-status')
    status.textContent = runStatusLabel(run.status)
    const command = document.createElement('code')
    command.textContent = run.command
    const duration = div('run-duration')
    duration.textContent = tr(
      `${run.durationMs} ms · salida ${run.exitCode === undefined ? 'n/d' : run.exitCode}${run.automatic ? ' · automático' : ''}`,
      `${run.durationMs} ms · exit ${run.exitCode === undefined ? 'n/a' : run.exitCode}${run.automatic ? ' · auto' : ''}`,
    )
    summary.appendChild(status)
    summary.appendChild(command)
    summary.appendChild(duration)
    details.appendChild(summary)
    const output = document.createElement('pre')
    output.className = 'run-output'
    output.textContent = run.output || '(sin salida)'
    details.appendChild(output)
    if (run.status === 'failed' || run.status === 'timeout' || run.status === 'blocked') {
      const actions = div('run-actions')
      actions.appendChild(button('Diagnosticar con IA', 'btn btn-ghost btn-sm', () => sendText(runEvidence(run), 'chat')))
      details.appendChild(actions)
    }
    box.appendChild(details)
  }
  return box
}

function runStatusLabel(status: ExecutionRun['status']): string {
  const labels: Record<ExecutionRun['status'], [string, string]> = {
    running: ['ejecutando', 'running'], passed: ['correcto', 'passed'], failed: ['fallido', 'failed'],
    blocked: ['bloqueado', 'blocked'], timeout: ['agotado', 'timeout'],
  }
  return tr(...labels[status])
}

function runEvidence(run: ExecutionRun): string {
  return settings?.language === 'en' ? [
    'Diagnose the root cause of this failed run and propose verifiable next steps.',
    '',
    'Execution evidence:',
    `Command: ${run.command}`,
    `Status: ${run.status}`,
    `Exit code: ${run.exitCode === undefined ? 'n/a' : run.exitCode}`,
    `Duration: ${run.durationMs} ms`,
    'Output:',
    run.output || '(no output)',
  ].join('\n') : [
    'Diagnostica la causa raíz de esta ejecución fallida y propone próximos pasos verificables.',
    '',
    'Evidencia de ejecución:',
    `Comando: ${run.command}`,
    `Estado: ${run.status}`,
    `Código de salida: ${run.exitCode === undefined ? 'n/a' : run.exitCode}`,
    `Duración: ${run.durationMs} ms`,
    'Salida:',
    run.output || '(sin salida)',
  ].join('\n')
}

function executionProgress(command: string): HTMLElement {
  const row = div('execution-progress')
  row.appendChild(div('dot-spin'))
  const text = div('execution-text')
  const label = div('execution-label')
  label.textContent = executionAutomatic
    ? 'Verificación automática tras aplicar cambios…'
    : 'Ejecutando comando aprobado…'
  const code = document.createElement('code')
  code.textContent = command
  text.appendChild(label)
  text.appendChild(code)
  if (executionAutomatic) {
    // Deja claro de dónde salió el comando y cómo apagarlo.
    const hint = div('muted')
    hint.appendChild(document.createTextNode(tr(
      'Configuración > Comportamiento > Verificación. ',
      'Settings > Behavior > Verification. ',
    )))
    hint.appendChild(linkBtn(tr('Desactivar', 'Turn off'), () => {
      if (settings) settings = { ...settings, verification: 'off', autoValidate: false }
      post({ type: 'saveSettings', settings: { verification: 'off' } })
      post({ type: 'cancel' })
      toast(tr('Verificación automática desactivada', 'Automatic verification turned off'))
    }))
    text.appendChild(hint)
  }
  row.appendChild(text)
  return row
}

// ── Sobre Centyc ────────────────────────────────────────────────────────────

function centycView(): HTMLElement {
  const view = div('view centyc-view')
  const info = div('centyc-card')
  const logoWrap = div('centyc-logo-wrap')
  const placeholder = div('centyc-logo-placeholder')
  placeholder.textContent = 'CENTYC'
  const logo = document.createElement('img')
  logo.className = 'centyc-logo'
  logo.alt = 'Centyc'
  logo.hidden = true
  logo.onload = () => { logo.hidden = false; placeholder.hidden = true }
  logo.onerror = () => { logo.hidden = true; placeholder.hidden = false }
  logo.src = centycLogoUri
  logoWrap.appendChild(logo)
  logoWrap.appendChild(placeholder)
  info.appendChild(logoWrap)
  const site = document.createElement('a')
  site.className = 'centyc-site'
  site.href = 'https://www.centyc.cl'
  site.target = '_blank'
  site.rel = 'noopener noreferrer'
  site.textContent = 'www.centyc.cl'
  info.appendChild(site)
  const title = document.createElement('p')
  title.className = 'centyc-title'
  title.textContent = 'Centro Latinoamericano de Testing y Calidad de Software'
  info.appendChild(title)
  const description = document.createElement('p')
  description.className = 'centyc-description'
  description.textContent = 'visitanos y obten acceso a nuestros cursos, descuentos y conocimiento de calidad, testing y automatización.'
  info.appendChild(description)
  const disclaimer = document.createElement('p')
  disclaimer.className = 'centyc-disclaimer'
  disclaimer.textContent = 'Todos los datos de API keys, modelos, etc. se almacenan 100% localmente. Esta app no registra datos de ningún tipo.'
  info.appendChild(disclaimer)
  const license = document.createElement('p')
  license.className = 'centyc-license'
  license.appendChild(document.createTextNode('Licencia MIT - '))
  const repository = document.createElement('a')
  repository.href = 'https://github.com/FelipeFariasAlfaro/QAPI'
  repository.target = '_blank'
  repository.rel = 'noopener noreferrer'
  repository.textContent = 'Repositorio oficial'
  license.appendChild(repository)
  info.appendChild(license)
  view.appendChild(info)
  return view
}

// ── Configuración ───────────────────────────────────────────────────────────

function settingsView(): HTMLElement {
  const view = div('view settings')
  if (!settings || !draftProvider) {
    const loading = div('empty')
    loading.textContent = 'Cargando configuración…'
    view.appendChild(loading)
    return view
  }
  const currentSettings = settings
  const dp = draftProvider
  const providerDef = PROVIDERS.find((provider) => provider.id === dp.provider)!

  const cLanguage = card('Idioma', 'Define el idioma de la interfaz y de las respuestas futuras del chat.')
  const languageSelect = document.createElement('select')
  for (const [value, label] of [['es', 'Español'], ['en', 'English']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = currentSettings.language === value
    languageSelect.appendChild(option)
  }
  languageSelect.onchange = () => {
    const language = languageSelect.value as UiLanguage
    settings = { ...currentSettings, language }
    applyTheme()
    post({ type: 'saveSettings', settings: { language } })
    render()
    toast(language === 'en' ? 'Language updated' : 'Idioma actualizado')
  }
  cLanguage.appendChild(field('Idioma de QAPI', languageSelect))
  view.appendChild(cLanguage)

  const cIa = card('Proveedor de IA', 'Elige el proveedor y valida tus credenciales.')
  const grid = div('provider-grid')
  for (const provider of PROVIDERS) {
    const option = div(`provider-opt ${dp.provider === provider.id ? 'selected' : ''}`)
    option.textContent = provider.label
    option.onclick = () => { draftProvider = { provider: provider.id }; validation = null; render() }
    grid.appendChild(option)
  }
  cIa.appendChild(grid)
  if (providerDef.needsKey) {
    // La key guardada nunca llega a la webview; un campo vacío conserva la existente.
    const keyInput = inputEl('password', dp.apiKey || '', (value) => {
      dp.apiKey = value
      validation = null
      saveLocalState()
    })
    keyInput.placeholder = dp.hasStoredKey
      ? 'Key guardada · escribe una nueva para reemplazarla'
      : 'Pega tu API key (si ya hay una guardada, déjalo vacío)'
    keyInput.autocomplete = 'off'
    cIa.appendChild(field('API Key', keyInput))
  }
  if (dp.provider === 'ollama') cIa.appendChild(field('URL de Ollama', inputEl('text', dp.baseUrl || 'http://localhost:11434', (value) => {
    dp.baseUrl = value
    validation = null
    saveLocalState()
  })))

  const validateRow = div('row')
  validateRow.appendChild(button('Validar', 'btn btn-ghost btn-sm', () => {
    validation = null
    render()
    post({ type: 'validateProvider', provider: dp })
  }))
  if (validation) {
    const status = div(validation.ok ? 'status-ok' : 'status-err')
    status.textContent = validation.ok ? `✓ Válido · ${validation.models.length} modelos` : `✕ ${validation.message || 'No válido'}`
    validateRow.appendChild(status)
  }
  cIa.appendChild(validateRow)
  if (validation?.ok && validation.models.length) {
    const select = document.createElement('select')
    for (const model of validation.models) {
      const option = document.createElement('option')
      option.value = model
      option.textContent = model
      option.selected = model === dp.model
      select.appendChild(option)
    }
    select.onchange = () => {
      dp.model = select.value
      dp.contextLimit = validation?.limits?.[select.value]
      saveLocalState()
    }
    cIa.appendChild(field('Modelo', select))
    cIa.appendChild(button('Guardar selección', 'btn btn-primary btn-sm', () => {
      if (!dp.model) dp.model = validation!.models[0]
      dp.contextLimit = validation!.limits?.[dp.model]
      post({ type: 'saveSettings', settings: { provider: dp, configured: true } })
      toast('Configuración guardada')
      tab = 'chat'
      saveLocalState()
    }))
  } else if (dp.model) {
    const modelField = field('Modelo actual', inputEl('text', dp.model, () => {}))
    ;(modelField.querySelector('input') as HTMLInputElement).disabled = true
    cIa.appendChild(modelField)
  }
  view.appendChild(cIa)

  const cBehavior = card('Comportamiento', 'Tú decides qué verificar tras aplicar cambios. QAPI nunca elige ni ejecuta una suite por su cuenta.')
  const verificationSelect = document.createElement('select')
  const verificationOptions: [VerificationMode, string, string][] = [
    ['off', 'No verificar', 'Do not verify'],
    ['propose', 'Proponer el comando (yo lo ejecuto)', 'Propose the command (I run it)'],
    ['validate', 'Ejecutar el comando después de aplicar', 'Run the command after applying'],
    ['autofix', 'Ejecutar y corregir automáticamente', 'Run and fix automatically'],
  ]
  for (const [value, es, en] of verificationOptions) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = tr(es, en)
    option.selected = currentSettings.verification === value
    verificationSelect.appendChild(option)
  }
  verificationSelect.onchange = () => {
    const verification = verificationSelect.value as VerificationMode
    if (settings) settings = { ...settings, verification }
    post({ type: 'saveSettings', settings: { verification } })
    render()
  }
  cBehavior.appendChild(field('Verificación tras aplicar cambios', verificationSelect))

  if (currentSettings.verification !== 'off') {
    const commandInput = inputEl('text', verificationDraft ?? currentSettings.verificationCommand, (value) => { verificationDraft = value })
    commandInput.id = 'verification-command'
    commandInput.placeholder = 'behave {tests}'
    commandInput.spellcheck = false
    cBehavior.appendChild(field('Comando de verificación', commandInput))

    const commandActions = div('row')
    commandActions.appendChild(button('Guardar comando', 'btn btn-primary btn-sm', () => {
      const command = (verificationDraft ?? currentSettings.verificationCommand).trim()
      verificationDraft = null
      if (settings) settings = { ...settings, verificationCommand: command }
      post({ type: 'saveSettings', settings: { verificationCommand: command } })
      toast('Comando de verificación guardado')
      render()
    }))
    commandActions.appendChild(button('Sugerir para este proyecto', 'btn btn-ghost btn-sm', () => post({ type: 'suggestVerificationCommand' })))
    cBehavior.appendChild(commandActions)

    if (!currentSettings.verificationCommand) {
      const missing = div('status-warn')
      missing.textContent = tr(
        'Sin comando no se verifica nada. Defínelo para activar la verificación.',
        'Without a command nothing is verified. Define one to enable verification.',
      )
      cBehavior.appendChild(missing)
    }
    const verificationHint = div('muted')
    verificationHint.textContent = tr(
      '{tests} = sólo los archivos de prueba que cambiaron (si no hay, no se ejecuta). {files} = todos los archivos cambiados. {tests,} los une con comas. Sin marcadores se ejecuta el comando tal cual: evita suites completas en proyectos grandes.',
      '{tests} = only the changed test files (if none, nothing runs). {files} = all changed files. {tests,} joins them with commas. Without placeholders the command runs as is: avoid full suites in large projects.',
    )
    cBehavior.appendChild(verificationHint)
    if (currentSettings.verification === 'autofix') {
      const autofixHint = div('muted')
      autofixHint.textContent = tr(
        'Con corrección automática, QAPI reintenta hasta 3 veces y sólo edita los archivos citados en el error.',
        'With automatic fixing, QAPI retries up to 3 times and only edits files cited in the error.',
      )
      cBehavior.appendChild(autofixHint)
    }
  }
  view.appendChild(cBehavior)

  const cMemory = card('Memoria del proyecto', 'Contexto persistente que QAPI tendrá en futuras conversaciones.')
  const memoryEditor = document.createElement('textarea')
  memoryEditor.className = 'memory-editor'
  memoryEditor.placeholder = 'Convenciones, objetivos, decisiones y datos útiles del proyecto…'
  memoryEditor.value = memoryDraft
  memoryEditor.oninput = () => { memoryDraft = memoryEditor.value; saveLocalState() }
  cMemory.appendChild(memoryEditor)
  const memoryActions = div('row')
  memoryActions.appendChild(button('Guardar', 'btn btn-primary btn-sm', () => post({ type: 'saveMemory', text: memoryDraft })))
  memoryActions.appendChild(button('Limpiar', 'btn btn-ghost btn-sm', () => {
    memoryDraft = ''
    memory = ''
    post({ type: 'saveMemory', text: '' })
    render()
  }))
  if (memory !== memoryDraft) {
    const dirty = div('status-warn')
    dirty.textContent = 'Cambios sin guardar'
    memoryActions.appendChild(dirty)
  }
  cMemory.appendChild(memoryActions)
  view.appendChild(cMemory)

  view.appendChild(specsCard())

  const cCheckpoints = card('Checkpoints recientes', 'Restaura archivos modificados por QAPI.')
  if (!checkpoints.length) {
    const empty = div('muted')
    empty.textContent = 'Todavía no hay checkpoints.'
    cCheckpoints.appendChild(empty)
  } else {
    for (const checkpoint of [...checkpoints].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)) {
      const item = div('checkpoint-item')
      const info = div('checkpoint-info')
      const label = div('checkpoint-label')
      label.textContent = checkpoint.label
      const meta = div('checkpoint-meta')
      meta.textContent = `${new Date(checkpoint.createdAt).toLocaleString(dateLocale())} · ${checkpoint.files.length} archivo(s)${checkpoint.pending ? ' · recuperando' : ''}${checkpoint.undone ? ' · deshecho' : ''}`
      info.appendChild(label)
      info.appendChild(meta)
      if (checkpoint.conflict) {
        const conflict = div('status-err')
        conflict.textContent = checkpoint.conflict
        info.appendChild(conflict)
      }
      item.appendChild(info)
      const undo = button('Deshacer', 'btn btn-ghost btn-sm', () => post({ type: 'undoCheckpoint', checkpointId: checkpoint.id }))
      undo.disabled = Boolean(checkpoint.undone || checkpoint.pending)
      item.appendChild(undo)
      cCheckpoints.appendChild(item)
    }
  }
  view.appendChild(cCheckpoints)

  const cTrace = card('Trazabilidad estática inferida', 'Evidencia entre requisitos, escenarios, steps y pruebas; no representa cobertura de ejecución runtime.')
  const traceHead = div('trace-head')
  traceHead.appendChild(button('Actualizar', 'btn btn-ghost btn-sm', () => post({ type: 'rebuildTraceability' })))
  if (traceability) {
    const date = div('muted')
    date.textContent = `Actualizado ${new Date(traceability.generatedAt).toLocaleString(dateLocale())}`
    traceHead.appendChild(date)
  }
  cTrace.appendChild(traceHead)
  if (traceability) cTrace.appendChild(traceabilityView(traceability))
  else {
    const empty = div('muted')
    empty.textContent = 'Actualiza para calcular cobertura y gaps.'
    cTrace.appendChild(empty)
  }
  view.appendChild(cTrace)

  const cUi = card('Apariencia', 'Tema y tamaño de fuente.')
  const themeSelect = document.createElement('select')
  for (const [value, label] of THEME_OPTIONS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = currentSettings.theme === value
    themeSelect.appendChild(option)
  }
  themeSelect.onchange = () => {
    const theme = themeSelect.value as UiTheme
    settings = { ...currentSettings, theme }
    applyTheme()
    post({ type: 'saveSettings', settings: { theme } })
  }
  cUi.appendChild(field('Tema', themeSelect))
  const fontWrap = div('field')
  const fontLabel = document.createElement('label')
  fontLabel.textContent = tr(`Tamaño de fuente: ${currentSettings.fontSize}px`, `Font size: ${currentSettings.fontSize}px`)
  const range = document.createElement('input')
  range.type = 'range'
  range.min = String(FONT_MIN)
  range.max = String(FONT_MAX)
  range.value = String(currentSettings.fontSize)
  range.oninput = () => {
    fontLabel.textContent = tr(`Tamaño de fuente: ${range.value}px`, `Font size: ${range.value}px`)
    document.documentElement.style.setProperty('--qp-font', `${range.value}px`)
  }
  range.onchange = () => post({ type: 'saveSettings', settings: { fontSize: Number(range.value) } })
  const rangeRow = div('range-row')
  rangeRow.appendChild(range)
  fontWrap.appendChild(fontLabel)
  fontWrap.appendChild(rangeRow)
  cUi.appendChild(fontWrap)
  view.appendChild(cUi)

  const mcpHint = div('hint')
  mcpHint.textContent = tr('Los servidores MCP se configuran en la pestaña MCP.', 'MCP servers are configured in the MCP tab.')
  view.appendChild(mcpHint)
  return view
}

// ── Skills ──────────────────────────────────────────────────────────────────

let skillsState: { skills: SkillDefinition[]; templates: SkillDefinition[]; detected: string[]; trusted: boolean } | null = null
let skillForm: (SkillDefinition & { previousSlug?: string }) | null = null

const SKILL_ACTIVATIONS: { value: SkillActivation; label: string; labelEn: string; help: string; helpEn: string }[] = [
  {
    value: 'auto', label: 'Automática', labelEn: 'Automatic',
    help: 'El agente lee la descripción y la usa cuando la tarea lo requiere.',
    helpEn: 'The agent reads the description and uses it when the task needs it.',
  },
  {
    value: 'event', label: 'Ante un evento', labelEn: 'On an event',
    help: 'Se aplica cuando ocurre algo: un resultado de prueba o preparar un archivo.',
    helpEn: 'Applies when something happens: a test result or preparing a file.',
  },
  {
    value: 'fileMatch', label: 'Por tipo de archivo', labelEn: 'By file type',
    help: 'Se aplica cuando trabajas con archivos que coinciden con un patrón.',
    helpEn: 'Applies when you work with files matching a pattern.',
  },
  {
    value: 'always', label: 'Siempre', labelEn: 'Always',
    help: 'Se incluye en todos los mensajes. Úsala con moderación.',
    helpEn: 'Included in every message. Use it sparingly.',
  },
  {
    value: 'manual', label: 'Manual', labelEn: 'Manual',
    help: 'Sólo cuando la nombras en el chat con #skill:nombre.',
    helpEn: 'Only when you mention it in the chat with #skill:name.',
  },
]

const SKILL_EVENTS: { value: SkillEvent; label: string; labelEn: string; help: string; helpEn: string }[] = [
  {
    value: 'testResult', label: 'Resultado de prueba', labelEn: 'Test result',
    help: 'Al fallar un comando que ejecutaste (abre un análisis automático), al diagnosticar un artefacto o cuando el agente lee un reporte.',
    helpEn: 'When a command you ran fails (starts an automatic analysis), when diagnosing an artifact, or when the agent reads a report.',
  },
  {
    value: 'beforeWrite', label: 'Al preparar archivos', labelEn: 'When preparing files',
    help: 'Cuando el agente prepara un archivo; con patrón, sólo si coincide.',
    helpEn: 'When the agent prepares a file; with a pattern, only if it matches.',
  },
]

const GLOB_EXAMPLES = ['**/*.feature', '**/steps/**/*.py', '**/pages/**', '**/*.spec.ts', '**/json_poms/**']

function activationLabel(skill: SkillDefinition): string {
  const activation = SKILL_ACTIVATIONS.find((item) => item.value === skill.activation)
  const base = activation ? tr(activation.label, activation.labelEn) : skill.activation
  if (skill.activation === 'event') {
    const events = (skill.events || []).map((event) => {
      const def = SKILL_EVENTS.find((item) => item.value === event)
      return def ? tr(def.label, def.labelEn) : event
    })
    return `${base}: ${events.join(', ')}`
  }
  if (skill.activation === 'fileMatch' && skill.fileMatchPattern) return `${base}: ${skill.fileMatchPattern}`
  return base
}

function skillsView(): HTMLElement {
  const view = div('view settings-view skills-view')
  if (!skillsState) {
    post({ type: 'refreshSkills' })
    const loading = div('muted')
    loading.textContent = tr('Cargando skills…', 'Loading skills…')
    view.appendChild(loading)
    return view
  }
  if (skillForm) {
    view.appendChild(skillFormView(skillForm))
    return view
  }

  const intro = div('mcp-intro')
  const title = document.createElement('h3')
  title.textContent = 'Skills'
  const description = div('hint')
  description.textContent = tr(
    'Instrucciones reutilizables que el agente aplica cuando corresponde: analizar fallos, cómo escribir localizadores, convenciones del equipo. Se guardan en .qapi/skills para compartirlas con tu equipo.',
    'Reusable instructions the agent applies when relevant: analyzing failures, how to write locators, team conventions. Saved in .qapi/skills so your team can share them.',
  )
  intro.append(title, description)
  view.appendChild(intro)

  if (!skillsState.trusted) {
    const warning = div('status-warn')
    warning.textContent = tr(
      'Este workspace no es confiable: las skills no se cargan hasta que confíes en él.',
      'This workspace is not trusted: skills are not loaded until you trust it.',
    )
    view.appendChild(warning)
    return view
  }

  const toolbar = div('row mcp-toolbar')
  toolbar.appendChild(button(tr('+ Crear skill', '+ Create skill'), 'btn btn-primary btn-sm', () => {
    skillForm = { slug: '', name: '', description: '', activation: 'auto', instructions: '', enabled: true, events: [], frameworks: [] }
    render()
  }))
  view.appendChild(toolbar)

  const list = div('mcp-list')
  if (!skillsState.skills.length) {
    const empty = div('muted')
    empty.textContent = tr('Aún no hay skills. Crea una o parte de una plantilla.', 'No skills yet. Create one or start from a template.')
    list.appendChild(empty)
  }
  for (const skill of skillsState.skills) list.appendChild(skillCard(skill))
  view.appendChild(list)

  const existing = new Set(skillsState.skills.map((skill) => skill.slug))
  const templates = skillsState.templates.filter((template) => !existing.has(template.slug))
  if (templates.length) {
    const label = div('section-label')
    label.textContent = tr('Plantillas', 'Templates')
    view.appendChild(label)
    const grid = div('mcp-presets')
    for (const template of templates) {
      const item = div('mcp-preset')
      const head = div('mcp-preset-head')
      const name = document.createElement('strong')
      name.textContent = template.name
      head.appendChild(name)
      head.appendChild(button(tr('Usar', 'Use'), 'btn btn-ghost btn-sm', () => {
        skillForm = { ...template, events: [...(template.events || [])], frameworks: [...(template.frameworks || [])] }
        render()
      }))
      const text = div('hint')
      text.textContent = template.description
      const mode = div('skill-badge')
      mode.textContent = activationLabel(template)
      item.append(head, text, mode)
      grid.appendChild(item)
    }
    view.appendChild(grid)
  }
  return view
}

function skillCard(skill: SkillDefinition): HTMLElement {
  const card = div(`mcp-card ${skill.enabled ? '' : 'skill-disabled'}`)
  const header = div('mcp-card-header')
  const title = div('mcp-card-title')
  title.textContent = skill.name
  header.appendChild(title)
  const toggleLabel = document.createElement('label')
  toggleLabel.className = 'toggle'
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.checked = skill.enabled
  toggle.setAttribute('role', 'switch')
  toggle.setAttribute('aria-label', tr(`Activar ${skill.name}`, `Enable ${skill.name}`))
  toggle.onchange = () => post({ type: 'toggleSkill', slug: skill.slug, enabled: toggle.checked })
  const toggleText = document.createElement('span')
  toggleText.textContent = skill.enabled ? tr('Activa', 'Enabled') : tr('Inactiva', 'Disabled')
  toggleLabel.append(toggleText, toggle)
  header.appendChild(toggleLabel)
  card.appendChild(header)

  if (skill.description) {
    const description = div('hint')
    description.textContent = skill.description
    card.appendChild(description)
  }
  const badges = div('skill-badges')
  const mode = div('skill-badge')
  mode.textContent = activationLabel(skill)
  badges.appendChild(mode)
  if (skill.activation === 'event' && skill.events?.includes('beforeWrite') && skill.fileMatchPattern) {
    const pattern = div('skill-badge')
    pattern.textContent = skill.fileMatchPattern
    badges.appendChild(pattern)
  }
  if (skill.frameworks?.length) {
    const scope = div('skill-badge')
    scope.textContent = tr(`Sólo en: ${skill.frameworks.join(', ')}`, `Only in: ${skill.frameworks.join(', ')}`)
    badges.appendChild(scope)
  }
  if (skill.activation === 'manual') {
    const usage = document.createElement('code')
    usage.className = 'skill-badge'
    usage.textContent = `#skill:${skill.slug}`
    badges.appendChild(usage)
  }
  card.appendChild(badges)

  const actions = div('row mcp-card-actions')
  actions.appendChild(button(tr('Editar', 'Edit'), 'btn btn-ghost btn-sm', () => {
    skillForm = { ...skill, events: [...(skill.events || [])], frameworks: [...(skill.frameworks || [])], previousSlug: skill.slug }
    render()
  }))
  actions.appendChild(button(tr('Abrir .md', 'Open .md'), 'btn btn-ghost btn-sm', () => post({ type: 'openSkillFile', slug: skill.slug })))
  actions.appendChild(button(tr('Eliminar', 'Delete'), 'btn btn-ghost btn-sm mcp-delete', () => {
    if (!confirmOnce(`skill-delete:${skill.slug}`)) {
      toast(tr(`Pulsa Eliminar otra vez para borrar “${skill.name}”.`, `Click Delete again to remove “${skill.name}”.`))
      return
    }
    post({ type: 'deleteSkill', slug: skill.slug })
    toast(tr('Skill eliminada', 'Skill removed'))
  }))
  card.appendChild(actions)
  return card
}

function skillFormView(form: SkillDefinition & { previousSlug?: string }): HTMLElement {
  const box = div('card mcp-form skill-form')
  const title = document.createElement('h3')
  title.textContent = form.previousSlug ? tr(`Editar ${form.name}`, `Edit ${form.name}`) : tr('Nueva skill', 'New skill')
  box.appendChild(title)

  const nameInput = inputEl('text', form.name, (value) => { form.name = value })
  nameInput.id = 'skill-form-name'
  nameInput.placeholder = tr('Análisis de fallos', 'Failure analysis')
  box.appendChild(field(tr('Nombre', 'Name'), nameInput))

  const descriptionInput = inputEl('text', form.description, (value) => { form.description = value })
  descriptionInput.id = 'skill-form-description'
  descriptionInput.placeholder = tr('Cuándo debe usarse y para qué', 'When it should be used and what for')
  box.appendChild(field(tr('Descripción', 'Description'), descriptionInput))
  if (form.activation === 'auto') {
    const hint = div('hint')
    hint.textContent = tr(
      'En modo automático el agente decide por esta descripción: explica claramente cuándo aplica.',
      'In automatic mode the agent decides from this description: explain clearly when it applies.',
    )
    box.appendChild(hint)
  }

  // Activación como opciones visuales en vez de un select.
  const activationLabelEl = div('section-label')
  activationLabelEl.textContent = tr('¿Cuándo se usa?', 'When is it used?')
  box.appendChild(activationLabelEl)
  const options = div('skill-options')
  options.setAttribute('role', 'radiogroup')
  for (const option of SKILL_ACTIVATIONS) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `skill-option ${form.activation === option.value ? 'selected' : ''}`
    item.setAttribute('role', 'radio')
    item.setAttribute('aria-checked', String(form.activation === option.value))
    const label = document.createElement('strong')
    label.textContent = tr(option.label, option.labelEn)
    const help = div('hint')
    help.textContent = tr(option.help, option.helpEn)
    item.append(label, help)
    item.onclick = () => {
      form.activation = option.value
      if (option.value === 'event' && !form.events?.length) form.events = ['testResult']
      render()
    }
    options.appendChild(item)
  }
  box.appendChild(options)

  if (form.activation === 'event') {
    const eventsLabel = div('section-label')
    eventsLabel.textContent = tr('Eventos', 'Events')
    box.appendChild(eventsLabel)
    for (const event of SKILL_EVENTS) {
      const row = document.createElement('label')
      row.className = 'check-label skill-event'
      const input = checkbox(Boolean(form.events?.includes(event.value)), () => {
        const next = new Set(form.events || [])
        if (input.checked) next.add(event.value)
        else next.delete(event.value)
        form.events = [...next]
        render()
      })
      const text = div('')
      const strong = document.createElement('strong')
      strong.textContent = tr(event.label, event.labelEn)
      const help = div('hint')
      help.textContent = tr(event.help, event.helpEn)
      text.append(strong, help)
      row.append(input, text)
      box.appendChild(row)
    }
  }

  if (form.activation === 'fileMatch' || (form.activation === 'event' && form.events?.includes('beforeWrite'))) {
    const patternInput = inputEl('text', form.fileMatchPattern || '', (value) => { form.fileMatchPattern = value })
    patternInput.id = 'skill-form-pattern'
    patternInput.placeholder = '**/pages/**'
    patternInput.spellcheck = false
    const optional = form.activation === 'event' ? tr(' (opcional: vacío = todos los archivos)', ' (optional: empty = all files)') : ''
    box.appendChild(field(`${tr('Patrón de archivos', 'File pattern')}${optional}`, patternInput))
    const chips = div('skill-chips')
    for (const example of GLOB_EXAMPLES) {
      chips.appendChild(button(example, 'skill-chip', () => { form.fileMatchPattern = example; render() }))
    }
    box.appendChild(chips)
  }

  const scopeLabel = div('section-label')
  scopeLabel.textContent = tr('Sólo en proyectos con… (opcional)', 'Only in projects with… (optional)')
  box.appendChild(scopeLabel)
  const scopeHint = div('hint')
  scopeHint.textContent = tr(
    'Sin selección, aplica en cualquier proyecto. Resaltados: los detectados en este proyecto.',
    'With nothing selected it applies to any project. Highlighted: detected in this project.',
  )
  box.appendChild(scopeHint)
  const detected = new Set(skillsState?.detected || [])
  const known = [...new Set([...KNOWN_FRAMEWORKS, ...detected, ...(form.frameworks || [])])]
  const scopeChips = div('skill-chips')
  for (const framework of known) {
    const selected = Boolean(form.frameworks?.includes(framework))
    const chip = button(framework, `skill-chip ${selected ? 'selected' : ''} ${detected.has(framework) ? 'detected' : ''}`, () => {
      const next = new Set(form.frameworks || [])
      if (selected) next.delete(framework)
      else next.add(framework)
      form.frameworks = [...next]
      render()
    })
    chip.setAttribute('aria-pressed', String(selected))
    scopeChips.appendChild(chip)
  }
  box.appendChild(scopeChips)

  const instructions = document.createElement('textarea')
  instructions.id = 'skill-form-instructions'
  instructions.className = 'skill-instructions'
  instructions.value = form.instructions
  instructions.placeholder = tr(
    'Escribe las instrucciones como se las darías a un compañero. Ej.: "Al crear localizadores usa XPath relativos y prioriza @data-testid".',
    'Write the instructions as you would to a teammate. E.g.: "When creating locators use relative XPath and prefer @data-testid".',
  )
  instructions.oninput = () => { form.instructions = instructions.value }
  box.appendChild(field(tr('Instrucciones', 'Instructions'), instructions))

  const enabledRow = document.createElement('label')
  enabledRow.className = 'toggle'
  const enabledInput = document.createElement('input')
  enabledInput.type = 'checkbox'
  enabledInput.checked = form.enabled
  enabledInput.setAttribute('role', 'switch')
  enabledInput.onchange = () => { form.enabled = enabledInput.checked }
  const enabledText = document.createElement('span')
  enabledText.textContent = tr('Activa', 'Enabled')
  enabledRow.append(enabledText, enabledInput)
  box.appendChild(enabledRow)

  const actions = div('row skill-form-actions')
  actions.appendChild(button(tr('Guardar skill', 'Save skill'), 'btn btn-primary btn-sm', () => {
    if (!form.name.trim() || !form.instructions.trim()) {
      toast(tr('El nombre y las instrucciones son obligatorios.', 'Name and instructions are required.'))
      return
    }
    if (form.activation === 'fileMatch' && !form.fileMatchPattern?.trim()) {
      toast(tr('Indica el patrón de archivos.', 'Enter the file pattern.'))
      return
    }
    if (form.activation === 'event' && !form.events?.length) {
      toast(tr('Elige al menos un evento.', 'Choose at least one event.'))
      return
    }
    const { previousSlug, ...skill } = form
    post({ type: 'saveSkill', skill, previousSlug })
    skillForm = null
    toast(tr('Skill guardada', 'Skill saved'))
    render()
  }))
  actions.appendChild(button(tr('Cancelar', 'Cancel'), 'btn btn-ghost btn-sm', () => { skillForm = null; render() }))
  box.appendChild(actions)
  return box
}

const KNOWN_FRAMEWORKS = ['Behave', 'pytest', 'Playwright', 'Cypress', 'Selenium', 'Jest', 'Cucumber', 'Robot Framework', 'Python', 'TypeScript', 'Java']

// ── MCP ─────────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  [key: string]: unknown
}

interface McpFormState {
  /** Nombre original al editar; ausente al crear uno nuevo. */
  originalName?: string
  name: string
  command: string
  args: string
  env: string
}

const MCP_PRESETS: { label: string; description: string; name: string; command: string; args: string[] }[] = [
  {
    label: 'Filesystem', name: 'filesystem', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    description: 'Lee y escribe archivos dentro de la carpeta indicada.',
  },
  {
    label: 'Playwright', name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'],
    description: 'Controla un navegador real: navegar, hacer clic, capturar el DOM.',
  },
  {
    label: 'Git', name: 'git', command: 'uvx', args: ['mcp-server-git', '--repository', '.'],
    description: 'Consulta historial, diffs y ramas del repositorio.',
  },
  {
    label: 'Fetch', name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'],
    description: 'Descarga páginas web y las convierte a texto.',
  },
]

let mcpForm: McpFormState | null = null
let mcpShowJson = false
const mcpProbes: Record<string, { running: boolean; result?: Extract<ToWebview, { type: 'mcpProbe' }> }> = {}

/** Configuración MCP vigente en la UI: el borrador si existe, si no la guardada. */
function mcpSource(): string {
  return mcpDraft ?? settings?.mcpJson ?? ''
}

function readMcpConfig(): { root: Record<string, unknown>; servers: Record<string, McpServerEntry>; error?: string } {
  const text = mcpSource().trim()
  if (!text) return { root: {}, servers: {} }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(tr('se esperaba un objeto', 'an object was expected'))
    const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data
    return { root: data.mcpServers ? data : {}, servers }
  } catch (error) {
    return { root: {}, servers: {}, error: String((error as Error).message || error) }
  }
}

/** Escribe el mapa de servidores, conserva otras claves de la raíz y guarda. */
function saveMcpServers(servers: Record<string, McpServerEntry>, root: Record<string, unknown>) {
  const json = JSON.stringify({ ...root, mcpServers: servers }, null, 2)
  mcpDraft = json
  saveLocalState()
  post({ type: 'saveMcpJson', json })
}

function mcpView(): HTMLElement {
  const view = div('view settings-view mcp-view')
  const currentSettings = settings!
  const config = readMcpConfig()

  const intro = div('mcp-intro')
  const title = document.createElement('h3')
  title.textContent = tr('Servidores MCP', 'MCP servers')
  const description = div('hint')
  description.textContent = tr(
    'Conecta herramientas externas al agente. Un servidor activo se inicia al usarlo en el chat y sus tools piden tu aprobación en cada llamada.',
    'Connect external tools to the agent. An enabled server starts when the chat uses it, and each tool call asks for your approval.',
  )
  const warning = div('status-warn')
  warning.textContent = tr(
    'Activa sólo servidores confiables: se ejecutan con tus permisos y pueden acceder a datos.',
    'Enable only trusted servers: they run with your permissions and can access data.',
  )
  intro.append(title, description, warning)
  view.appendChild(intro)

  if (config.error && !mcpShowJson) {
    const error = div('status-err')
    error.textContent = tr(`La configuración tiene JSON inválido: ${config.error}`, `The configuration has invalid JSON: ${config.error}`)
    view.appendChild(error)
    view.appendChild(button(tr('Corregir en JSON', 'Fix in JSON'), 'btn btn-ghost btn-sm', () => { mcpShowJson = true; render() }))
    return view
  }

  if (mcpForm) {
    view.appendChild(mcpFormView(mcpForm, config))
    return view
  }

  const toolbar = div('row mcp-toolbar')
  toolbar.appendChild(button(tr('+ Añadir servidor', '+ Add server'), 'btn btn-primary btn-sm', () => {
    mcpForm = { name: '', command: '', args: '', env: '' }
    render()
  }))
  toolbar.appendChild(button(tr('Revalidar', 'Revalidate'), 'btn btn-ghost btn-sm', () => post({ type: 'validateMcp', json: mcpSource() })))
  toolbar.appendChild(div('spacer'))
  toolbar.appendChild(linkBtn(mcpShowJson ? tr('Ocultar JSON', 'Hide JSON') : tr('Editar JSON', 'Edit JSON'), () => {
    mcpShowJson = !mcpShowJson
    render()
  }))
  view.appendChild(toolbar)

  if (mcpShowJson) view.appendChild(mcpJsonEditor(currentSettings))

  const names = Object.keys(config.servers).sort((a, b) => a.localeCompare(b))
  const list = div('mcp-list')
  if (!names.length) {
    const empty = div('muted')
    empty.textContent = tr('No hay servidores configurados. Añade uno o parte de una plantilla.', 'No servers configured. Add one or start from a template.')
    list.appendChild(empty)
  }
  for (const name of names) list.appendChild(mcpServerCard(name, normalizeMcpEntry(config.servers[name]), config, currentSettings))
  view.appendChild(list)

  const presets = MCP_PRESETS.filter((preset) => !config.servers[preset.name])
  if (presets.length) {
    const label = div('section-label')
    label.textContent = tr('Plantillas', 'Templates')
    view.appendChild(label)
    const grid = div('mcp-presets')
    for (const preset of presets) {
      const item = div('mcp-preset')
      const head = div('mcp-preset-head')
      const name = document.createElement('strong')
      name.textContent = preset.label
      head.appendChild(name)
      head.appendChild(button(tr('Añadir', 'Add'), 'btn btn-ghost btn-sm', () => {
        mcpForm = { name: preset.name, command: preset.command, args: preset.args.join('\n'), env: '' }
        render()
      }))
      const text = div('hint')
      text.textContent = tr(preset.description, mcpPresetDescriptionEn(preset.name))
      const command = document.createElement('code')
      command.textContent = `${preset.command} ${preset.args.join(' ')}`
      item.append(head, text, command)
      grid.appendChild(item)
    }
    view.appendChild(grid)
    const note = div('hint')
    note.textContent = tr(
      'Las plantillas descargan la última versión del paquete con npx/uvx. Para fijar una versión, edita los argumentos (p. ej. paquete@1.2.3).',
      'Templates download the latest package version with npx/uvx. To pin a version, edit the arguments (e.g. package@1.2.3).',
    )
    view.appendChild(note)
  }
  return view
}

/** El JSON lo puede editar el usuario a mano: los campos mal tipados no deben romper la vista. */
function normalizeMcpEntry(value: unknown): McpServerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entry = value as McpServerEntry
  const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : undefined
  return {
    ...entry,
    command: typeof entry.command === 'string' ? entry.command : '',
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: env ? Object.fromEntries(Object.entries(env).map(([key, item]) => [key, String(item)])) : undefined,
  }
}

function mcpPresetDescriptionEn(name: string): string {
  return ({
    filesystem: 'Reads and writes files inside the given folder.',
    playwright: 'Drives a real browser: navigate, click, capture the DOM.',
    git: 'Queries repository history, diffs and branches.',
    fetch: 'Downloads web pages and converts them to text.',
  } as Record<string, string>)[name] || ''
}

function mcpServerCard(
  name: string,
  server: McpServerEntry,
  config: ReturnType<typeof readMcpConfig>,
  currentSettings: Settings,
): HTMLElement {
  const card = div('mcp-card')
  const issue = mcpValidation?.issues.find((item) => item.name === name)
  const enabled = Boolean(currentSettings.mcpEnabled[name])
  const saved = mcpDraft === null || mcpDraft === currentSettings.mcpJson

  const header = div('mcp-card-header')
  const status = div(`mcp-dot ${issue ? (issue.ok ? 'ok' : 'err') : 'unknown'}`)
  status.title = issue ? (issue.ok ? tr('Ejecutable encontrado', 'Executable found') : issue.message) : tr('Sin validar', 'Not validated')
  const title = div('mcp-card-title')
  title.textContent = name
  header.append(status, title)

  const toggleLabel = document.createElement('label')
  toggleLabel.className = 'check-label mcp-toggle'
  const toggle = checkbox(enabled, () => post({ type: 'toggleMcp', name, enabled: toggle.checked }))
  toggle.className = 'switch'
  // Sólo se activa un servidor guardado cuyo ejecutable existe.
  toggle.disabled = !saved || !issue?.ok
  const toggleText = document.createElement('span')
  toggleText.textContent = enabled ? tr('Activo', 'Enabled') : tr('Inactivo', 'Disabled')
  toggleLabel.append(toggle, toggleText)
  header.appendChild(toggleLabel)
  card.appendChild(header)

  const command = document.createElement('code')
  command.className = 'mcp-command'
  command.textContent = `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
  card.appendChild(command)
  const envKeys = Object.keys(server.env || {})
  if (envKeys.length) {
    const env = div('hint')
    env.textContent = `env: ${envKeys.join(', ')}`
    card.appendChild(env)
  }
  if (issue && !issue.ok) {
    const problem = div('status-err')
    problem.textContent = issue.message
    card.appendChild(problem)
  }

  const probe = mcpProbes[name]
  if (probe?.running) {
    const running = div('muted')
    running.textContent = tr('Conectando…', 'Connecting…')
    card.appendChild(running)
  } else if (probe?.result) {
    const result = probe.result
    const summary = div(result.ok ? 'status-ok' : 'status-err')
    summary.textContent = result.ok
      ? tr(`✓ Conectado en ${result.durationMs} ms · ${result.tools.length} tool(s)`, `✓ Connected in ${result.durationMs} ms · ${result.tools.length} tool(s)`)
      : `✕ ${result.message || tr('No se pudo conectar.', 'Could not connect.')}`
    card.appendChild(summary)
    if (result.tools.length) {
      const tools = trackOpen(document.createElement('details'), `mcp-tools:${name}`)
      tools.className = 'mcp-tools'
      const toolsSummary = document.createElement('summary')
      toolsSummary.textContent = tr('Ver herramientas', 'Show tools')
      tools.appendChild(toolsSummary)
      for (const tool of result.tools) {
        const row = div('mcp-tool')
        const toolName = document.createElement('code')
        toolName.textContent = tool.name
        row.appendChild(toolName)
        if (tool.description) {
          const toolDescription = div('hint')
          toolDescription.textContent = tool.description
          row.appendChild(toolDescription)
        }
        tools.appendChild(row)
      }
      card.appendChild(tools)
    }
  }

  const actions = div('row mcp-card-actions')
  const test = button(tr('Probar conexión', 'Test connection'), 'btn btn-ghost btn-sm', () => {
    mcpProbes[name] = { running: true }
    post({ type: 'probeMcp', name })
    render()
  })
  test.disabled = !saved || Boolean(probe?.running)
  if (!saved) test.title = tr('Guarda los cambios antes de probar.', 'Save your changes before testing.')
  actions.appendChild(test)
  actions.appendChild(button(tr('Editar', 'Edit'), 'btn btn-ghost btn-sm', () => {
    mcpForm = {
      originalName: name,
      name,
      command: server.command || '',
      args: (server.args || []).join('\n'),
      env: Object.entries(server.env || {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    }
    render()
  }))
  actions.appendChild(button(tr('Eliminar', 'Delete'), 'btn btn-ghost btn-sm mcp-delete', () => {
    if (!confirmOnce(`mcp-delete:${name}`)) {
      toast(tr(`Pulsa Eliminar otra vez para borrar “${name}”.`, `Click Delete again to remove “${name}”.`))
      return
    }
    const next = { ...config.servers }
    delete next[name]
    delete mcpProbes[name]
    saveMcpServers(next, config.root)
    toast(tr('Servidor eliminado', 'Server removed'))
  }))
  card.appendChild(actions)
  return card
}

/** Confirmación de dos clics en 4 s (los diálogos nativos no funcionan en webviews). */
const pendingConfirmations = new Map<string, number>()
function confirmOnce(key: string): boolean {
  const now = Date.now()
  const previous = pendingConfirmations.get(key)
  if (previous && now - previous < 4000) {
    pendingConfirmations.delete(key)
    return true
  }
  pendingConfirmations.set(key, now)
  return false
}

function mcpFormView(form: McpFormState, config: ReturnType<typeof readMcpConfig>): HTMLElement {
  const box = div('card mcp-form')
  const title = document.createElement('h3')
  title.textContent = form.originalName ? tr(`Editar ${form.originalName}`, `Edit ${form.originalName}`) : tr('Nuevo servidor MCP', 'New MCP server')
  box.appendChild(title)

  const nameInput = inputEl('text', form.name, (value) => { form.name = value })
  nameInput.id = 'mcp-form-name'
  nameInput.placeholder = 'playwright'
  box.appendChild(field(tr('Nombre', 'Name'), nameInput))

  const commandInput = inputEl('text', form.command, (value) => { form.command = value })
  commandInput.id = 'mcp-form-command'
  commandInput.placeholder = 'npx'
  box.appendChild(field(tr('Comando', 'Command'), commandInput))

  const argsInput = document.createElement('textarea')
  argsInput.id = 'mcp-form-args'
  argsInput.className = 'json-editor mcp-small-editor'
  argsInput.spellcheck = false
  argsInput.value = form.args
  argsInput.placeholder = '-y\n@playwright/mcp'
  argsInput.oninput = () => { form.args = argsInput.value }
  box.appendChild(field(tr('Argumentos (uno por línea)', 'Arguments (one per line)'), argsInput))

  const envInput = document.createElement('textarea')
  envInput.id = 'mcp-form-env'
  envInput.className = 'json-editor mcp-small-editor'
  envInput.spellcheck = false
  envInput.value = form.env
  envInput.placeholder = 'API_KEY=…'
  envInput.oninput = () => { form.env = envInput.value }
  box.appendChild(field(tr('Variables de entorno (CLAVE=valor, una por línea)', 'Environment variables (KEY=value, one per line)'), envInput))
  const envNote = div('hint')
  envNote.textContent = tr(
    'Estas variables se guardan en la configuración de VS Code sin cifrar. Para secretos, prefiere variables ya definidas en tu sistema.',
    'These variables are stored unencrypted in the VS Code settings. For secrets, prefer variables already defined in your system.',
  )
  box.appendChild(envNote)

  const actions = div('row')
  actions.appendChild(button(tr('Guardar servidor', 'Save server'), 'btn btn-primary btn-sm', () => {
    const name = form.name.trim()
    const command = form.command.trim()
    if (!name || !command) {
      toast(tr('El nombre y el comando son obligatorios.', 'Name and command are required.'))
      return
    }
    if (name !== form.originalName && config.servers[name]) {
      toast(tr(`Ya existe un servidor llamado “${name}”.`, `A server named “${name}” already exists.`))
      return
    }
    const env: Record<string, string> = {}
    for (const line of form.env.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const separator = trimmed.indexOf('=')
      if (separator <= 0) {
        toast(tr(`Variable inválida: “${trimmed}”. Usa CLAVE=valor.`, `Invalid variable: “${trimmed}”. Use KEY=value.`))
        return
      }
      env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1)
    }
    const args = form.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean)
    // Se conservan claves extra del servidor original (p. ej. "type" o "disabled").
    const previous = form.originalName ? normalizeMcpEntry(config.servers[form.originalName]) : {}
    const entry: McpServerEntry = { ...previous, command, args }
    if (Object.keys(env).length) entry.env = env
    else delete entry.env

    const next: Record<string, McpServerEntry> = {}
    for (const [key, value] of Object.entries(config.servers)) {
      // Mantiene el orden al renombrar.
      if (key === form.originalName) next[name] = entry
      else next[key] = value
    }
    if (!form.originalName) next[name] = entry
    if (form.originalName && form.originalName !== name) delete mcpProbes[form.originalName]
    mcpForm = null
    saveMcpServers(next, config.root)
    toast(tr('Servidor guardado', 'Server saved'))
    render()
  }))
  actions.appendChild(button(tr('Cancelar', 'Cancel'), 'btn btn-ghost btn-sm', () => { mcpForm = null; render() }))
  box.appendChild(actions)
  return box
}

function mcpJsonEditor(currentSettings: Settings): HTMLElement {
  const box = div('card mcp-json')
  const editor = document.createElement('textarea')
  editor.id = 'mcp-json-editor'
  editor.className = 'json-editor'
  editor.spellcheck = false
  editor.value = mcpSource()
  editor.oninput = () => { mcpDraft = editor.value; saveLocalState() }
  box.appendChild(field(tr('Configuración (JSON)', 'Configuration (JSON)'), editor))
  const actions = div('row')
  actions.appendChild(button(tr('Validar', 'Validate'), 'btn btn-ghost btn-sm', () => post({ type: 'validateMcp', json: mcpSource() })))
  actions.appendChild(button(tr('Guardar', 'Save'), 'btn btn-primary btn-sm', () => {
    post({ type: 'saveMcpJson', json: mcpSource() })
    toast(tr('Configuración MCP guardada', 'MCP configuration saved'))
  }))
  if (mcpDraft !== null && mcpDraft !== currentSettings.mcpJson) {
    actions.appendChild(linkBtn(tr('Descartar cambios', 'Discard changes'), () => {
      mcpDraft = null
      saveLocalState()
      post({ type: 'validateMcp', json: currentSettings.mcpJson })
      render()
    }))
  }
  box.appendChild(actions)
  if (mcpValidation?.error) {
    const error = div('status-err')
    error.textContent = `✕ ${mcpValidation.error}`
    box.appendChild(error)
  }
  return box
}

function traceabilityView(summary: TraceabilitySummary): HTMLElement {
  const wrap = div('traceability')
  const grid = div('trace-grid')
  const totals: Array<[string, number]> = [
    ['Requisitos', summary.requirements.length],
    ['Escenarios', summary.scenarios],
    ['Steps', summary.steps],
    ['Definiciones', summary.stepDefinitions],
    ['Pruebas', summary.tests],
    ['Steps vinculados', summary.linkedSteps],
  ]
  for (const [label, value] of totals) {
    const metric = div('trace-metric')
    const number = div('trace-number')
    number.textContent = String(value)
    const name = div('trace-label')
    name.textContent = label
    metric.appendChild(number)
    metric.appendChild(name)
    grid.appendChild(metric)
  }
  wrap.appendChild(grid)

  const requirementsTitle = div('section-label')
  requirementsTitle.textContent = `Requisitos (${summary.requirements.length})`
  wrap.appendChild(requirementsTitle)
  const requirements = div('trace-evidence')
  requirements.textContent = summary.requirements.join(', ') || 'Sin IDs de requisito detectados.'
  wrap.appendChild(requirements)

  const evidenceDetails = document.createElement('details')
  evidenceDetails.className = 'trace-details'
  const evidenceSummary = document.createElement('summary')
  evidenceSummary.textContent = `Evidencias inferidas (${summary.evidence.length})`
  evidenceDetails.appendChild(evidenceSummary)
  const evidenceList = document.createElement('ul')
  evidenceList.className = 'gap-list evidence-list'
  for (const evidence of summary.evidence) {
    const item = document.createElement('li')
    item.textContent = evidence
    evidenceList.appendChild(item)
  }
  evidenceDetails.appendChild(evidenceList)
  wrap.appendChild(evidenceDetails)

  const gapsTitle = div('section-label')
  gapsTitle.textContent = `Gaps (${summary.gaps.length})`
  wrap.appendChild(gapsTitle)
  if (!summary.gaps.length) {
    const ok = div('status-ok')
    ok.textContent = '✓ Sin gaps detectados'
    wrap.appendChild(ok)
  } else {
    const gaps = document.createElement('ul')
    gaps.className = 'gap-list'
    for (const gap of summary.gaps) {
      const item = document.createElement('li')
      item.textContent = gap
      gaps.appendChild(item)
    }
    wrap.appendChild(gaps)
  }
  return wrap
}

// ── Localización ────────────────────────────────────────────────────────────

const UI_EN = new Map<string, string>([
  ['Configuración', 'Settings'],
  ['Agente QAPI', 'QAPI Agent'],
  ['Agente', 'Agent'],
  ['Agentes', 'Agents'],
  ['Usuario', 'User'],
  ['Contexto lleno: resumí la conversación y continué', 'Context full: I summarized the conversation and continued'],
  ['Memoria actualizada', 'Memory updated'],
  ['Configuración guardada', 'Settings saved'],
  ['Configuración MCP guardada', 'MCP configuration saved'],
  ['Sobre Centyc', 'About Centyc'],
  ['sin proyecto', 'no project'],
  ['Indexando…', 'Indexing…'],
  ['Nueva conversación', 'New conversation'],
  ['Nueva', 'New'],
  ['Pruebas impactadas', 'Impacted tests'],
  ['Diagnosticar último reporte', 'Diagnose latest report'],
  ['Pregúntame sobre pruebas, cobertura, bugs o pídeme crear/editar archivos. Tengo el contexto del proyecto abierto.', 'Ask me about tests, coverage, bugs, or ask me to create/edit files. I have context from the open project.'],
  ['Investigando el proyecto…', 'Investigating the project…'],
  ['Pensando…', 'Thinking…'],
  ['Describe el objetivo del plan QA…', 'Describe the QA plan objective…'],
  ['Escribe tu consulta o petición…', 'Write your question or request…'],
  ['Enviar', 'Send'],
  ['Al enviar, resumiré la conversación para liberar contexto.', 'When you send, I will summarize the conversation to free context.'],
  ['Contexto usado', 'Context used'],
  ['archivo activo', 'active file'],
  ['selección', 'selection'],
  ['editores', 'editors'],
  ['terminales (metadatos)', 'terminals (metadata)'],
  ['memoria automática', 'automatic memory'],
  ['Ejecutar plan', 'Execute plan'],
  ['✓ Cambios aplicados', '✓ Changes applied'],
  ['Deshacer', 'Undo'],
  ['↩ Deshecho', '↩ Undone'],
  ['Aplicar seleccionados', 'Apply selected'],
  ['Aplicar todo', 'Apply all'],
  ['modifica', 'modified'],
  ['nuevo', 'new'],
  ['Vista histórica: esta propuesta no tiene IDs de selección aplicables.', 'Historical view: this proposal has no selectable IDs.'],
  ['Sin cambios de contenido.', 'No content changes.'],
  ['Cambio completo (vista previa)', 'Full change (preview)'],
  ['Comandos propuestos', 'Proposed commands'],
  ['Ejecutar', 'Run'],
  ['Ejecuciones', 'Runs'],
  ['(sin salida)', '(no output)'],
  ['Diagnosticar con IA', 'Diagnose with AI'],
  ['Ejecutando comando aprobado…', 'Running approved command…'],
  ['Verificación automática tras aplicar cambios…', 'Automatic verification after applying changes…'],
  ['Centro Latinoamericano de Testing y Calidad de Software', 'Latin American Center for Software Testing and Quality'],
  ['visitanos y obten acceso a nuestros cursos, descuentos y conocimiento de calidad, testing y automatización.', 'Visit us to access our courses, discounts, and knowledge about quality, testing, and automation.'],
  ['Todos los datos de API keys, modelos, etc. se almacenan 100% localmente. Esta app no registra datos de ningún tipo.', 'All API key, model, and related data is stored 100% locally. This app does not collect or record any data.'],
  ['Licencia MIT - ', 'MIT License - '],
  ['Repositorio oficial', 'Official repository'],
  ['Cargando configuración…', 'Loading settings…'],
  ['Idioma', 'Language'],
  ['Define el idioma de la interfaz y de las respuestas futuras del chat.', 'Set the language for the interface and future chat responses.'],
  ['Idioma de QAPI', 'QAPI language'],
  ['Proveedor de IA', 'AI provider'],
  ['Elige el proveedor y valida tus credenciales.', 'Choose the provider and validate your credentials.'],
  ['URL de Ollama', 'Ollama URL'],
  ['Validar', 'Validate'],
  ['No válido', 'Invalid'],
  ['Modelo', 'Model'],
  ['Guardar selección', 'Save selection'],
  ['Modelo actual', 'Current model'],
  ['Comportamiento', 'Behavior'],
  ['Validación opt-in: ejecuta un comando declarado por el proyecto sólo en workspaces confiables.', 'Opt-in validation: runs a command declared by the project only in trusted workspaces.'],
  ['Ejecutar validación detectada automáticamente', 'Run detected validation automatically'],
  ['Memoria del proyecto', 'Project memory'],
  ['Contexto persistente que QAPI tendrá en futuras conversaciones.', 'Persistent context QAPI will use in future conversations.'],
  ['Convenciones, objetivos, decisiones y datos útiles del proyecto…', 'Project conventions, goals, decisions, and useful information…'],
  ['Guardar', 'Save'],
  ['Limpiar', 'Clear'],
  ['Cambios sin guardar', 'Unsaved changes'],
  ['Checkpoints recientes', 'Recent checkpoints'],
  ['Restaura archivos modificados por QAPI.', 'Restore files modified by QAPI.'],
  ['Todavía no hay checkpoints.', 'There are no checkpoints yet.'],
  ['Trazabilidad estática inferida', 'Inferred static traceability'],
  ['Evidencia entre requisitos, escenarios, steps y pruebas; no representa cobertura de ejecución runtime.', 'Evidence across requirements, scenarios, steps, and tests; it does not represent runtime execution coverage.'],
  ['Actualizar', 'Refresh'],
  ['Actualiza para calcular cobertura y gaps.', 'Refresh to calculate coverage and gaps.'],
  ['Apariencia', 'Appearance'],
  ['Tema y tamaño de fuente.', 'Theme and font size.'],
  ['Oscuro', 'Dark'],
  ['Claro', 'Light'],
  ['Medianoche', 'Midnight'],
  ['Océano', 'Ocean'],
  ['Bosque', 'Forest'],
  ['Atardecer', 'Sunset'],
  ['Monocromo', 'Monochrome'],
  ['Solarizado', 'Solarized'],
  ['Tema', 'Theme'],
  ['Key guardada · escribe una nueva para reemplazarla', 'Key saved · type a new one to replace it'],
  ['Pega tu API key (si ya hay una guardada, déjalo vacío)', 'Paste your API key (leave empty to keep a saved one)'],
  ['Detener', 'Stop'],
  ['Autoaprobar MCP', 'Auto-approve MCP'],
  ['Tú decides qué verificar tras aplicar cambios. QAPI nunca elige ni ejecuta una suite por su cuenta.', 'You decide what to verify after applying changes. QAPI never picks or runs a suite on its own.'],
  ['Comando de verificación', 'Verification command'],
  ['Guardar comando', 'Save command'],
  ['Sugerir para este proyecto', 'Suggest for this project'],
  ['Comando de verificación guardado', 'Verification command saved'],
  ['Detener la solicitud en curso', 'Stop the current request'],
  ['Reducir tamaño de fuente', 'Decrease font size'],
  ['Aumentar tamaño de fuente', 'Increase font size'],
  ['Servidores MCP', 'MCP servers'],
  ['Define servidores en JSON. Habilitarlos autoriza al agente a iniciar el proceso y usar sus tools durante el chat.', 'Define servers in JSON. Enabling them authorizes the agent to start the process and use their tools during chat.'],
  ['Activa sólo servidores confiables: pueden ejecutar acciones y acceder a datos con tus permisos.', 'Enable only trusted servers: they can perform actions and access data with your permissions.'],
  ['Configuración (JSON)', 'Configuration (JSON)'],
  ['Requisitos', 'Requirements'],
  ['Escenarios', 'Scenarios'],
  ['Definiciones', 'Definitions'],
  ['Pruebas', 'Tests'],
  ['Steps vinculados', 'Linked steps'],
  ['Sin IDs de requisito detectados.', 'No requirement IDs detected.'],
  ['✓ Sin gaps detectados', '✓ No gaps detected'],
  ['Se esperaba un objeto "mcpServers" con los servidores.', 'Expected an "mcpServers" object containing the servers.'],
  ['(vacío)', '(empty)'],
  ['El nombre del servidor no puede estar vacío.', 'The server name cannot be empty.'],
  ['La definición debe ser un objeto.', 'The definition must be an object.'],
  ['Falta "command".', 'Missing "command".'],
  ['"args" debe ser un arreglo de strings.', '"args" must be an array of strings.'],
  ['"env" debe ser un objeto de strings.', '"env" must be an object of strings.'],
  ['Cargando agentes…', 'Loading agents…'],
  ['Sin descripción.', 'No description.'],
  ['Editar', 'Edit'],
  ['Eliminar', 'Delete'],
  ['Sin archivos que coincidan.', 'No matching files.'],
  ['Editar agente', 'Edit agent'],
  ['Nuevo agente', 'New agent'],
  ['Nombre', 'Name'],
  ['Descripción', 'Description'],
  ['Icono (emoji, opcional)', 'Icon (emoji, optional)'],
  ['Glob de archivos de entrada (opcional)', 'Input files glob (optional)'],
  ['Instrucciones', 'Instructions'],
  ['Salida', 'Output'],
  ['Ruta de salida (admite {name} y {date})', 'Output path (supports {name} and {date})'],
  ['Nombre e instrucciones son obligatorios.', 'Name and instructions are required.'],
  ['Cancelar', 'Cancel'],
  ['Seleccionar archivos…', 'Select files…'],
  ['Pega el texto, requisito o especificación aquí…', 'Paste the text, requirement, or specification here…'],
  ['Formatos: .md, .txt, .feature, .json, .yaml, .csv', 'Formats: .md, .txt, .feature, .json, .yaml, .csv'],
  ['Cerrar', 'Close'],
  ['Seleccionar todos', 'Select all'],
  ['Limpiar', 'Clear'],
  ['Listo', 'Done'],
  ['Entrada', 'Input'],
  ['Seleccionar archivos del proyecto', 'Select files from the project'],
  ['Texto libre o archivo adjunto', 'Free text or attached file'],
])

function translateUiText(value: string): string {
  if (settings?.language !== 'en') return value
  const exact = UI_EN.get(value)
  if (exact) return exact
  return value
    .replace(/^JSON inválido: /, 'Invalid JSON: ')
    .replace(/^No se encontró el ejecutable "([^"]+)" en el PATH\.$/, 'Executable "$1" was not found in PATH.')
    .replace(/^(\d+) archivos$/, '$1 files')
    .replace(/^(\d+) archivo\(s\) seleccionado\(s\)$/, '$1 file(s) selected')
    .replace(/^Seleccionar archivos — (.+)$/, 'Select files — $1')
    .replace(/^Filtrar \((.+)\)…$/, 'Filter ($1)…')
    .replace(/^Memoria del chat · (.+)$/, 'Chat memory · $1')
    .replace(/^herramientas: /, 'tools: ')
    .replace(/^(\d+) cambio\(s\) propuesto\(s\)$/, '$1 proposed change(s)')
    .replace(/^Todos los cambios · (.+)$/, 'All changes · $1')
    .replace(/^Tamaño de fuente: (.+)$/, 'Font size: $1')
    .replace(/^Actualizado (.+)$/, 'Updated $1')
    .replace(/^Requisitos \((\d+)\)$/, 'Requirements ($1)')
    .replace(/^Evidencias inferidas \((\d+)\)$/, 'Inferred evidence ($1)')
    .replace(/^Gaps \((\d+)\)$/, 'Gaps ($1)')
    .replace(/^✓ Válido · (\d+) modelos$/, '✓ Valid · $1 models')
    .replace(/^✓ (\d+) servidor\(es\) válido\(s\)$/, '✓ $1 valid server(s)')
    .replace(/^⚠ (\d+) con problemas$/, '⚠ $1 with issues')
    .replace(/^(.*) · (\d+) archivo\(s\)(.*)$/, '$1 · $2 file(s)$3')
    .replace(/ · recuperando/g, ' · recovering')
    .replace(/ · deshecho/g, ' · undone')
}

/** Contenido del chat, diffs y salidas: nunca se traducen (alteraría evidencia). */
const NO_I18N_SELECTOR = '.message-content, .diff-code, .run-output, .prop-path, .command-info code, pre, code, textarea, [data-no-i18n]'

function localizeUi(container: HTMLElement) {
  if (settings?.language !== 'en') return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(NO_I18N_SELECTOR)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.nodeValue) node.nodeValue = translateUiText(node.nodeValue)
  }
  for (const element of Array.from(container.querySelectorAll<HTMLElement>('[title]'))) {
    element.title = translateUiText(element.title)
  }
  for (const element of Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[placeholder]'))) {
    element.placeholder = translateUiText(element.placeholder)
  }
}

// ── Helpers DOM ─────────────────────────────────────────────────────────────

function div(cls: string): HTMLDivElement {
  const element = document.createElement('div')
  if (cls) element.className = cls
  return element
}
function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.className = cls
  element.textContent = label
  element.onclick = onClick
  return element
}
function iconBtn(title: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = button(label, 'icon-btn', onClick)
  element.title = title
  return element
}
function linkBtn(label: string, onClick: () => void): HTMLButtonElement { return button(label, 'link-btn', onClick) }
function checkbox(checked: boolean, onChange: () => void): HTMLInputElement {
  const element = document.createElement('input')
  element.type = 'checkbox'
  element.checked = checked
  element.onchange = onChange
  return element
}
function labeledControl(control: HTMLElement, text: string): HTMLLabelElement {
  const label = document.createElement('label')
  label.className = 'check-label'
  label.appendChild(control)
  const value = document.createElement('span')
  value.textContent = text
  label.appendChild(value)
  return label
}
function card(titleText: string, hint: string): HTMLDetailsElement {
  const element = document.createElement('details')
  element.className = 'card setting-accordion'
  // render() reconstruye todo el DOM en cada interacción; sin esto, el <details>
  // se recrea cerrado y cualquier click dentro del acordeón lo colapsa.
  element.open = openAccordions.has(titleText)
  element.addEventListener('toggle', () => {
    if (element.open) openAccordions.add(titleText)
    else openAccordions.delete(titleText)
  })
  const summary = document.createElement('summary')
  summary.className = 'setting-summary'
  const heading = div('setting-heading')
  const title = document.createElement('h3')
  title.textContent = titleText
  const description = document.createElement('p')
  description.className = 'hint'
  description.textContent = hint
  heading.appendChild(title)
  heading.appendChild(description)
  summary.appendChild(heading)
  element.appendChild(summary)
  return element
}
function field(labelText: string, control: HTMLElement): HTMLElement {
  const element = div('field')
  const label = document.createElement('label')
  label.textContent = labelText
  element.appendChild(label)
  element.appendChild(control)
  return element
}
function inputEl(type: string, value: string, onInput: (value: string) => void): HTMLInputElement {
  const element = document.createElement('input')
  element.type = type
  element.value = value
  element.oninput = () => onInput(element.value)
  return element
}
function toast(text: string) {
  const element = div('toast')
  element.textContent = translateUiText(text)
  document.body.appendChild(element)
  setTimeout(() => element.remove(), 2600)
}

function announceReady() { post({ type: 'ready' }) }

window.addEventListener('pageshow', announceReady)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') announceReady()
})

render()
announceReady()
