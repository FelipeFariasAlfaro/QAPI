// Frontera VS Code/webview: coordina contexto, agente, cambios, ejecución y estado.
import * as vscode from 'vscode'
import { Store } from './store'
import { ProjectIndex } from './projectIndex'
import { validateProvider } from './providers'
import { ask, compactHistory } from './agent'
import { resolveContextRefs, suggestContextRefs } from './contextRefs'
import { computeUsage } from './contextWindow'
import { parseMcpConfig, validateMcpConfig } from './mcp'
import { applyProposalSelections, reconcileCheckpoint, undoCheckpoint } from './changes'
import { analyzeTestImpact, captureIdeContext, discoverArtifacts, readArtifact } from './ideContext'
import { createCommandProposal, formatRun, runCommand } from './execution'
import { verifyAndFix } from './verification'
import { buildTraceability } from './traceability'
import { loadSteeringRules, selectSteering } from './steering'
import { buildTaskContext, listSpecs, readSpec, slugifySpecName, updateTaskStatus } from './specs'
import { buildRunInstruction, deleteCustomAgent, listCustomAgents, matchAgentFiles, saveCustomAgent } from './customAgents'
import {
  AgentMode, ChatTurn, Checkpoint, ExecutionRun, FileProposal, Settings, SpecDocumentKind, SpecPhase, SpecSummary,
  ToHost, TraceabilitySummary, UiLanguage,
} from './types'

