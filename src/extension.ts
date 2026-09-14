import * as vscode from 'vscode'
import { Store } from './store'
import { ProjectIndex } from './projectIndex'
import { QaPiViewProvider } from './panel'
import { registerHooks } from './hooks'

export function activate(ctx: vscode.ExtensionContext) {
  const store = new Store(ctx)
  const index = new ProjectIndex()
  const provider = new QaPiViewProvider(ctx, store, index)
  let primaryRoot = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || ''

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QaPiViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Índice del proyecto: construir al arrancar y mantener al día.
  const onStatus = (indexing: boolean, files: number) =>
    provider.post({ type: 'indexStatus', indexing, files })
  void index.build(onStatus)
  ctx.subscriptions.push(
    index.watch(onStatus, (paths) => { void store.invalidateInvestigationMemory(paths) }),
    index,
  )

  // Hooks del proyecto: opt-in mediante .qapi/hooks/*.json.
  ctx.subscriptions.push(registerHooks({
    isBusy: () => provider.isBusy(),
    runAgentPrompt: (prompt) => provider.runHookPrompt(prompt),
    runCommand: (command, reason) => provider.runHookCommand(command, reason),
    onSkipped: (hook, reason) => provider.post({
      type: 'toolProgress',
      tool: `hook:${hook.name}`,
      detail: reason === 'busy' ? 'omitido: QAPI está ocupado' : 'omitido: el workspace no es confiable',
    }),
  }))

  // Reindexar cuando cambian las carpetas del workspace (proyecto por proyecto).
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const nextPrimaryRoot = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || ''
      const primaryRootChanged = nextPrimaryRoot !== primaryRoot
      primaryRoot = nextPrimaryRoot
      if (primaryRootChanged) {
        await store.clearHistory()
        await store.clearMemory()
        await store.clearInvestigationMemory()
        await store.clearCheckpoints()
        provider.post({ type: 'history', history: [] })
        provider.post({ type: 'memory', text: '' })
        provider.post({ type: 'checkpoints', checkpoints: [] })
      }
      provider.post({ type: 'project', projectName: index.projectName })
      await index.build(onStatus)
    }),
  )

  ctx.subscriptions.push(
    vscode.commands.registerCommand('qa-pi.openChat', () => {
      void vscode.commands.executeCommand('qa-pi.chat.focus')
    }),
    vscode.commands.registerCommand('qa-pi.openSettings', () => {
      void vscode.commands.executeCommand('qa-pi.chat.focus')
      provider.post({ type: 'openSettings' })
    }),
    vscode.commands.registerCommand('qa-pi.reindex', () => index.build(onStatus)),
    vscode.commands.registerCommand('qa-pi.clearChat', () => provider.clearChat()),
    vscode.commands.registerCommand('qa-pi.clearInvestigationMemory', async () => {
      await store.clearInvestigationMemory()
      const language = (await store.getSettings()).language || 'es'
      void vscode.window.showInformationMessage(language === 'en'
        ? 'QAPI automatic memory cleared.'
        : 'Memoria automática de QAPI eliminada.')
    }),
  )
}

export function deactivate() {}
