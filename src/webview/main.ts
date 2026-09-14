// UI del webview QAPI (TS vanilla, sin framework, para un bundle liviano).
import { renderMarkdown } from './markdown'
import type {
  AgentMode, ChatTurn, Checkpoint, ContextUsage, CustomAgentDefinition, CustomAgentOutputMode, DiffHunk,
  ExecutionRun, FileProposal, McpValidation, ProviderId, Settings, SpecPhase, SpecSummary, SpecTask, ToWebview,
  TraceabilitySummary, UiLanguage, VerificationMode,
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

type TabId = 'chat' | 'agents' | 'settings' | 'centyc'
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
let tab: TabId = saved.tab === 'settings' || saved.tab === 'centyc' || saved.tab === 'agents' ? saved.tab : 'chat'
let thinking = false
let toolTrace: string[] = []
let streamedText = ''
let validation: { ok: boolean; models: string[]; limits?: Record<string, number>; message?: string } | null = null
let draftProvider: Settings['provider'] | null = saved.providerDraft ? { ...saved.providerDraft } : null
let mcpDraft: string | null = null
let mcpValidation: McpValidation | null = null
let mode: AgentMode = saved.mode === 'plan' ? 'plan' : 'chat'
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
let editingAgent: CustomAgentDefinition | null = null
let editingAgentPreviousSlug: string | undefined
let refSuggestions: string[] = []
let refIndex = 0
let refQueryStart = -1
const openAccordions = new Set<string>()
let traceability: TraceabilitySummary | null = null
let executionCommand = ''
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
      case 'settings':
        settings = msg.settings
        draftProvider = { ...msg.settings.provider }
        applyTheme()
        render()
        break
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
        render()
        break
      case 'assistantDone':
        thinking = false
        toolTrace = []
        streamedText = ''
        usage = msg.usage
        render()
        break
      case 'toolProgress':
        toolTrace.push(`${msg.tool}: ${msg.detail}`)
        render()
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
      case 'error':
        thinking = false
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
        toast('Memoria actualizada')
        render()
        break
      case 'specs':
        specs = msg.specs
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
        render()
        break
      case 'indexStatus':
        indexing = msg.indexing
        indexedFiles = msg.files
        render()
        break
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
  document.body.classList.toggle('theme-light', settings.theme === 'light')
  document.documentElement.style.setProperty('--qp-font', `${settings.fontSize}px`)
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
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
      const streamingContent = div('message-content')
      streamingContent.textContent = streamedText
      streamingBubble.appendChild(streamingContent)
      streamingBubble.appendChild(div('stream-caret'))
      streaming.appendChild(streamingBubble)
      msgs.appendChild(streaming)
    } else {
      const t = div('thinking')
      t.appendChild(div('dot-spin'))
      t.appendChild(document.createTextNode(toolTrace.length ? 'Investigando el proyecto…' : 'Pensando…'))
      msgs.appendChild(t)
      for (const line of toolTrace.slice(-6)) {
        const trace = div('tool-line')
        trace.textContent = `↳ ${line}`
        msgs.appendChild(trace)
      }
    }
  }
  view.appendChild(msgs)

  const composer = div('composer')
  const modeSelect = document.createElement('select')
  modeSelect.className = 'mode-select'
  for (const [value, label] of [['chat', 'Agente'], ['plan', 'Plan QA']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = mode === value
    modeSelect.appendChild(option)
  }
  modeSelect.onchange = () => { mode = modeSelect.value as AgentMode; saveLocalState() }
  const ta = document.createElement('textarea')
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
  const sendButton = button('Enviar', 'btn btn-primary', () => sendComposer(ta))
  sendButton.disabled = thinking
  composer.appendChild(modeSelect)
  composer.appendChild(ta)
  composer.appendChild(sendButton)
  if (refSuggestions.length) view.appendChild(contextRefList(ta))
  view.appendChild(composer)

  setTimeout(() => { msgs.scrollTop = msgs.scrollHeight }, 0)
  return view
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
  post({ type: 'sendMessage', text, mode: messageMode })
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

  if (agent.inputGlob) {
    card.appendChild(agentFilePicker(agent))
  }

  const runRow = div('agent-run-row')
  const selectedCount = (agentSelectedFiles[agent.slug] || []).length
  if (agent.inputGlob && selectedCount) {
    const count = div('agent-selected-count')
    count.textContent = tr(`${selectedCount} archivo(s) seleccionado(s)`, `${selectedCount} file(s) selected`)
    runRow.appendChild(count)
  }
  const runBtn = button(tr('Ejecutar', 'Run'), 'btn btn-primary btn-sm', () => {
    tab = 'chat'
    post({ type: 'runCustomAgent', slug: agent.slug, files: agentSelectedFiles[agent.slug] || [] })
    render()
  })
  runBtn.disabled = thinking || Boolean(agent.inputGlob && !selectedCount)
  runRow.appendChild(runBtn)
  card.appendChild(runRow)
  return card
}

