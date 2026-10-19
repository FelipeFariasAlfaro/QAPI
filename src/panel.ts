// Frontera VS Code/webview: coordina contexto, agente, cambios, ejecución y estado.
import { randomBytes, randomUUID } from 'crypto'
import * as vscode from 'vscode'
import { Store, toPublicSettings } from './store'
import { ProjectIndex } from './projectIndex'
import { CANCELLED_ERROR, isCancellation, validateProvider } from './providers'
import { ask, compactHistory } from './agent'
import { resolveContextRefs, suggestContextRefs } from './contextRefs'
import { computeUsage } from './contextWindow'
import { parseMcpConfig, validateMcpConfig } from './mcp'
import { probeMcpServer } from './mcpRuntime'
import { applyProposalSelections, reconcileCheckpoint, undoCheckpoint } from './changes'
import { analyzeTestImpact, captureIdeContext, discoverArtifacts, readArtifact } from './ideContext'
import {
  buildVerificationCommand, createCommandProposal, formatRun, runCommand, suggestVerificationCommand,
} from './execution'
import { skippedVerificationNote, verifyAndFix } from './verification'
import { buildTraceability } from './traceability'
import { loadSteeringRules, selectSteering } from './steering'
import {
  appliesToProject, deleteSkill, listSkills, saveSkill, selectSkills, setSkillEnabled, SKILL_TEMPLATES, skillUri,
  slugifySkillName,
} from './skills'
import { redactSecrets } from './secretVault'
import { buildTaskContext, listSpecs, readSpec, slugifySpecName, updateTaskStatus } from './specs'
import type { MemoryService } from './memory/service'
import type { HolographicMemory } from './memory/memory'
import {
  buildRunInstruction, deleteCustomAgent, listCustomAgents, matchAgentFiles, saveCustomAgent, slugifyAgentName,
} from './customAgents'
import {
  AgentMode, ChatTurn, Checkpoint, ExecutionRun, FileProposal, Settings, SpecDocumentKind, SpecPhase, SpecSummary,
  SkillEvent, ToHost, TraceabilitySummary, UiLanguage,
} from './types'

