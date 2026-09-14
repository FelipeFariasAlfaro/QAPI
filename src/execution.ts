import { exec } from 'child_process'
import { randomUUID } from 'crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import type { ProjectProfile } from './projectProfile'
import type { CommandProposal, ExecutionRun } from './types'

const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024
const EXEC_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS
const automaticProposals = new Map<string, string>()

function boundedTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)))
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function shellSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/).map((part) => part.trim().replace(/^\(+/, ''))
}

function hasDestructiveCommand(command: string): boolean {
  // The explicit token check also catches forms such as `env sudo ...`.
  if (/(^|[\s;&|()])sudo(?=\s|$)/i.test(command)) return true
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/i.test(command)) return true

  return shellSegments(command).some((segment) => {
    if (/^(?:[^\s;&|()]+\/)?(?:shutdown|reboot|poweroff)\b/i.test(segment) || /^(?:[^\s;&|()]+\/)?mkfs(?:\.[\w-]+)?\b/i.test(segment)) return true
    if (/^(?:curl|wget)\b[^|]*(?:\||>)[^\n]*(?:sh|bash|zsh|pwsh|powershell)\b/i.test(segment)) return true
    if (/^(?:Remove-Item|del|rmdir)\b[^\n]*(?:-Recurse|\/s)/i.test(segment)) return true
    if (/^git\s+reset\b[^\n]*--hard\b/i.test(segment)) return true
    if (/^(?:git\s+)?push\b[^\n]*(?:--force(?:-with-lease)?\b|-f(?:\s|$))/i.test(segment)) return true

    const clean = segment.match(/^git\s+clean\b(.*)$/i)
    if (clean && (/(?:^|\s)--force(?:\s|$)/i.test(clean[1]) || /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(clean[1]))) {
      return true
    }

    const rm = segment.match(/^(?:[^\s;&|()]+\/)?rm\b(.*)$/i)
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

function hasExternalWorkingDirectory(command: string, root: string): boolean {
  const cwdPatterns = [
    /(?:^|[;&|()\n])\s*(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/gi,
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

function combineOutput(stdout: string, stderr: string): string {
  const sections: string[] = []
  if (stdout) sections.push(stdout)
  if (stderr) sections.push(stderr)
  const output = sections.join(stdout && stderr ? '\n' : '')
  const bytes = Buffer.from(output, 'utf8')
  if (bytes.length <= MAX_OUTPUT_BYTES) return output

  const marker = Buffer.from('\n[output truncated]', 'utf8')
  return Buffer.concat([bytes.subarray(0, MAX_OUTPUT_BYTES - marker.length), marker]).toString('utf8')
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

export function runCommand(proposal: CommandProposal, automatic?: boolean): Promise<ExecutionRun> {
  const command = proposal.command.trim()
  const folder = vscode.workspace.workspaceFolders?.[0]

  if (!vscode.workspace.isTrusted) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: the workspace is not trusted.'))
  }
  if (automatic && automaticProposals.get(proposal.id) !== command) {
    return Promise.resolve(blockedRun(proposal, automatic, 'Blocked: automatic commands must come from ProjectProfile.testCommands.'))
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

  const timeoutMs = boundedTimeout(proposal.timeoutMs)
  const startedAt = Date.now()
  return new Promise((resolve) => {
    try {
      exec(command, { cwd: root, timeout: timeoutMs, maxBuffer: EXEC_BUFFER_BYTES }, (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt
        const errorCode = (error as (Error & { code?: string | number }) | null)?.code
        const timedOut = Boolean(error && errorCode !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (error.killed || error.signal === 'SIGTERM'))
        const exitCode = typeof errorCode === 'number' ? errorCode : error ? undefined : 0
        resolve({
          id: newId('run'),
          command,
          status: timedOut ? 'timeout' : error ? 'failed' : 'passed',
          exitCode,
          output: combineOutput(stdout, stderr),
          durationMs,
          automatic,
        })
      })
    } catch (error) {
      resolve({
        id: newId('run'),
        command,
        status: 'failed',
        output: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        automatic,
      })
    }
  })
}

export function detectValidationCommand(profile: ProjectProfile): CommandProposal | undefined {
  for (const declared of profile.testCommands) {
    const command = declared.split('→', 1)[0].trim()
    if (!command || hasDestructiveCommand(command)) continue

    const proposal = createCommandProposal(command, 'Comando de validación detectado en el perfil del proyecto.')
    automaticProposals.set(proposal.id, proposal.command)
    return proposal
  }
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