function agentFilePicker(agent: CustomAgentDefinition): HTMLElement {
  const wrap = div('agent-file-picker')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = tr(`Filtrar archivos (${agent.inputGlob})…`, `Filter files (${agent.inputGlob})…`)
  input.value = agentFileFilter[agent.slug] || ''
  input.oninput = () => {
    agentFileFilter[agent.slug] = input.value
    post({ type: 'suggestAgentFiles', glob: agent.inputGlob || '' })
  }
  wrap.appendChild(input)

  const filterText = (agentFileFilter[agent.slug] || '').toLowerCase()
  const selected = new Set(agentSelectedFiles[agent.slug] || [])
  const candidates = (agentFileSuggestions.length ? agentFileSuggestions : [...selected])
    .filter((path) => !filterText || path.toLowerCase().includes(filterText))
    .slice(0, 30)

  const list = div('agent-file-list')
  if (!candidates.length) {
    const empty = div('muted')
    empty.textContent = tr('Sin archivos que coincidan.', 'No matching files.')
    list.appendChild(empty)
  }
  for (const path of candidates) {
    const row = div('agent-file-row')
    const check = checkbox(selected.has(path), () => {
      const current = new Set(agentSelectedFiles[agent.slug] || [])
      if (check.checked) current.add(path); else current.delete(path)
      agentSelectedFiles[agent.slug] = [...current]
      saveLocalState()
      render()
    })
    row.appendChild(labeledControl(check, path))
    list.appendChild(row)
  }
  wrap.appendChild(list)
  return wrap
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

  const globField = field(
    tr('Glob de archivos de entrada (opcional)', 'Input files glob (optional)'),
    inputEl('text', agent.inputGlob || '', (value) => { agent.inputGlob = value }),
  )
  view.appendChild(globField)

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
    else if (turn.proposals) state.appendChild(linkBtn('Deshacer', () => post({ type: 'undoProposals', turnIndex: index, proposals: turn.proposals! })))
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
    post({ type: 'applyProposals', turnIndex, selections: proposalSelections(turnIndex, eligible, false) })
  })
  applySelected.disabled = selected === 0
  const applyAll = button('Aplicar todo', 'btn btn-ghost btn-sm', () => {
    post({ type: 'applyProposals', turnIndex, selections: proposalSelections(turnIndex, eligible, true) })
  })
  applyAll.disabled = total === 0
  actions.appendChild(applySelected)
  actions.appendChild(applyAll)
  box.appendChild(actions)
  return box
}

