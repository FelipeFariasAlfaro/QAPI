import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import type { ProjectProfile } from './projectProfile'
import type { CommandProposal, ExecutionRun } from './types'

const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS
/** Se conserva el inicio y, sobre todo, el final: ahí van los resúmenes de jest/pytest. */
const HEAD_BYTES = 12 * 1024
const TAIL_BYTES = 52 * 1024
/** Margen para que el proceso termine tras SIGTERM antes de forzar SIGKILL. */
const KILL_GRACE_MS = 1_500
const automaticProposals = new Map<string, string>()

function boundedTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)))
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

/** Prefijos que no cambian qué se ejecuta y se usan para esconder un comando. */
const WRAPPER_PREFIX = /^(?:[A-Za-z_][\w]*=\S*\s+|command\s+|builtin\s+|env\s+(?:-\S+\s+)*|exec\s+|nohup\s+|time\s+|nice\s+(?:-n\s*-?\d+\s+)?|xargs\s+(?:-\S+(?:\s+\d+)?\s+)*|sudo\s+)/i

function shellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||\$\(|`|[;|&\n()])/)
    .map((part) => {
      let segment = part.trim().replace(/^[{\s]+/, '')
      for (let guard = 0; guard < 8; guard++) {
        const next = segment.replace(WRAPPER_PREFIX, '')
        if (next === segment) break
        segment = next.trim()
      }
      return segment.replace(/["']/g, '')
    })
    .filter(Boolean)
}

export function hasDestructiveCommand(command: string, depth = 0): boolean {
  if (/(^|[\s;&|()`$])sudo(?=\s|$)/i.test(command)) return true
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/i.test(command)) return true
  // Se evalúa sobre el comando completo: al partir por `|` la regla nunca coincidía.
  if (/\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|iex|python3?|node)\b/i.test(command)) return true

  // `bash -c "..."` y similares: se revisa el comando interno.
  if (depth < 3) {
    const inner = [...command.matchAll(/\b(?:ba|z|da|k)?sh\s+-c\s+(["'])([\s\S]*?)\1/gi)]
    if (inner.some((match) => hasDestructiveCommand(match[2], depth + 1))) return true
  }

  return shellSegments(command).some((segment) => {
    if (/^(?:[^\s]+\/)?(?:shutdown|reboot|poweroff|halt)\b/i.test(segment) || /^(?:[^\s]+\/)?mkfs(?:\.[\w-]+)?\b/i.test(segment)) return true
    if (/^(?:[^\s]+\/)?dd\b[^\n]*\bof=\/dev\//i.test(segment)) return true
    if (/^(?:Remove-Item|ri)\b[^\n]*-Recurse/i.test(segment)) return true
    if (/^(?:rd|rmdir|del|erase)\b[^\n]*\/s\b/i.test(segment)) return true
    if (/^find\b[^\n]*\s(?:-delete\b|-exec\s+(?:\S+\/)?rm\b)/i.test(segment)) return true
    if (/^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*reset\b[^\n]*--hard\b/i.test(segment)) return true
    if (/^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*push\b[^\n]*(?:--force(?:-with-lease)?\b|--mirror\b|(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)|\s\+[^\s]+)/i.test(segment)) return true

    const clean = segment.match(/^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*clean\b(.*)$/i)
    if (clean && (/(?:^|\s)--force(?:\s|$)/i.test(clean[1]) || /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(clean[1]))) {
      return true
    }

    const rm = segment.match(/^(?:[^\s]+\/)?rm\b(.*)$/i)
    if (!rm) return false
    const recursive = /(?:^|\s)--recursive(?:\s|$)/i.test(rm[1]) || /(?:^|\s)-[a-z]*r[a-z]*(?:\s|$)/i.test(rm[1])
    const force = /(?:^|\s)--force(?:\s|$)/i.test(rm[1]) || /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(rm[1])
    return recursive && force
  })
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function isUnsafeCwdValue(value: string, root: string): boolean {
  const target = unquote(value.trim())
  if (!target || target === '-' || /[\0$`%]/.test(target) || target.startsWith('~') || /^file:/i.test(target)) return true
  if (/^[a-zA-Z]:[\\/]/.test(target)) return true
  return !isInside(root, path.resolve(root, target))
}

export function hasExternalWorkingDirectory(command: string, root: string): boolean {
  // `cd` sin argumento (o seguido de un separador) cambia a $HOME.
  if (/(?:^|[;&|()\n])\s*cd\s*(?:$|[;&|)\n])/i.test(command)) return true
  const cwdPatterns = [
    /(?:^|[;&|()\n])\s*(?:cd|pushd|chdir)\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s;&|()]+)/gi,
    /(?:^|\s)(?:--cwd|--chdir|--directory|--prefix|--dir|-C)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|()]+)/g,
  ]

  return cwdPatterns.some((pattern) => {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      if (isUnsafeCwdValue(match[1], root)) return true
    }
    return false
  })
}

/**
 * Acumula la salida sin límite de memoria: conserva los primeros HEAD_BYTES y
 * los últimos TAIL_BYTES. A diferencia de `exec` con maxBuffer, un exceso de
 * salida nunca mata el proceso ni lo marca como fallido.
 */
export class OutputCollector {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private total = 0

  push(chunk: Buffer): void {
    this.total += chunk.length
    if (this.head.length < HEAD_BYTES) {
      const room = HEAD_BYTES - this.head.length
      this.head = Buffer.concat([this.head, chunk.subarray(0, room)])
      chunk = chunk.subarray(room)
      if (!chunk.length) return
    }
    this.tail = Buffer.concat([this.tail, chunk])
    if (this.tail.length > TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES)
  }

  toString(): string {
    const omitted = this.total - this.head.length - this.tail.length
    if (omitted <= 0) return Buffer.concat([this.head, this.tail]).toString('utf8')
    return `${this.head.toString('utf8')}\n\n[… ${omitted} bytes omitidos …]\n\n${this.tail.toString('utf8')}`
  }
}

/** Termina el proceso y todos sus descendientes (watchers, servidores de prueba). */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    } catch { /* el proceso ya terminó */ }
    return
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal) } catch {
      try { child.kill(signal) } catch { /* ya terminó */ }
    }
  }
  signalGroup('SIGTERM')
  setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref()
}

function blockedRun(proposal: CommandProposal, automatic: boolean | undefined, output: string): ExecutionRun {
  return {
    id: newId('run'),
    command: proposal.command,
    status: 'blocked',
    output,
    durationMs: 0,
    automatic,
  }
}

export function createCommandProposal(command: string, reason: string, timeoutMs?: number): CommandProposal {
  return {
    id: newId('command'),
    command: command.trim(),
    reason: reason.trim(),
    timeoutMs: boundedTimeout(timeoutMs),
  }
}

export function runCommand(proposal: CommandProposal, automatic?: boolean, signal?: AbortSignal): Promise<ExecutionRun> {
  const command = proposal.command.trim()
  const folder = vscode.workspace.workspaceFolders?.[0]

  if (!vscode.workspace.isTrusted) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: the workspace is not trusted.'))
  }
  if (automatic) {
    const expected = automaticProposals.get(proposal.id)
    automaticProposals.delete(proposal.id)
    if (expected !== command) {
      return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: automatic commands must come from ProjectProfile.testCommands.'))
    }
  }
  if (!folder || folder.uri.scheme !== 'file' || !path.isAbsolute(folder.uri.fsPath)) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: no local workspace root is available.'))
  }

  const root = path.resolve(folder.uri.fsPath)
  if (!command) return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: the command is empty.'))
  if (hasDestructiveCommand(command)) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: the command contains an evident destructive operation.'))
  }
  if (hasExternalWorkingDirectory(command, root)) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: the command requests a working directory outside the workspace.'))
  }
  if (signal?.aborted) return Promise.resolve(blockedRun(proposal, automatic, 'Cancelled before starting.'))

  const timeoutMs = boundedTimeout(proposal.timeoutMs)
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const output = new OutputCollector()
    let settled = false
    let timedOut = false
    let cancelled = false
    let child: ChildProcess
    const timers: NodeJS.Timeout[] = []

    const finish = (status: ExecutionRun['status'], exitCode?: number, extra = '') => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        id: newId('run'),
        command,
        status,
        exitCode,
        output: `${output.toString()}${extra}`,
        durationMs: Date.now() - startedAt,
        automatic,
      })
    }
    const stop = (reason: 'timeout' | 'cancel') => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      else cancelled = true
      killTree(child)
      // Si un nieto mantiene abiertos los pipes, 'close' nunca llega: se resuelve igual.
      timers.push(setTimeout(() => finish(
        timedOut ? 'timeout' : 'failed',
        undefined,
        timedOut ? `\n[timeout de ${timeoutMs} ms: proceso terminado]` : '\n[cancelado por el usuario]',
      ), KILL_GRACE_MS + 1_000))
    }
    const onAbort = () => stop('cancel')

    try {
      child = spawn(command, {
        cwd: root,
        shell: true,
        // Grupo de procesos propio para poder terminar todo el árbol en POSIX.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      finish('failed', undefined, error instanceof Error ? error.message : String(error))
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk))
    child.on('error', (error) => finish('failed', undefined, `\n${error.message}`))
    child.on('close', (code) => {
      if (timedOut) return finish('timeout', undefined, `\n[timeout de ${timeoutMs} ms: proceso terminado]`)
      if (cancelled) return finish('failed', undefined, '\n[cancelado por el usuario]')
      finish(code === 0 ? 'passed' : 'failed', code ?? undefined)
    })
    timers.push(setTimeout(() => stop('timeout'), timeoutMs))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Archivos de prueba reconocibles por nombre o extensión. */
export function isTestFile(path: string): boolean {
  const name = path.split('/').pop() || path
  return /\.(?:feature|robot)$/i.test(name)
    || /\.(?:test|spec|cy)\.[cm]?[jt]sx?$/i.test(name)
    || /^test_.+\.py$|^.+_test\.py$/i.test(name)
    || /(?:Test|Tests|IT|Spec)\.(?:java|kt)$/.test(name)
    || /_spec\.rb$/i.test(name)
}

function quoteArg(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`
}

export type VerificationCommandResult =
  | { ok: true; command: string; scoped: boolean }
  | { ok: false; reason: 'empty' | 'no-tests' | 'no-files' | 'unsafe' }

/**
 * Construye el comando de verificación a partir de la plantilla del usuario.
 *
 * - `{tests}` se reemplaza por los archivos de prueba cambiados; si no hay
 *   ninguno, no se ejecuta nada (antes se corría la suite completa).
 * - `{files}` se reemplaza por todos los archivos cambiados.
 * - Sin marcadores, es un comando fijo que el usuario eligió conscientemente.
 */
export function buildVerificationCommand(template: string, changedFiles: string[]): VerificationCommandResult {
  const trimmed = template.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  const files = [...new Set(changedFiles.map((file) => file.replace(/\\/g, '/')))].slice(0, 200)
  const tests = files.filter(isTestFile)
  let command = trimmed
  // `{tests,}` / `{files,}` unen con comas (p. ej. `cypress run --spec`).
  for (const [token, list, reason] of [['tests', tests, 'no-tests'], ['files', files, 'no-files']] as const) {
    if (!command.includes(`{${token}`)) continue
    if (!list.length) return { ok: false, reason }
    command = command
      .split(`{${token},}`).join(quoteArg(list.join(',')))
      .split(`{${token}}`).join(list.map(quoteArg).join(' '))
  }
  if (hasDestructiveCommand(command)) return { ok: false, reason: 'unsafe' }
  return { ok: true, command, scoped: command !== trimmed }
}

/** Registra un comando de verificación del usuario para que pueda ejecutarse automáticamente. */
export function createVerificationProposal(command: string, reason: string): CommandProposal {
  const proposal = createCommandProposal(command, reason)
  automaticProposals.set(proposal.id, proposal.command)
  return proposal
}

/**
 * Sugerencia de plantilla según el perfil. Sólo se muestra en Configuración:
 * nunca se usa sin que el usuario la acepte.
 */
export function suggestVerificationCommand(profile?: ProjectProfile): string | undefined {
  if (!profile) return undefined
  const frameworks = new Set(profile.testFrameworks)
  if (frameworks.has('Behave')) return 'behave {tests}'
  if (frameworks.has('Playwright') && profile.languages.includes('Python')) return 'pytest {tests}'
  if (frameworks.has('Playwright')) return 'npx playwright test {tests}'
  if (frameworks.has('Cypress')) return 'npx cypress run --spec {tests,}'
  if (frameworks.has('pytest')) return 'pytest {tests}'
  if (frameworks.has('Vitest')) return 'npx vitest run {tests}'
  if (frameworks.has('Jest')) return 'npx jest {tests}'
  if (frameworks.has('Robot Framework')) return 'robot {tests}'
  return undefined
}

export function formatRun(run: ExecutionRun): string {
  const exitCode = run.exitCode === undefined ? 'n/a' : String(run.exitCode)
  const output = run.output || '(sin salida)'
  return [
    `Comando: ${run.command}`,
    `Estado: ${run.status}`,
    `Código de salida: ${exitCode}`,
    `Duración: ${run.durationMs} ms`,
    'Salida:',
    output,
  ].join('\n')
}