export class QaPiViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'qa-pi.chat'
  private view?: vscode.WebviewView
  private initializedViews = new WeakSet<vscode.WebviewView>()
  private initializations = new WeakMap<vscode.WebviewView, Promise<void>>()
  private busy = false
  private commandRunning = false

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly index: ProjectIndex,
  ) {}

  reveal() { this.view?.show?.(true) }
  post(message: unknown) { void this.view?.webview.postMessage(message) }
  isBusy(): boolean { return this.busy || this.commandRunning }

  /** Entrada de un hook con acción de agente. */
  async runHookPrompt(prompt: string): Promise<void> {
    const settings = await this.store.getSettings()
    if (!settings.configured || !settings.provider.model || this.isBusy()) return
    await this.onSend(prompt, 'chat')
  }

  /** Entrada de un hook con acción de comando: se propone, no se ejecuta sola. */
  async runHookCommand(command: string, reason: string): Promise<void> {
    if (!vscode.workspace.isTrusted || this.isBusy()) return
    const settings = await this.store.getSettings()
    const language = settings.language || 'es'
    let history = this.store.getHistory()
    history.push({
      role: 'assistant',
      text: ui(language,
        `Un hook del proyecto propone ejecutar un comando: ${reason}`,
        `A project hook proposes running a command: ${reason}`),
      commandProposals: [createCommandProposal(command, reason)],
    })
    history = await this.store.saveHistory(history)
    this.post({ type: 'history', history, usage: await this.usage(history, settings) })
  }

  private async usage(history: ChatTurn[], settings?: Settings) {
    const current = settings || await this.store.getSettings()
    return computeUsage(history, current.provider.provider, current.provider.model, current.provider.contextLimit)
  }

  async clearChat() {
    await this.store.clearHistory()
    this.post({ type: 'history', history: [], usage: await this.usage([]) })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    }

    // El receptor debe existir antes de cargar el bundle: `ready` puede emitirse
    // inmediatamente y se perdía al restaurar una vista retenida tras reinstalar.
    const messageSubscription = view.webview.onDidReceiveMessage((message: ToHost) => {
      void this.handle(message, view)
    })
    const visibilitySubscription = view.onDidChangeVisibility(() => {
      if (view.visible && this.view === view) void this.sendInit(view)
    })
    const disposeSubscription = view.onDidDispose(() => {
      messageSubscription.dispose()
      visibilitySubscription.dispose()
      if (this.view === view) this.view = undefined
    })
    this.ctx.subscriptions.push(messageSubscription, visibilitySubscription, disposeSubscription)
    view.webview.html = this.html(view.webview)
  }

  private sendInit(view: vscode.WebviewView): Promise<void> {
    if (this.initializedViews.has(view)) return Promise.resolve()
    const existing = this.initializations.get(view)
    if (existing) return existing

    const run = this.initializeView(view)
      .then(() => {
        if (this.view === view) this.initializedViews.add(view)
      })
      .finally(() => this.initializations.delete(view))
    this.initializations.set(view, run)
    return run
  }

  private async initializeView(view: vscode.WebviewView): Promise<void> {
    if (this.view !== view) return
    const settings = await this.store.getSettings()
    for (const checkpoint of this.store.getCheckpoints().filter((item) => item.pending)) {
      await this.store.updateCheckpoint(await reconcileCheckpoint(checkpoint))
      if (this.view !== view) return
    }
    const history = this.store.getHistory()
    const checkpoints = localizeCheckpoints(this.store.getCheckpoints(), settings.language || 'es')
    const usage = await this.usage(history, settings)
    if (this.view !== view) return
    await view.webview.postMessage({
      type: 'init', settings, history, projectName: this.index.projectName,
      usage, memory: this.store.getMemory(), checkpoints,
    })
    await view.webview.postMessage({ type: 'indexStatus', indexing: this.index.indexing, files: this.index.fileCount })
    await view.webview.postMessage({ type: 'specs', specs: await listSpecs() })
    await view.webview.postMessage({ type: 'customAgents', agents: await listCustomAgents() })

    // La validación de ejecutables MCP puede tardar; nunca debe bloquear el primer render.
    const mcpValidation = await validateMcpConfig(settings.mcpJson)
    if (this.view === view) await view.webview.postMessage({ type: 'mcpValidation', result: mcpValidation })
  }

  private async handle(message: ToHost, sourceView: vscode.WebviewView) {
    if (this.view !== sourceView) return
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit(sourceView)
          break
        case 'getSettings':
          this.post({ type: 'settings', settings: await this.store.getSettings() })
          break
        case 'saveSettings': {
          const settings = await this.store.saveSettings(message.settings)
          this.post({ type: 'settings', settings })
          this.post({
            type: 'checkpoints',
            checkpoints: localizeCheckpoints(this.store.getCheckpoints(), settings.language || 'es'),
          })
          break
        }
        case 'saveMemory': {
          const text = await this.store.saveMemory(message.text)
          this.post({ type: 'memory', text })
          break
        }
        case 'validateProvider': {
          const result = await validateProvider(message.provider)
          const language = (await this.store.getSettings()).language || 'es'
          this.post({
            type: 'validationResult', ...result,
            message: result.message ? localizeHostError(result.message, language) : undefined,
          })
          break
        }
        case 'validateMcp':
          this.post({ type: 'mcpValidation', result: await validateMcpConfig(message.json) })
          break
        case 'saveMcpJson': {
          const validation = await validateMcpConfig(message.json)
          this.post({ type: 'mcpValidation', result: validation })
          if (!validation.ok) throw new Error(validation.error || 'Corrige la configuración MCP antes de guardarla.')
          const current = await this.store.getSettings()
          const valid = new Set(validation.servers.map((server) => server.name))
          const enabled = Object.fromEntries(Object.entries(current.mcpEnabled).filter(([name]) => valid.has(name)))
          const settings = await this.store.saveSettings({ mcpJson: message.json, mcpEnabled: enabled })
          this.post({ type: 'settings', settings })
          break
        }
        case 'toggleMcp': {
          const settings = await this.store.getSettings()
          const parsed = parseMcpConfig(settings.mcpJson)
          if (!parsed.servers.some((server) => server.name === message.name)) throw new Error('Servidor MCP desconocido.')
          this.post({ type: 'settings', settings: await this.store.setMcpEnabled(message.name, message.enabled) })
          break
        }
        case 'reindex':
          await this.index.build((indexing, files) => this.post({ type: 'indexStatus', indexing, files }))
          break
        case 'clearChat':
          await this.clearChat()
          break
        case 'sendMessage':
          await this.onSend(message.text, message.mode || 'chat')
          break
        case 'applyProposals':
          await this.applySelections(message.turnIndex, message.selections)
          break
        case 'runCommand':
          await this.runApprovedCommand(message.turnIndex, message.commandId)
          break
        case 'undoCheckpoint':
          await this.restoreCheckpoint(message.checkpointId)
          break
        case 'undoProposals': {
          const turn = this.store.getHistory()[message.turnIndex]
          if (!turn?.checkpointId) throw new Error('Este cambio antiguo no tiene un checkpoint seguro para deshacer.')
          await this.restoreCheckpoint(turn.checkpointId)
          break
        }
        case 'analyzeImpact': {
          const snapshot = await captureIdeContext()
          const impact = await analyzeTestImpact(snapshot, this.index)
          const language = (await this.store.getSettings()).language || 'es'
          const es = language === 'es'
          await this.appendAssistant(es ? [
            '## Pruebas impactadas (evidencia inferida)',
            `Cambios: ${impact.changedFiles.join(', ') || 'sin Git diff'}`,
            `Pruebas probables:\n${impact.probableTests.map((item) => `- ${item}`).join('\n') || '- sin relación directa'}`,
            `Comandos sugeridos:\n${impact.suggestedCommands.map((item) => `- \`${item}\``).join('\n') || '- sin comando detectado'}`,
            impact.fallback ? 'Se recomienda ejecutar la suite detectada como fallback.' : '',
          ].filter(Boolean).join('\n\n') : [
            '## Impacted tests (inferred evidence)',
            `Changes: ${impact.changedFiles.join(', ') || 'no Git diff'}`,
            `Probable tests:\n${impact.probableTests.map((item) => `- ${item}`).join('\n') || '- no direct relationship'}`,
            `Suggested commands:\n${impact.suggestedCommands.map((item) => `- \`${item}\``).join('\n') || '- no command detected'}`,
            impact.fallback ? 'Running the detected suite as a fallback is recommended.' : '',
          ].filter(Boolean).join('\n\n'))
          break
        }
        case 'diagnoseLatestArtifact': {
          const artifact = (await discoverArtifacts())[0]
          const language = (await this.store.getSettings()).language || 'es'
          if (!artifact) {
            throw new Error(ui(language, 'No se encontraron reportes, logs, screenshots ni traces.', 'No reports, logs, screenshots, or traces were found.'))
          }
          const evidence = await readArtifact(artifact)
          await this.onSend(ui(
            language,
            `Diagnostica la causa raíz del artefacto más reciente. Evidencia:\n\n${evidence}`,
            `Diagnose the root cause of the latest artifact. Evidence:\n\n${evidence}`,
          ), 'chat')
          break
        }
        case 'rebuildTraceability': {
          const language = (await this.store.getSettings()).language || 'es'
          const summary = await buildTraceability(this.index)
          this.post({ type: 'traceability', summary: localizeTraceability(summary, language) })
          break
        }
        case 'refreshSpecs':
          this.post({ type: 'specs', specs: await listSpecs() })
          break
        case 'suggestContextRefs':
          this.post({
            type: 'contextRefSuggestions',
            suggestions: await suggestContextRefs(this.index, message.query),
          })
          break
        case 'openSpecDocument': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri
          const language = (await this.store.getSettings()).language || 'es'
          if (!root) throw new Error(ui(language, 'No hay carpeta de proyecto abierta', 'No project folder is open'))
          const file = `${DOCUMENT_FILE_NAMES[message.kind]}`
          const uri = vscode.Uri.joinPath(root, '.qapi', 'specs', slugifySpecName(message.slug), file)
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false })
          break
        }
        case 'runSpecTask': {
          const language = (await this.store.getSettings()).language || 'es'
          const context = await buildTaskContext(message.slug, message.taskId)
          if (!context) throw new Error(ui(language, 'La tarea del spec ya no está disponible.', 'The spec task is no longer available.'))
          await updateTaskStatus(message.slug, message.taskId, 'in-progress')
          this.post({ type: 'specs', specs: await listSpecs() })
          await this.onSend(ui(language,
            `Implementa la tarea asignada del spec y marca su estado al terminar con update_task_status.\n\n${context}`,
            `Implement the assigned spec task and mark its status with update_task_status when done.\n\n${context}`,
          ), 'chat')
          this.post({ type: 'specs', specs: await listSpecs() })
          break
        }
        case 'advanceSpecPhase': {
          const language = (await this.store.getSettings()).language || 'es'
          const spec = await readSpec(message.slug)
          if (!spec) throw new Error(ui(language, 'El spec ya no está disponible.', 'The spec is no longer available.'))
          await this.onSend(specPhasePrompt(spec, message.phase, language), 'chat')
          this.post({ type: 'specs', specs: await listSpecs() })
          break
        }
        case 'refreshCustomAgents':
          this.post({ type: 'customAgents', agents: await listCustomAgents() })
          break
        case 'suggestAgentFiles':
          this.post({ type: 'agentFileSuggestions', files: matchAgentFiles(this.index, message.glob) })
          break
        case 'saveCustomAgent': {
          await saveCustomAgent(message.agent, message.previousSlug)
          this.post({ type: 'customAgents', agents: await listCustomAgents() })
          break
        }
        case 'deleteCustomAgent': {
          await deleteCustomAgent(message.slug)
          this.post({ type: 'customAgents', agents: await listCustomAgents() })
          break
        }
        case 'runCustomAgent': {
          const language = (await this.store.getSettings()).language || 'es'
          const agents = await listCustomAgents()
          const agent = agents.find((item) => item.slug === message.slug)
          if (!agent) throw new Error(ui(language, 'El agente ya no está disponible.', 'The agent is no longer available.'))
          const instruction = await buildRunInstruction(agent, this.index, message.files)
          await this.onSend(instruction, 'chat')
          break
        }
      }
    } catch (error: any) {
      const language = (await this.store.getSettings()).language || 'es'
      this.post({ type: 'error', message: localizeHostError(String(error?.message || error), language) })
    }
  }

  private async onSend(text: string, mode: AgentMode) {
    const settings = await this.store.getSettings()
    const language = settings.language || 'es'
    if (this.busy) throw new Error(ui(language, 'QAPI ya está procesando otra tarea.', 'QAPI is already processing another task.'))
    if (!settings.language) throw new Error('Selecciona un idioma antes de chatear. / Select a language before chatting.')
    if (!settings.configured || !settings.provider.model) {
      throw new Error(ui(language, 'Configura un proveedor y modelo antes de chatear.', 'Configure a provider and model before chatting.'))
    }
    this.busy = true
    const requestRoot = currentWorkspaceRoot()
    let history = this.store.getHistory()

    try {
      const pre = computeUsage(history, settings.provider.provider, settings.provider.model, settings.provider.contextLimit)
      if (pre.needsSummary && history.length > 0) {
        try {
          const compacted = await compactHistory(settings, history, language)
          if (compacted) {
            history = await this.store.saveHistory(compacted)
            assertWorkspaceRoot(requestRoot)
            this.post({ type: 'history', history, usage: await this.usage(history, settings) })
            this.post({ type: 'summarized', usage: await this.usage(history, settings) })
          }
        } catch { /* el chat sigue sin compactar si el proveedor falla */ }
      }

      history.push({ role: 'user', text, mode })
      history = await this.store.saveHistory(history)
      assertWorkspaceRoot(requestRoot)
      this.post({ type: 'history', history, usage: await this.usage(history, settings) })
      this.post({ type: 'assistantStart' })

      const context = await captureIdeContext()
      assertWorkspaceRoot(requestRoot)
      const explicitContext = await resolveContextRefs(text, this.index, context)
      const steering = await selectSteering(await loadSteeringRules(), context, explicitContext.steeringNames)
      if (explicitContext.missing.length) {
        this.post({
          type: 'error',
          message: ui(language,
            `No pude resolver: ${explicitContext.missing.join(', ')}`,
            `Could not resolve: ${explicitContext.missing.join(', ')}`),
        })
      }
      const investigationMemory = this.store.getInvestigationMemory()
      let turn: ChatTurn
      try {
        turn = await ask(
          settings, text, history, this.index, context, this.store.getMemory(), mode,
          (tool, detail) => {
            if (currentWorkspaceRoot() === requestRoot) this.post({ type: 'toolProgress', tool, detail })
          },
          investigationMemory,
          (server, tool) => this.approveMcpCall(server, tool, language),
          steering,
          explicitContext,
          (chunk) => {
            if (currentWorkspaceRoot() === requestRoot) this.post({ type: 'assistantChunk', text: chunk })
          },
        )
      } finally {
        await this.store.saveInvestigationMemory(investigationMemory)
      }
      assertWorkspaceRoot(requestRoot)
      history.push(turn)
      history = await this.store.saveHistory(history)
      assertWorkspaceRoot(requestRoot)
      const usage = await this.usage(history, settings)
      this.post({ type: 'assistantDone', turn, usage })
      this.post({ type: 'history', history, usage })
      if (turn.specTouched) this.post({ type: 'specs', specs: await listSpecs() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'QAPI_WORKSPACE_CHANGED_DURING_REQUEST' || currentWorkspaceRoot() !== requestRoot) {
        await this.store.clearHistory()
        this.post({ type: 'history', history: [], usage: await this.usage([], settings) })
      }
      this.post({ type: 'error', message: localizeHostError(message, language) })
    } finally {
      this.busy = false
    }
  }

  private async approveMcpCall(server: string, tool: string, language: UiLanguage): Promise<boolean> {
    const approve = ui(language, 'Permitir una vez', 'Allow once')
    const choice = await vscode.window.showWarningMessage(
      ui(language,
        `El servidor MCP “${server}” solicita ejecutar “${tool}”. Las tools MCP son externas y pueden leer o modificar datos.`,
        `MCP server “${server}” requests permission to run “${tool}”. MCP tools are external and may read or modify data.`),
      { modal: true },
      approve,
    )
    return choice === approve
  }

  private async applySelections(turnIndex: number, selections: { proposalId: string; hunkIds: string[] }[]) {
    let history = this.store.getHistory()
    const turn = history[turnIndex]
    if (!turn?.proposals?.length) throw new Error('La propuesta ya no está disponible.')
    const result = await applyProposalSelections(
      turn.proposals,
      selections,
      turn.text.slice(0, 100) || 'Cambios QAPI',
      async (checkpoint) => { await this.store.saveCheckpoint(checkpoint) },
    )
    turn.applied = true
    turn.proposals = result.applied
    turn.checkpointId = result.checkpoint.id
    history = await this.store.saveHistory(history)
    this.post({ type: 'history', history, usage: await this.usage(history) })
    const checkpointLanguage = (await this.store.getSettings()).language || 'es'
    this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), checkpointLanguage) })
    await this.index.build((indexing, files) => this.post({ type: 'indexStatus', indexing, files }))

    const settings = await this.store.getSettings()
    const language = settings.language || 'es'
    const outcome = await verifyAndFix({
      mode: settings.verification,
      provider: settings.provider,
      profile: this.index.profile,
      index: this.index,
      language,
      trusted: vscode.workspace.isTrusted,
      onRun: (command) => this.post({ type: 'executionProgress', command }),
      runCommandExclusive: (proposal) => this.executeCommand(proposal!, true),
      persistCheckpoint: async (checkpoint) => { await this.store.saveCheckpoint(checkpoint) },
    })

    if (outcome.runs.length || outcome.appliedFixes.length || outcome.note) {
      turn.runs = [...(turn.runs || []), ...outcome.runs]
      if (outcome.appliedFixes.length) {
        turn.proposals = mergeAppliedProposals(turn.proposals || [], outcome.appliedFixes)
      }
      const lastCheckpoint = outcome.checkpoints[outcome.checkpoints.length - 1]
      if (lastCheckpoint) turn.checkpointId = lastCheckpoint.id
      if (outcome.note) turn.verificationNote = outcome.note
      history = await this.store.saveHistory(history)
      this.post({ type: 'history', history, usage: await this.usage(history, settings) })
      this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), language) })
    }
  }

  private async runApprovedCommand(turnIndex: number, commandId: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Confía en el workspace antes de ejecutar comandos.')
    if (this.commandRunning) throw new Error('Ya hay un comando ejecutándose.')
    let history = this.store.getHistory()
    const turn = history[turnIndex]
    const proposal = turn?.commandProposals?.find((item) => item.id === commandId)
    if (!turn || !proposal) throw new Error('El comando propuesto ya no está disponible.')

    turn.commandProposals = (turn.commandProposals || []).filter((item) => item.id !== commandId)
    history = await this.store.saveHistory(history)
    this.post({ type: 'history', history, usage: await this.usage(history) })
    this.post({ type: 'executionProgress', command: proposal.command })
    const run = await this.executeCommand(proposal)
    turn.runs = [...(turn.runs || []), run]
    history = await this.store.saveHistory(history)
    this.post({ type: 'history', history, usage: await this.usage(history) })
  }

  private async executeCommand(proposal: Parameters<typeof runCommand>[0], automatic = false): Promise<ExecutionRun> {
    if (this.commandRunning) throw new Error('Ya hay un comando ejecutándose.')
    this.commandRunning = true
    try {
      return await runCommand(proposal, automatic)
    } finally {
      this.commandRunning = false
    }
  }

  private async restoreCheckpoint(id: string) {
    const checkpoint = this.store.getCheckpoints().find((item) => item.id === id)
    if (!checkpoint) throw new Error('Checkpoint no encontrado.')
    const restored = await undoCheckpoint(checkpoint)
    await this.store.updateCheckpoint(restored)
    let history = this.store.getHistory()
    for (const turn of history) if (turn.checkpointId === id) turn.undone = restored.undone
    history = await this.store.saveHistory(history)
    const checkpointLanguage = (await this.store.getSettings()).language || 'es'
    this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), checkpointLanguage) })
    this.post({ type: 'history', history, usage: await this.usage(history) })
    if (restored.conflict) throw new Error(restored.conflict)
    await this.index.build()
  }

  private async appendAssistant(text: string, runs?: ExecutionRun[]) {
    let history = this.store.getHistory()
    history.push({ role: 'assistant', text, runs })
    history = await this.store.saveHistory(history)
    this.post({ type: 'history', history, usage: await this.usage(history) })
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce()
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'))
    const centycLogo = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'centyc-logo.png'))
    const csp = [
      `default-src 'none'`, `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`,
      `connect-src https: http://localhost:*`, `font-src ${webview.cspSource}`,
    ].join('; ')
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${style}" rel="stylesheet" /><title>QAPI</title></head><body>
<div id="root" data-centyc-logo="${centycLogo}"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}