function proposalDiff(proposal: FileProposal, turnIndex: number, selectable: boolean): HTMLElement {
  const details = document.createElement('details')
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
    const ids = selections[String(turnIndex)]?.[proposal.id!] || []
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
    const selected = selections[String(turnIndex)]?.[proposal.id!] || []
    const control = checkbox(selected.includes(hunk.id), () => {
      const next = new Set(selections[String(turnIndex)]?.[proposal.id!] || [])
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

function splitPreviewLines(text: string): string[] { return text ? text.replace(/\r\n/g, '\n').split('\n') : [] }
function isSelectableProposal(proposal: FileProposal): boolean { return Boolean(proposal.id && proposal.hunks?.length) }

function ensureSelectionDefaults(turnIndex: number, proposals: FileProposal[]) {
  const key = String(turnIndex)
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
  const key = String(turnIndex)
  selections[key] ||= {}
  selections[key][proposalId] = hunkIds
  saveLocalState()
}

function setAllSelections(turnIndex: number, proposals: FileProposal[], checked: boolean) {
  for (const proposal of proposals) setProposalSelection(turnIndex, proposal.id!, checked ? proposal.hunks!.map((h) => h.id) : [])
}

function selectedCount(turnIndex: number, proposals: FileProposal[]): number {
  return proposals.reduce((sum, proposal) => sum + (selections[String(turnIndex)]?.[proposal.id!]?.length || 0), 0)
}

function proposalSelections(turnIndex: number, proposals: FileProposal[], all: boolean) {
  return proposals.map((proposal) => ({
    proposalId: proposal.id!,
    hunkIds: all ? proposal.hunks!.map((hunk) => hunk.id) : (selections[String(turnIndex)]?.[proposal.id!] || []),
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
    item.appendChild(button('Ejecutar', 'btn btn-ghost btn-sm', () => post({ type: 'runCommand', turnIndex, commandId: command.id })))
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
    const details = document.createElement('details')
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
  label.textContent = 'Ejecutando comando aprobado…'
  const code = document.createElement('code')
  code.textContent = command
  text.appendChild(label)
  text.appendChild(code)
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
  if (providerDef.needsKey) cIa.appendChild(field('API Key', inputEl('password', dp.apiKey || '', (value) => {
    dp.apiKey = value
    validation = null
    saveLocalState()
  })))
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

  const cBehavior = card('Comportamiento', 'Verificación opt-in: ejecuta el comando declarado por el proyecto sólo en workspaces confiables.')
  const verificationSelect = document.createElement('select')
  const verificationOptions: [VerificationMode, string, string][] = [
    ['off', 'No verificar', 'Do not verify'],
    ['validate', 'Validar después de aplicar', 'Validate after applying'],
    ['autofix', 'Validar y corregir automáticamente', 'Validate and fix automatically'],
  ]
  for (const [value, es, en] of verificationOptions) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = tr(es, en)
    option.selected = currentSettings.verification === value
    verificationSelect.appendChild(option)
  }
  verificationSelect.onchange = () => {
    post({ type: 'saveSettings', settings: { verification: verificationSelect.value as VerificationMode } })
  }
  cBehavior.appendChild(field('Verificación tras aplicar cambios', verificationSelect))
  const verificationHint = div('muted')
  verificationHint.textContent = tr(
    'Con corrección automática, QAPI reintenta hasta 3 veces y se detiene si el error no avanza.',
    'With automatic fixing, QAPI retries up to 3 times and stops if the error does not progress.',
  )
  cBehavior.appendChild(verificationHint)
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
  for (const [value, label] of [['dark', 'Oscuro'], ['light', 'Claro']]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = currentSettings.theme === value
    themeSelect.appendChild(option)
  }
  themeSelect.onchange = () => post({ type: 'saveSettings', settings: { theme: themeSelect.value as 'dark' | 'light' } })
  cUi.appendChild(field('Tema', themeSelect))
  const fontWrap = div('field')
  const fontLabel = document.createElement('label')
  fontLabel.textContent = tr(`Tamaño de fuente: ${currentSettings.fontSize}px`, `Font size: ${currentSettings.fontSize}px`)
  const range = document.createElement('input')
  range.type = 'range'
  range.min = '11'
  range.max = '18'
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

  const cMcp = card('Servidores MCP', 'Define servidores en JSON. Habilitarlos autoriza al agente a iniciar el proceso y usar sus tools durante el chat.')
  const mcpWarning = div('status-warn')
  mcpWarning.textContent = 'Activa sólo servidores confiables: pueden ejecutar acciones y acceder a datos con tus permisos.'
  cMcp.appendChild(mcpWarning)
  const mcpEditor = document.createElement('textarea')
  mcpEditor.className = 'json-editor'
  mcpEditor.spellcheck = false
  mcpEditor.value = mcpDraft ?? currentSettings.mcpJson
  mcpEditor.oninput = () => { mcpDraft = mcpEditor.value; saveLocalState() }
  cMcp.appendChild(field('Configuración (JSON)', mcpEditor))
  const actions = div('row')
  actions.appendChild(button('Validar', 'btn btn-ghost btn-sm', () => post({ type: 'validateMcp', json: mcpDraft ?? currentSettings.mcpJson })))
  actions.appendChild(button('Guardar', 'btn btn-primary btn-sm', () => {
    post({ type: 'saveMcpJson', json: mcpDraft ?? currentSettings.mcpJson })
    toast('Configuración MCP guardada')
  }))
  cMcp.appendChild(actions)
  if (mcpValidation) {
    if (mcpValidation.error) {
      const error = div('status-err')
      error.textContent = `✕ ${mcpValidation.error}`
      cMcp.appendChild(error)
    } else {
      const okCount = mcpValidation.issues.filter((issue) => issue.ok).length
      const summary = div(mcpValidation.ok ? 'status-ok' : 'status-err')
      summary.textContent = mcpValidation.ok ? `✓ ${okCount} servidor(es) válido(s)` : `⚠ ${mcpValidation.issues.length - okCount} con problemas`
      cMcp.appendChild(summary)
      for (const issue of mcpValidation.issues) {
        const item = div('mcp-item')
        const info = div('')
        const name = div(`name ${issue.ok ? 'status-ok' : 'status-err'}`)
        name.textContent = `${issue.ok ? '✓' : '✕'} ${issue.name}`
        const command = div('cmd')
        command.textContent = issue.message
        info.appendChild(name)
        info.appendChild(command)
        item.appendChild(info)
        if (issue.ok) {
          const toggle = checkbox(Boolean(currentSettings.mcpEnabled[issue.name]), () => post({ type: 'toggleMcp', name: issue.name, enabled: toggle.checked }))
          toggle.className = 'switch'
          item.appendChild(toggle)
        }
        cMcp.appendChild(item)
      }
    }
  }
  view.appendChild(cMcp)
  return view
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
  ['Tema', 'Theme'],
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

function localizeUi(container: HTMLElement) {
  if (settings?.language !== 'en') return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
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