export class QaPiViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'qa-pi.chat'
  private view?: vscode.WebviewView
  private initializedViews = new WeakSet<vscode.WebviewView>()
  private initializations = new WeakMap<vscode.WebviewView, Promise<void>>()
  private busy = false
  private commandRunning = false
  private applying = false
  /** Cancelación de la petición al agente en curso. */
  private activeRequest?: AbortController
  /** Cancelación del comando aprobado en curso. */
  private activeCommand?: AbortController
  /** Cambia con "Nueva": una respuesta tardía de la conversación anterior se descarta. */
  private chatEpoch = 0

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly index: ProjectIndex,
    private readonly memoryService?: MemoryService,
  ) {}

  reveal() { this.view?.show?.(true) }
  post(message: unknown) { void this.view?.webview.postMessage(message) }
  isBusy(): boolean { return this.busy || this.commandRunning || this.applying }

  /** Detiene la petición y el comando en curso (botón Detener, "Nueva", cambio de workspace). */
  cancelActiveRequest(): void {
    this.activeRequest?.abort()
    this.activeCommand?.abort()
  }

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
    const history = await this.store.mutateHistory((turns) => {
      turns.push({
        role: 'assistant',
        text: ui(language,
          `Un hook del proyecto propone ejecutar un comando: ${reason}`,
          `A project hook proposes running a command: ${reason}`),
        commandProposals: [createCommandProposal(command, reason)],
      })
    })
    this.post({ type: 'history', history, usage: await this.usage(history, settings) })
  }

  private async usage(history: ChatTurn[], settings?: Settings) {
    const current = settings || await this.store.getSettings()
    return computeUsage(history, current.provider.provider, current.provider.model, current.provider.contextLimit)
  }

  private async postSkills() {
    const profile = this.index.profile
    this.post({
      type: 'skills',
      skills: await listSkills(),
      templates: SKILL_TEMPLATES,
      detected: profile ? [...new Set([...profile.testFrameworks, ...profile.languages])] : [],
      trusted: vscode.workspace.isTrusted,
    })
  }

  private async postSettings(settings?: Settings) {
    this.post({ type: 'settings', settings: settings ? toPublicSettings(settings) : await this.store.getPublicSettings() })
  }

  private postMemoryStats() {
    if (!this.memoryService) return
    const notes = this.memoryService.notes().map((note) => ({
      id: note.id, text: note.text, sources: note.sources.map((item) => ({ path: item.path })),
      stale: note.stale, origin: note.origin, createdAt: note.createdAt,
    }))
    this.post({ type: 'memoryStats', stats: this.memoryService.stats(), notes })
  }

  /** Agentes disponibles con su estado de activación en este proyecto. */
  private async agentsForWebview() {
    const disabled = new Set(this.store.getDisabledAgents())
    return (await listCustomAgents()).map((agent) => ({ ...agent, enabled: !disabled.has(agent.slug) }))
  }

  async clearChat() {
    this.chatEpoch++
    this.cancelActiveRequest()
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
      disposeSubscription.dispose()
      if (this.view === view) this.view = undefined
    })
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
      type: 'init', settings: toPublicSettings(settings), history, projectName: this.index.projectName,
      usage, memory: this.store.getMemory(), checkpoints,
    })
    await view.webview.postMessage({ type: 'indexStatus', indexing: this.index.indexing, files: this.index.fileCount })
    await view.webview.postMessage({ type: 'specs', specs: await listSpecs() })
    await view.webview.postMessage({ type: 'customAgents', agents: await this.agentsForWebview() })
    await this.postSkills()

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
          await this.postSettings()
          break
        case 'saveSettings': {
          // MCP sólo se cambia por saveMcpJson/toggleMcp, que validan la configuración.
          const { mcpJson: _json, mcpEnabled: _enabled, ...patch } = message.settings || {}
          const settings = await this.store.saveSettings(patch)
          await this.postSettings(settings)
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
          const result = await validateProvider(await this.store.withStoredKey(message.provider))
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
          // Sólo bloquean el guardado los errores de estructura. Un ejecutable que
          // aún no está instalado no impide guardar: ese servidor simplemente no
          // se puede activar hasta que la validación lo encuentre.
          const structure = parseMcpConfig(message.json)
          if (structure.error || structure.issues.length) {
            throw new Error(structure.error || 'Corrige la configuración MCP antes de guardarla.')
          }
          const valid = new Set(validation.servers.map((server) => server.name))
          const settings = await this.store.saveMcpConfig(message.json, valid)
          await this.postSettings(settings)
          break
        }
        case 'suggestVerificationCommand':
          this.post({ type: 'verificationSuggestion', command: suggestVerificationCommand(this.index.profile) })
          break
        case 'listModels': {
          // Selector de modelo del chat: usa la key guardada, que nunca llega a la webview.
          const settings = await this.store.getSettings()
          const result = settings.configured
            ? await validateProvider(settings.provider)
            : { ok: false, models: [] as string[], limits: undefined, message: undefined }
          this.post({
            type: 'models', provider: settings.provider.provider,
            models: result.ok ? result.models : [], limits: result.limits,
            message: result.ok ? undefined : result.message,
          })
          break
        }
        case 'probeMcp': {
          const settings = await this.store.getSettings()
          const language = settings.language || 'es'
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          const known = parseMcpConfig(settings.mcpJson).servers.some((server) => server.name === message.name)
          if (!known) {
            this.post({
              type: 'mcpProbe', name: message.name, ok: false, tools: [], durationMs: 0,
              message: ui(language, 'Guarda la configuración antes de probar este servidor.', 'Save the configuration before testing this server.'),
            })
            break
          }
          if (!root) throw new Error(ui(language, 'No hay carpeta de proyecto abierta', 'No project folder is open'))
          const result = await probeMcpServer(settings.mcpJson, message.name, root)
          this.post({ type: 'mcpProbe', name: message.name, ...result })
          break
        }
        case 'toggleMcp': {
          const settings = await this.store.getSettings()
          const parsed = parseMcpConfig(settings.mcpJson)
          if (!parsed.servers.some((server) => server.name === message.name)) throw new Error('Servidor MCP desconocido.')
          await this.postSettings(await this.store.setMcpEnabled(message.name, message.enabled))
          break
        }
        case 'reindex':
          await this.index.build((indexing, files) => this.post({ type: 'indexStatus', indexing, files }))
          break
        case 'clearChat':
          await this.clearChat()
          break
        case 'cancel':
          this.cancelActiveRequest()
          break
        case 'sendMessage':
          await this.onSend(message.text, message.mode || 'chat')
          break
        case 'applyProposals':
          await this.applySelections(message.turnId, message.turnIndex, message.selections)
          break
        case 'runCommand':
          await this.runApprovedCommand(message.turnId, message.turnIndex, message.commandId)
          break
        case 'undoCheckpoint':
          await this.restoreCheckpoint(message.checkpointId)
          break
        case 'undoProposals': {
          const history = this.store.getHistory()
          const turn = history[findTurnIndex(history, message.turnId, message.turnIndex)]
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
          ), 'chat', { events: ['testResult'] })
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
          const file = DOCUMENT_FILE_NAMES[message.kind]
          if (!file) throw new Error(ui(language, 'Documento de spec desconocido.', 'Unknown spec document.'))
          const uri = vscode.Uri.joinPath(root, '.qapi', 'specs', slugifySpecName(message.slug), file)
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false })
          break
        }
        case 'runSpecTask': {
          const language = (await this.store.getSettings()).language || 'es'
          if (this.busy) throw new Error(ui(language, 'QAPI ya está procesando otra tarea.', 'QAPI is already processing another task.'))
          const context = await buildTaskContext(message.slug, message.taskId)
          if (!context) throw new Error(ui(language, 'La tarea del spec ya no está disponible.', 'The spec task is no longer available.'))
          await updateTaskStatus(message.slug, message.taskId, 'in-progress')
          this.post({ type: 'specs', specs: await listSpecs() })
          const completed = await this.onSend(ui(language,
            `Implementa la tarea asignada del spec y marca su estado al terminar con update_task_status.\n\n${context}`,
            `Implement the assigned spec task and mark its status with update_task_status when done.\n\n${context}`,
          ), 'chat')
          // Si la petición no llegó a completarse, la tarea no queda "en progreso" para siempre.
          if (!completed) await updateTaskStatus(message.slug, message.taskId, 'pending').catch(() => undefined)
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
        case 'refreshSkills':
          await this.postSkills()
          break
        case 'saveSkill':
          if (!vscode.workspace.isTrusted) throw new Error(ui((await this.store.getSettings()).language || 'es', 'Confía en el workspace para usar skills.', 'Trust the workspace to use skills.'))
          await saveSkill(message.skill, message.previousSlug)
          await this.postSkills()
          break
        case 'deleteSkill':
          await deleteSkill(message.slug)
          await this.postSkills()
          break
        case 'toggleSkill':
          await setSkillEnabled(message.slug, message.enabled)
          await this.postSkills()
          break
        case 'openSkillFile': {
          const uri = skillUri(message.slug)
          if (uri) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false })
          break
        }
        case 'refreshCustomAgents':
          this.post({ type: 'customAgents', agents: await this.agentsForWebview() })
          break
        case 'suggestAgentFiles':
          this.post({ type: 'agentFileSuggestions', files: matchAgentFiles(this.index, message.glob) })
          break
        case 'saveCustomAgent': {
          const saved = await saveCustomAgent(message.agent, message.previousSlug)
          // Si el agente cambió de nombre (y de slug), conserva su estado de activación.
          if (message.previousSlug) await this.store.renameDisabledAgent(slugifyAgentName(message.previousSlug), saved.slug)
          this.post({ type: 'customAgents', agents: await this.agentsForWebview() })
          break
        }
        case 'deleteCustomAgent': {
          await deleteCustomAgent(message.slug)
          await this.store.setAgentEnabled(message.slug, true)
          this.post({ type: 'customAgents', agents: await this.agentsForWebview() })
          break
        }
        case 'getMemoryStats':
          this.postMemoryStats()
          break
        case 'forgetMemoryNote':
          this.memoryService?.forgetNote(message.id)
          this.postMemoryStats()
          break
        case 'rebuildMemory': {
          if (!this.memoryService) break
          await this.memoryService.rebuild(this.index)
          this.memoryService.persistSoon()
          this.postMemoryStats()
          const language = (await this.store.getSettings()).language || 'es'
          this.post({ type: 'notice', message: ui(language, 'Memoria holográfica reconstruida.', 'Holographic memory rebuilt.') })
          break
        }
        case 'toggleCustomAgent': {
          const language = (await this.store.getSettings()).language || 'es'
          const known = (await listCustomAgents()).some((item) => item.slug === message.slug)
          if (!known) throw new Error(ui(language, 'El agente ya no está disponible.', 'The agent is no longer available.'))
          await this.store.setAgentEnabled(message.slug, message.enabled === true)
          this.post({ type: 'customAgents', agents: await this.agentsForWebview() })
          break
        }
        case 'runCustomAgent': {
          const language = (await this.store.getSettings()).language || 'es'
          const agents = await listCustomAgents()
          const agent = agents.find((item) => item.slug === message.slug)
          if (!agent) throw new Error(ui(language, 'El agente ya no está disponible.', 'The agent is no longer available.'))
          // La interfaz ya oculta "Ejecutar", pero el host es quien decide (estado desactualizado, otra ventana).
          if (this.store.getDisabledAgents().includes(agent.slug)) {
            throw new Error(ui(language, 'El agente está desactivado. Actívalo para ejecutarlo.', 'The agent is disabled. Enable it to run it.'))
          }
          const instruction = await buildRunInstruction(agent, this.index, message.files, message.freeText)
          await this.onSend(instruction, 'chat')
          break
        }
      }
    } catch (error: any) {
      const language = (await this.store.getSettings()).language || 'es'
      this.post({ type: 'error', message: localizeHostError(String(error?.message || error), language) })
    }
  }

  /**
   * Envía una instrucción al agente. Devuelve true si el turno se completó.
   * Siempre termina con `assistantEnd` si la petición llegó a empezar, para que
   * la webview apague el indicador aunque haya fallado o se haya cancelado.
   */
  private async onSend(text: string, mode: AgentMode, options: { events?: SkillEvent[] } = {}): Promise<boolean> {
    const settings = await this.store.getSettings()
    const language = settings.language || 'es'
    if (this.busy) {
      // Otra petición sigue viva: es un aviso, no debe apagar su indicador.
      this.post({ type: 'notice', message: ui(language, 'QAPI ya está procesando otra tarea.', 'QAPI is already processing another task.') })
      return false
    }
    if (!settings.language) {
      this.post({ type: 'assistantEnd' })
      throw new Error('Selecciona un idioma antes de chatear. / Select a language before chatting.')
    }
    if (!settings.configured || !settings.provider.model) {
      this.post({ type: 'assistantEnd' })
      throw new Error(ui(language, 'Configura un proveedor y modelo antes de chatear.', 'Configure a provider and model before chatting.'))
    }
    this.busy = true
    const controller = new AbortController()
    this.activeRequest = controller
    const signal = controller.signal
    const epoch = this.chatEpoch
    const requestRoot = currentWorkspaceRoot()
    const stillCurrent = () => epoch === this.chatEpoch && currentWorkspaceRoot() === requestRoot && !signal.aborted
    let userTurnId: string | undefined
    let completed = false

    try {
      let history = this.store.getHistory()
      const pre = computeUsage(history, settings.provider.provider, settings.provider.model, settings.provider.contextLimit)
      if (pre.needsSummary && history.length > 0) {
        this.post({ type: 'toolProgress', tool: 'memoria', detail: ui(language, 'resumiendo la conversación', 'summarizing the conversation') })
        try {
          const compacted = await compactHistory(settings, history, language, signal)
          if (compacted && stillCurrent()) {
            history = await this.store.mutateHistory(() => compacted)
            this.post({ type: 'history', history, usage: await this.usage(history, settings) })
            this.post({ type: 'summarized', usage: await this.usage(history, settings) })
          }
        } catch (error) {
          if (isCancellation(error) || signal.aborted) throw new Error(CANCELLED_ERROR)
          /* el chat sigue sin compactar si el proveedor falla */
        }
      }

      userTurnId = randomUUID()
      history = await this.store.mutateHistory((turns) => { turns.push({ id: userTurnId, role: 'user', text, mode }) })
      assertWorkspaceRoot(requestRoot)
      this.post({ type: 'history', history, usage: await this.usage(history, settings) })
      this.post({ type: 'assistantStart' })

      const context = await captureIdeContext()
      assertWorkspaceRoot(requestRoot)
      const explicitContext = await resolveContextRefs(text, this.index, context)
      const steering = await selectSteering(await loadSteeringRules(), context, explicitContext.steeringNames)
      const availableSkills = await listSkills()
      const skills = selectSkills(availableSkills, {
        ideContext: context,
        manualNames: explicitContext.skillNames,
        profile: this.index.profile,
        events: options.events,
      })
      const knownSkills = new Set(availableSkills.flatMap((skill) => [skill.slug, slugifySkillName(skill.name)]))
      const unknownSkills = explicitContext.skillNames.filter((name) => !knownSkills.has(slugifySkillName(name)))
      if (unknownSkills.length) {
        this.post({ type: 'notice', message: ui(language,
          `Skill no encontrada: ${unknownSkills.join(', ')}`,
          `Skill not found: ${unknownSkills.join(', ')}`) })
      }
      if (explicitContext.missing.length) {
        this.post({
          type: 'notice',
          message: ui(language,
            `No pude resolver: ${explicitContext.missing.join(', ')}`,
            `Could not resolve: ${explicitContext.missing.join(', ')}`),
        })
      }
      const investigationMemory = this.store.getInvestigationMemory()
      let holoMemory: HolographicMemory | undefined
      if (settings.holographicMemory !== false && this.memoryService) {
        if (!this.memoryService.isBuilt) this.post({ type: 'toolProgress', tool: 'memoria', detail: ui(language, 'construyendo la memoria holográfica', 'building the holographic memory') })
        try {
          holoMemory = await this.memoryService.ready(this.index)
        } catch (error) {
          // Si la memoria falla, el turno sigue con el contexto clásico.
          console.error('QAPI: memoria holográfica no disponible', error)
        }
      }
      assertWorkspaceRoot(requestRoot)
      let turn: ChatTurn
      try {
        turn = await ask(
          settings, text, history, this.index, context, this.store.getMemory(), mode,
          (tool, detail) => {
            if (stillCurrent()) this.post({ type: 'toolProgress', tool, detail })
          },
          investigationMemory,
          (server, tool) => this.approveMcpCall(server, tool, language),
          steering,
          explicitContext,
          (chunk) => {
            if (stillCurrent()) this.post({ type: 'assistantChunk', text: chunk })
          },
          signal,
          skills,
          holoMemory,
        )
      } finally {
        await this.store.saveInvestigationMemory(investigationMemory)
        if (holoMemory) {
          this.memoryService?.persistSoon()
          this.postMemoryStats()
        }
      }
      if (signal.aborted) throw new Error(CANCELLED_ERROR)
      assertWorkspaceRoot(requestRoot)
      // "Nueva" durante la respuesta: el resultado pertenece a una conversación ya borrada.
      if (epoch !== this.chatEpoch) return false
      turn.id = randomUUID()
      history = await this.store.mutateHistory((turns) => { turns.push(turn) })
      const usage = await this.usage(history, settings)
      this.post({ type: 'assistantDone', turn, usage })
      this.post({ type: 'history', history, usage })
      if (turn.specTouched) this.post({ type: 'specs', specs: await listSpecs() })
      completed = true
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'QAPI_WORKSPACE_CHANGED_DURING_REQUEST' || currentWorkspaceRoot() !== requestRoot) {
        await this.store.clearHistory()
        this.post({ type: 'history', history: [], usage: await this.usage([], settings) })
        this.post({ type: 'error', message: localizeHostError('QAPI_WORKSPACE_CHANGED_DURING_REQUEST', language) })
        return false
      }
      if (epoch !== this.chatEpoch) return false
      const cancelled = isCancellation(error) || signal.aborted
      if (cancelled) {
        // Se conserva la pregunta y se deja constancia de la detención, para mantener la alternancia.
        const history = await this.store.mutateHistory((turns) => {
          turns.push({ role: 'assistant', text: ui(language, '_Solicitud detenida._', '_Request stopped._') })
        })
        this.post({ type: 'history', history, usage: await this.usage(history, settings) })
        return false
      }
      // Error real: se quita la pregunta huérfana y se devuelve al compositor para reintentar.
      if (userTurnId) {
        const history = await this.store.mutateHistory((turns) => turns.filter((item) => item.id !== userTurnId))
        this.post({ type: 'history', history, usage: await this.usage(history, settings) })
        this.post({ type: 'restoreDraft', text })
      }
      this.post({ type: 'error', message: localizeHostError(message, language) })
      return false
    } finally {
      this.busy = false
      if (this.activeRequest === controller) this.activeRequest = undefined
      this.post({ type: 'assistantEnd', cancelled: !completed && signal.aborted })
    }
  }

  private async approveMcpCall(server: string, tool: string, language: UiLanguage): Promise<boolean> {
    // Se lee en cada llamada: activar el switch a mitad de una respuesta aplica de inmediato.
    if ((await this.store.getSettings()).mcpAutoApprove) {
      this.post({ type: 'toolProgress', tool: `mcp:${server}`, detail: ui(language, `${tool} (aprobado automáticamente)`, `${tool} (auto-approved)`) })
      return true
    }
    const approve = ui(language, 'Permitir una vez', 'Allow once')
    const always = ui(language, 'Permitir siempre', 'Always allow')
    const choice = await vscode.window.showWarningMessage(
      ui(language,
        `El servidor MCP “${server}” solicita ejecutar “${tool}”. Las tools MCP son externas y pueden leer o modificar datos.`,
        `MCP server “${server}” requests permission to run “${tool}”. MCP tools are external and may read or modify data.`),
      {
        modal: true,
        detail: ui(language,
          '“Permitir siempre” activa la autoaprobación MCP; puedes desactivarla con el switch del chat.',
          '“Always allow” turns on MCP auto-approval; you can turn it off with the switch in the chat.'),
      },
      approve,
      always,
    )
    if (choice === always) {
      await this.postSettings(await this.store.saveSettings({ mcpAutoApprove: true }))
      return true
    }
    return choice === approve
  }

  private async applySelections(
    turnId: string | undefined,
    turnIndex: number,
    selections: { proposalId: string; hunkIds: string[] }[],
  ) {
    if (this.applying) throw new Error('Ya se están aplicando cambios.')
    this.applying = true
    try {
      const snapshot = this.store.getHistory()
      const position = findTurnIndex(snapshot, turnId, turnIndex)
      const turn = snapshot[position]
      if (!turn?.proposals?.length) throw new Error('La propuesta ya no está disponible.')
      if (turn.applied && !turn.undone) throw new Error('Estos cambios ya se aplicaron.')
      const id = turn.id
      const applyLanguage = (await this.store.getSettings()).language || 'es'
      const result = await applyProposalSelections(
        turn.proposals,
        selections,
        turn.text.slice(0, 100) || 'Cambios QAPI',
        async (checkpoint) => { await this.store.saveCheckpoint(checkpoint) },
      )
      let history = await this.store.mutateHistory((turns) => {
        const target = turns.find((item) => id ? item.id === id : item === turns[position])
        if (!target) return
        target.applied = true
        target.undone = false
        target.proposals = result.applied
        target.checkpointId = result.checkpoint.id
        target.verificationNote = applyVerificationNote(result.applied.length, result.unverified, applyLanguage)
      })
      this.post({ type: 'history', history, usage: await this.usage(history) })
      if (result.unverified.length) {
        this.post({ type: 'notice', message: ui(applyLanguage,
          `Algunos archivos no quedaron como se esperaba: ${result.unverified.join('; ')}`,
          `Some files did not end up as expected: ${result.unverified.join('; ')}`) })
      }
      const checkpointLanguage = applyLanguage
      this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), checkpointLanguage) })
      await this.index.build((indexing, files) => this.post({ type: 'indexStatus', indexing, files }))

      const settings = await this.store.getSettings()
      const language = settings.language || 'es'
      const changedFiles = result.applied.map((proposal) => proposal.path)

      // Modo "proponer": se deja el comando listo con su botón Ejecutar; no corre solo.
      if (settings.verification === 'propose') {
        const built = buildVerificationCommand(settings.verificationCommand, changedFiles)
        history = await this.store.mutateHistory((turns) => {
          const target = turns.find((item) => id ? item.id === id : item === turns[position])
          if (!target) return
          if (built.ok) {
            const proposal = createCommandProposal(built.command, ui(language, 'Verificar los cambios aplicados', 'Verify the applied changes'))
            target.commandProposals = [...(target.commandProposals || []), proposal]
          } else {
            target.verificationNote = [target.verificationNote, skippedVerificationNote(built, language)].filter(Boolean).join('\n')
          }
        })
        this.post({ type: 'history', history, usage: await this.usage(history, settings) })
        return
      }

      let outcome: Awaited<ReturnType<typeof verifyAndFix>>
      try {
        outcome = await verifyAndFix({
          mode: settings.verification,
          provider: settings.provider,
          command: settings.verificationCommand,
          changedFiles,
          index: this.index,
          language,
          trusted: vscode.workspace.isTrusted,
          onRun: (command) => this.post({ type: 'executionProgress', command, automatic: true }),
          runCommandExclusive: (proposal) => this.executeCommand(proposal, true),
          persistCheckpoint: async (checkpoint) => { await this.store.saveCheckpoint(checkpoint) },
        })
      } catch (error: any) {
        // Los cambios ya se aplicaron: un fallo de la validación no debe presentarse como fallo del apply.
        outcome = {
          runs: [], appliedFixes: [], checkpoints: [],
          note: ui(language,
            `Validación omitida: ${String(error?.message || error)}`,
            `Validation skipped: ${String(error?.message || error)}`),
        } as unknown as Awaited<ReturnType<typeof verifyAndFix>>
      }

      if (outcome.runs.length || outcome.appliedFixes.length || outcome.note) {
        history = await this.store.mutateHistory((turns) => {
          const target = turns.find((item) => id ? item.id === id : item === turns[position])
          if (!target) return
          target.runs = [...(target.runs || []), ...outcome.runs]
          if (outcome.appliedFixes.length) {
            target.proposals = mergeAppliedProposals(target.proposals || [], outcome.appliedFixes)
          }
          const lastCheckpoint = outcome.checkpoints[outcome.checkpoints.length - 1]
          if (lastCheckpoint) target.checkpointId = lastCheckpoint.id
          if (outcome.note) target.verificationNote = [target.verificationNote, outcome.note].filter(Boolean).join('\n')
        })
        this.post({ type: 'history', history, usage: await this.usage(history, settings) })
        this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), language) })
      }
    } finally {
      this.applying = false
    }
  }

  private async runApprovedCommand(turnId: string | undefined, turnIndex: number, commandId: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Confía en el workspace antes de ejecutar comandos.')
    if (this.commandRunning) throw new Error('Ya hay un comando ejecutándose.')
    const snapshot = this.store.getHistory()
    const position = findTurnIndex(snapshot, turnId, turnIndex)
    const turn = snapshot[position]
    const proposal = turn?.commandProposals?.find((item) => item.id === commandId)
    if (!turn || !proposal) throw new Error('El comando propuesto ya no está disponible.')
    const id = turn.id
    const locate = (turns: ChatTurn[]) => turns.find((item) => id ? item.id === id : item === turns[position])

    let history = await this.store.mutateHistory((turns) => {
      const target = locate(turns)
      if (target) target.commandProposals = (target.commandProposals || []).filter((item) => item.id !== commandId)
    })
    this.post({ type: 'history', history, usage: await this.usage(history) })
    this.post({ type: 'executionProgress', command: proposal.command })
    const run = await this.executeCommand(proposal)
    history = await this.store.mutateHistory((turns) => {
      const target = locate(turns)
      if (target) target.runs = [...(target.runs || []), run]
    })
    this.post({ type: 'history', history, usage: await this.usage(history) })
    await this.runTestResultSkills(run)
  }

  /**
   * Evento testResult: si el comando falló y hay skills activas para ese evento,
   * se abre un turno de análisis con ellas. Sólo con fallos (un éxito no
   * necesita análisis) y nunca si el usuario canceló.
   */
  private async runTestResultSkills(run: ExecutionRun) {
    if ((run.status !== 'failed' && run.status !== 'timeout') || /\[cancelado por el usuario\]\s*$/.test(run.output)) return
    if (this.busy) return
    const settings = await this.store.getSettings()
    if (!settings.configured || !settings.provider.model) return
    const matching = (await listSkills()).filter((skill) =>
      skill.enabled && skill.activation === 'event' && skill.events?.includes('testResult')
      && appliesToProject(skill, this.index.profile))
    if (!matching.length) return
    const language = settings.language || 'es'
    const names = matching.map((skill) => skill.name).join(', ')
    await this.onSend(ui(language,
      `Analiza el resultado de prueba del comando que acabo de ejecutar (skills: ${names}).\n\n${redactSecrets(formatRun(run)).slice(-30_000)}`,
      `Analyze the test result of the command I just ran (skills: ${names}).\n\n${redactSecrets(formatRun(run)).slice(-30_000)}`,
    ), 'chat', { events: ['testResult'] })
  }

  private async executeCommand(proposal: Parameters<typeof runCommand>[0], automatic = false): Promise<ExecutionRun> {
    if (this.commandRunning) throw new Error('Ya hay un comando ejecutándose.')
    this.commandRunning = true
    const controller = new AbortController()
    this.activeCommand = controller
    try {
      return await runCommand(proposal, automatic, controller.signal)
    } finally {
      this.commandRunning = false
      if (this.activeCommand === controller) this.activeCommand = undefined
    }
  }

  private async restoreCheckpoint(id: string) {
    const checkpoint = this.store.getCheckpoints().find((item) => item.id === id)
    if (!checkpoint) throw new Error('Checkpoint no encontrado.')
    const restored = await undoCheckpoint(checkpoint)
    await this.store.updateCheckpoint(restored)
    const history = await this.store.mutateHistory((turns) => {
      for (const turn of turns) if (turn.checkpointId === id) turn.undone = restored.undone
    })
    const checkpointLanguage = (await this.store.getSettings()).language || 'es'
    this.post({ type: 'checkpoints', checkpoints: localizeCheckpoints(this.store.getCheckpoints(), checkpointLanguage) })
    this.post({ type: 'history', history, usage: await this.usage(history) })
    if (restored.conflict) throw new Error(restored.conflict)
    await this.index.build()
  }

  private async appendAssistant(text: string, runs?: ExecutionRun[]) {
    const history = await this.store.mutateHistory((turns) => { turns.push({ role: 'assistant', text, runs }) })
    this.post({ type: 'history', history, usage: await this.usage(history) })
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce()
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'))
    const centycLogo = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'centyc-logo.png'))
    // La webview no hace peticiones de red: connect-src queda en 'none' (default-src).
    const csp = [
      `default-src 'none'`, `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${style}" rel="stylesheet" /><title>QAPI</title></head><body>
<div id="root" data-centyc-logo="${centycLogo}"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}

/** Resultado de comprobar en disco los archivos recién aplicados. */
function applyVerificationNote(total: number, unverified: string[], language: UiLanguage): string {
  if (!unverified.length) {
    return ui(language,
      `✓ Verificado en disco: ${total} archivo(s) escrito(s) con el contenido aplicado.`,
      `✓ Verified on disk: ${total} file(s) written with the applied content.`)
  }
  return ui(language,
    `⚠ Verificación en disco: ${unverified.join('; ')}.`,
    `⚠ Disk verification: ${unverified.join('; ')}.`)
}

/** Resuelve un turno por id estable; el índice sólo se usa con historiales antiguos sin id. */
function findTurnIndex(history: ChatTurn[], turnId: string | undefined, turnIndex: number): number {
  if (turnId) return history.findIndex((turn) => turn.id === turnId)
  return turnIndex
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
  if (language !== 'en') return message.replace(/^El proveedor no respondió en (\d+) s\.$/, 'El proveedor no respondió en $1 s. Puedes reintentar o usar un modelo más rápido.')
  if (/^El proveedor no respondió en (\d+) s\.$/.test(message)) {
    return message.replace(/^El proveedor no respondió en (\d+) s\.$/, 'The provider did not respond within $1 s. You can retry or use a faster model.')
  }
  const translations = new Map<string, string>([
    ['Corrige la configuración MCP antes de guardarla.', 'Fix the MCP configuration before saving it.'],
    ['Servidor MCP desconocido.', 'Unknown MCP server.'],
    ['Este cambio antiguo no tiene un checkpoint seguro para deshacer.', 'This older change has no safe checkpoint to undo.'],
    ['La propuesta ya no está disponible.', 'The proposal is no longer available.'],
    ['Confía en el workspace antes de ejecutar comandos.', 'Trust the workspace before running commands.'],
    ['Ya hay un comando ejecutándose.', 'A command is already running.'],
    ['El comando propuesto ya no está disponible.', 'The proposed command is no longer available.'],
    ['Checkpoint no encontrado.', 'Checkpoint not found.'],
    ['Ya se están aplicando cambios.', 'Changes are already being applied.'],
    ['Estos cambios ya se aplicaron.', 'These changes were already applied.'],
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
  return randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '')
}