const DOCUMENT_FILE_NAMES: Record<SpecDocumentKind, string> = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
}

/** Prompt de la fase siguiente del spec, con aprobación explícita del usuario. */
function specPhasePrompt(spec: SpecSummary, phase: SpecPhase, language: UiLanguage): string {
  const es = language !== 'en'
  const header = es
    ? `Trabaja en el spec “${spec.title}” (slug ${spec.slug}).`
    : `Work on the spec “${spec.title}” (slug ${spec.slug}).`
  const instructions: Record<SpecPhase, [string, string]> = {
    requirements: [
      'Redacta requirements.md con objetivo e historias con criterios de aceptación numerados y verificables. Usa create_spec_document con kind=requirements.',
      'Write requirements.md with an objective and user stories with numbered, verifiable acceptance criteria. Use create_spec_document with kind=requirements.',
    ],
    design: [
      'Lee los requisitos con read_spec y redacta design.md: arquitectura, componentes, contratos, flujos, riesgos y compatibilidad. Usa create_spec_document con kind=design.',
      'Read the requirements with read_spec and write design.md: architecture, components, contracts, flows, risks and compatibility. Use create_spec_document with kind=design.',
    ],
    tasks: [
      'Lee requisitos y diseño con read_spec y redacta tasks.md como checklist numerado con subtareas accionables. Usa create_spec_document con kind=tasks.',
      'Read requirements and design with read_spec and write tasks.md as a numbered checklist with actionable subtasks. Use create_spec_document with kind=tasks.',
    ],
    execution: [
      'Revisa tasks.md con read_spec y ejecuta la siguiente tarea pendiente, marcando su estado con update_task_status.',
      'Review tasks.md with read_spec and execute the next pending task, marking its status with update_task_status.',
    ],
    done: [
      'Verifica con read_spec que todas las tareas estén completadas y resume el resultado.',
      'Verify with read_spec that every task is completed and summarize the outcome.',
    ],
  }
  const [spanish, english] = instructions[phase]
  return `${header}\n\n${es ? spanish : english}`
}

function currentWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() || ''
}

function assertWorkspaceRoot(expected: string): void {
  if (currentWorkspaceRoot() !== expected) throw new Error('QAPI_WORKSPACE_CHANGED_DURING_REQUEST')
}

/** Une los archivos corregidos por el ciclo con las propuestas ya aplicadas. */
function mergeAppliedProposals(existing: FileProposal[], fixes: FileProposal[]): FileProposal[] {
  const byPath = new Map(existing.map((proposal) => [proposal.path, proposal]))
  for (const fix of fixes) byPath.set(fix.path, fix)
  return [...byPath.values()]
}

function localizeCheckpoints(checkpoints: Checkpoint[], language: UiLanguage): Checkpoint[] {
  if (language !== 'en') return checkpoints
  return checkpoints.map((checkpoint) => ({
    ...checkpoint,
    conflict: checkpoint.conflict ? localizeHostError(checkpoint.conflict, language) : undefined,
  }))
}

function localizeTraceability(summary: TraceabilitySummary, language: UiLanguage): TraceabilitySummary {
  if (language !== 'en') return summary
  const translate = (value: string) => value
    .replace('Evidencia estática inferida a partir de rutas y contenido indexado; no representa cobertura ni ejecución runtime.', 'Static evidence inferred from indexed paths and content; it does not represent runtime coverage or execution.')
    .replace(/^(\d+) archivo\(s\) Gherkin analizado\(s\), (\d+) definición\(es\) de step y (\d+) archivo\(s\) de prueba detectado\(s\)\.$/, '$1 Gherkin file(s) analyzed, $2 step definition(s), and $3 test file(s) detected.')
    .replace(/^(\d+) de (\d+) step\(s\) Gherkin enlazado\(s\) por coincidencia normalizada con una definición\.$/, '$1 of $2 Gherkin step(s) linked by normalized matching with a definition.')
    .replace(/^No se detectaron tags o IDs de requisito /, 'No requirement tags or IDs were detected ')
    .replace(/^Requisito (.+): /, 'Requirement $1: ')
    .replace(/^No se detectaron archivos \.feature con escenarios Gherkin\.$/, 'No .feature files with Gherkin scenarios were detected.')
    .replace(/^Los archivos \.feature detectados no contienen Scenario\/Escenario\.$/, 'The detected .feature files do not contain Scenario/Escenario.')
    .replace(/^Hay steps Gherkin, pero no se detectaron definiciones de steps\.$/, 'Gherkin steps exist, but no step definitions were detected.')
    .replace(/^Step sin definición normalizada: /, 'Step without a normalized definition: ')
    .replace(/^No se detectaron archivos de prueba por ruta, nombre o extensión\.$/, 'No test files were detected by path, name, or extension.')
    .replace(/^Prueba (.+): relación estática con /, 'Test $1: static relationship with ')
    .replace(/^Prueba detectada por ruta\/extensión: /, 'Test detected by path/extension: ')
    .replace(/^Requisito (.+) sin vínculo explícito a un archivo \.feature\.$/, 'Requirement $1 has no explicit link to a .feature file.')
  return { ...summary, gaps: summary.gaps.map(translate), evidence: summary.evidence.map(translate) }
}

