// Hooks por evento: automatizan trabajo de QA ante cambios del editor.
//
// Se declaran en `.qapi/hooks/*.json` y son opt-in: sin archivos no ocurre nada.
// Un hook nunca se ejecuta en un workspace no confiable ni interrumpe una
// conversación en curso.
import * as vscode from 'vscode'
import { HookAction, HookDefinition, HookTrigger } from './types'

const HOOKS_DIR = '.qapi/hooks'
const MAX_HOOKS = 30
const DEBOUNCE_MS = 700
const VALID_TRIGGERS: HookTrigger[] = ['PostFileSave', 'PostFileCreate', 'PostFileDelete']

export async function loadHooks(): Promise<HookDefinition[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return []
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, HOOKS_DIR))
  } catch {
    return []
  }

  const hooks: HookDefinition[] = []
  for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.json')) continue
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, HOOKS_DIR, name))
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
      for (const hook of normalizeFile(parsed)) {
        if (hooks.length >= MAX_HOOKS) break
        hooks.push(hook)
      }
    } catch { /* archivo inválido: se omite */ }
  }
  return hooks
}

export interface HookRunner {
  /** El agente está ocupado; los eventos se descartan en ese caso. */
  isBusy(): boolean
  runAgentPrompt(prompt: string): Promise<void>
  runCommand(command: string, reason: string): Promise<void>
  onSkipped?(hook: HookDefinition, reason: string): void
}

/** Registra los disparadores del editor y devuelve un disposable agregado. */
export function registerHooks(runner: HookRunner): vscode.Disposable {
  const pending = new Map<string, NodeJS.Timeout>()
  let cache: HookDefinition[] = []
  let cacheLoaded = false

  const invalidate = () => { cacheLoaded = false }
  const hooks = async (): Promise<HookDefinition[]> => {
    if (!cacheLoaded) {
      cache = await loadHooks()
      cacheLoaded = true
    }
    return cache
  }

  const dispatch = (trigger: HookTrigger, uri: vscode.Uri) => {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
    if (relative.startsWith('.qapi/')) {
      // Cambiar la propia configuración de hooks no debe disparar hooks.
      invalidate()
      return
    }
    const key = `${trigger}:${relative}`
    const existing = pending.get(key)
    if (existing) clearTimeout(existing)
    pending.set(key, setTimeout(() => {
      pending.delete(key)
      void execute(trigger, relative)
    }, DEBOUNCE_MS))
  }

  const execute = async (trigger: HookTrigger, relative: string) => {
    const definitions = (await hooks()).filter((hook) => hook.trigger === trigger && matches(hook, relative))
    if (!definitions.length) return
    if (!vscode.workspace.isTrusted) {
      for (const hook of definitions) runner.onSkipped?.(hook, 'untrusted')
      return
    }
    for (const hook of definitions) {
      if (runner.isBusy()) {
        runner.onSkipped?.(hook, 'busy')
        return
      }
      try {
        if (hook.action.type === 'agent') {
          await runner.runAgentPrompt(`${hook.action.prompt}\n\nArchivo del evento: ${relative}`)
        } else {
          await runner.runCommand(hook.action.command, `Hook ${hook.name} (${trigger})`)
        }
      } catch { /* un hook fallido no debe romper la sesión */ }
    }
  }

  const subscriptions = [
    vscode.workspace.onDidSaveTextDocument((document) => dispatch('PostFileSave', document.uri)),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) dispatch('PostFileCreate', uri)
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) dispatch('PostFileDelete', uri)
    }),
  ]

  return new vscode.Disposable(() => {
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    for (const subscription of subscriptions) subscription.dispose()
  })
}

const matcherCache = new Map<string, RegExp | null>()

function matches(hook: HookDefinition, relativePath: string): boolean {
  if (!hook.matcher) return true
  const re = compileMatcher(hook.matcher)
  return re ? re.test(relativePath) : false
}

/** Compilado una vez por patrón; los cuantificadores anidados (ReDoS) se rechazan. */
function compileMatcher(source: string): RegExp | null {
  if (matcherCache.has(source)) return matcherCache.get(source)!
  let compiled: RegExp | null = null
  if (!/\([^)]*[+*][^)]*\)\s*[+*{]/.test(source)) {
    try { compiled = new RegExp(source) } catch { compiled = null }
  }
  if (matcherCache.size > 200) matcherCache.clear()
  matcherCache.set(source, compiled)
  return compiled
}

function normalizeFile(parsed: any): HookDefinition[] {
  const raw = Array.isArray(parsed?.hooks) ? parsed.hooks : Array.isArray(parsed) ? parsed : [parsed]
  const hooks: HookDefinition[] = []
  for (const candidate of raw) {
    const hook = normalizeHook(candidate)
    if (hook) hooks.push(hook)
  }
  return hooks
}

function normalizeHook(candidate: any): HookDefinition | undefined {
  const trigger = VALID_TRIGGERS.find((value) => value === String(candidate?.trigger || ''))
  if (!trigger) return undefined
  const action = normalizeAction(candidate?.action)
  if (!action) return undefined
  const name = String(candidate?.name || 'hook').slice(0, 120)
  const matcher = typeof candidate?.matcher === 'string' ? candidate.matcher.slice(0, 300) : undefined
  return { name, trigger, matcher, action }
}

function normalizeAction(candidate: any): HookAction | undefined {
  const type = String(candidate?.type || '')
  if (type === 'agent') {
    const prompt = String(candidate?.prompt || '').trim().slice(0, 4_000)
    return prompt ? { type: 'agent', prompt } : undefined
  }
  if (type === 'command') {
    const command = String(candidate?.command || '').trim().slice(0, 600)
    return command ? { type: 'command', command } : undefined
  }
  return undefined
}