function ui(language: UiLanguage, es: string, en: string): string {
  return language === 'en' ? en : es
}

function localizeHostError(message: string, language: UiLanguage): string {
  if (message === 'QAPI_WORKSPACE_CHANGED_DURING_REQUEST') {
    return ui(language,
      'El workspace cambió mientras QAPI procesaba la solicitud. Se descartó el resultado anterior.',
      'The workspace changed while QAPI was processing the request. The previous result was discarded.')
  }
  if (language !== 'en') return message
  const translations = new Map<string, string>([
    ['Corrige la configuración MCP antes de guardarla.', 'Fix the MCP configuration before saving it.'],
    ['Servidor MCP desconocido.', 'Unknown MCP server.'],
    ['Este cambio antiguo no tiene un checkpoint seguro para deshacer.', 'This older change has no safe checkpoint to undo.'],
    ['La propuesta ya no está disponible.', 'The proposal is no longer available.'],
    ['Confía en el workspace antes de ejecutar comandos.', 'Trust the workspace before running commands.'],
    ['Ya hay un comando ejecutándose.', 'A command is already running.'],
    ['El comando propuesto ya no está disponible.', 'The proposed command is no longer available.'],
    ['Checkpoint no encontrado.', 'Checkpoint not found.'],
    ['No hay carpeta de proyecto abierta', 'No project folder is open'],
    ['Proveedor no soportado', 'Unsupported provider'],
    ['El texto a reemplazar no puede estar vacío', 'The text to replace cannot be empty'],
    ['El texto original no coincide con el contenido actual', 'The original text does not match the current content'],
    ['Conflicto: hay ids de hunk seleccionados más de una vez', 'Conflict: some hunk IDs were selected more than once'],
    [
      'Checkpoint interrumpido: hay archivos con cambios externos; no se restauró automáticamente.',
      'Interrupted checkpoint: some files have external changes; it was not restored automatically.',
    ],
  ])
  return (translations.get(message) || message)
    .replace(/^Ollama no responde /, 'Ollama is not responding ')
    .replace(/^No se pudo validar /, 'Could not validate ')
    .replace(/^Error al validar /, 'Error validating ')
    .replace(/^Conflicto: hay más de una propuesta para (.+)$/, 'Conflict: there is more than one proposal for $1')
    .replace(/^Conflicto: el id de propuesta (.+) está duplicado$/, 'Conflict: proposal ID $1 is duplicated')
    .replace(/^Conflicto: el texto original aparece (\d+) veces; usa replaceAll para reemplazar todas$/, 'Conflict: the original text appears $1 times; use replaceAll to replace all occurrences')
    .replace(/^Conflicto: hay ids de hunk duplicados en (.+)$/, 'Conflict: there are duplicate hunk IDs in $1')
    .replace(/^Conflicto: hunk desconocido (.+) en (.+)$/, 'Conflict: unknown hunk $1 in $2')
    .replace(/^Conflicto: hunk desconocido (.+)$/, 'Conflict: unknown hunk $1')
    .replace(/^Conflicto: coordenadas inválidas en (.+)$/, 'Conflict: invalid coordinates in $1')
    .replace(/^Conflicto: los hunks seleccionados se superponen en (.+)$/, 'Conflict: selected hunks overlap at $1')
    .replace(/^Conflicto: (.+) está fuera del contenido base$/, 'Conflict: $1 is outside the base content')
    .replace(/^Conflicto: el contenido base no coincide con (.+)$/, 'Conflict: the base content does not match $1')
    .replace(/^Conflicto: la propuesta para (.+) no tiene id$/, 'Conflict: the proposal for $1 has no ID')
    .replace(/^Conflicto: propuesta duplicada (.+)$/, 'Conflict: duplicate proposal $1')
    .replace(/^Conflicto: selección duplicada para (.+)$/, 'Conflict: duplicate selection for $1')
    .replace(/^Conflicto: propuesta desconocida (.+)$/, 'Conflict: unknown proposal $1')
    .replace(/^Conflicto: hay hunks repetidos en (.+)$/, 'Conflict: there are repeated hunks in $1')
    .replace(/^Conflicto: (.+) cambió mientras se aplicaban las propuestas/, 'Conflict: $1 changed while the proposals were being applied')
    .replace(/^No se pudo confirmar el checkpoint: /, 'Could not commit the checkpoint: ')
    .replace(/^No se pudo recuperar el checkpoint interrumpido: /, 'Could not recover the interrupted checkpoint: ')
    .replace(/^Conflicto: archivo duplicado (.+)$/, 'Conflict: duplicate file $1')
    .replace(/^Conflicto: (.+) cambió después del checkpoint$/, 'Conflict: $1 changed after the checkpoint')
    .replace(/^Conflicto: (.+) cambió mientras se deshacía el checkpoint/, 'Conflict: $1 changed while the checkpoint was being undone')
    .replace(/^Conflicto: (.+) no tiene baseHash$/, 'Conflict: $1 has no baseHash')
    .replace(/^Conflicto: cambió la existencia de (.+)$/, 'Conflict: the existence of $1 changed')
    .replace(/^Conflicto: (.+) cambió desde que se creó la propuesta$/, 'Conflict: $1 changed since the proposal was created')
    .replace(/; rollback incompleto: /g, '; incomplete rollback: ')
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let index = 0; index < 32; index++) value += chars.charAt(Math.floor(Math.random() * chars.length))
  return value
}
