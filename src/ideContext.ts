import { execFile } from 'node:child_process'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ProjectIndex } from './projectIndex'
import { ArtifactInfo, IdeContextSnapshot, IdeDiagnostic, TestImpact } from './types'

const MAX_ACTIVE_CHARS = 12_000
const MAX_SELECTION_CHARS = 4_000
const MAX_VISIBLE_FILES = 40
const MAX_DIAGNOSTICS = 50
const MAX_GIT_STATUS_CHARS = 4_000
const MAX_GIT_DIFF_CHARS = 18_000
const MAX_CHANGED_FILES = 200
const MAX_ARTIFACTS = 40
const MAX_ARTIFACT_BYTES_TO_READ = 256 * 1024
const MAX_ARTIFACT_TEXT_CHARS = 80_000
const GIT_TIMEOUT_MS = 3_000
const GIT_MAX_BUFFER = 512 * 1024

const ARTIFACT_EXCLUDE = '**/{node_modules,.git,.venv,venv,out,__pycache__,.pytest_cache}/**'
const ARTIFACT_GLOBS = [
  '**/{target/surefire-reports,target/failsafe-reports,build/test-results}/**/*.{xml,txt}',
  '**/{reports,report,logs,log,test-results,playwright-report,allure-results,allure-report}/**/*',
  '**/*.{log,trace,png,jpg,jpeg,webp}',
  '**/{*report*,*results*,*trace*,*screenshot*}.{html,htm,xml,json,txt,zip}',
]

/** Captura una instantánea acotada del estado observable del IDE. */
export async function captureIdeContext(): Promise<IdeContextSnapshot> {
  const candidate = vscode.window.activeTextEditor
  const editor = candidate && isSafeWorkspaceDocument(candidate.document.uri) ? candidate : undefined
  const activeFile = editor
    ? { path: displayPath(editor.document.uri), content: clip(redactSecrets(editor.document.getText()), MAX_ACTIVE_CHARS) }
    : undefined

  const selection = editor && !editor.selection.isEmpty
    ? {
        path: displayPath(editor.document.uri),
        text: clip(redactSecrets(editor.document.getText(editor.selection)), MAX_SELECTION_CHARS),
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
      }
    : undefined

  const visibleFiles = [...new Set(vscode.window.visibleTextEditors
    .filter((visibleEditor) => isSafeWorkspaceDocument(visibleEditor.document.uri))
    .map((visibleEditor) => displayPath(visibleEditor.document.uri)))]
    .slice(0, MAX_VISIBLE_FILES)

  const diagnostics = collectDiagnostics()
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  const [git, terminals] = await Promise.all([
    root?.scheme === 'file' ? captureGit(root.fsPath) : Promise.resolve(emptyGit()),
    captureTerminals(),
  ])

  return {
    activeFile,
    selection,
    visibleFiles,
    diagnostics,
    gitStatus: git.status,
    gitDiff: git.diff,
    changedFiles: git.changedFiles,
    terminals,
    capturedAt: Date.now(),
  }
}

/** Convierte la instantánea en texto legible y defensivamente acotado para un prompt. */
export function formatIdeContext(snapshot: IdeContextSnapshot): string {
  const lines: string[] = [`Contexto del IDE (capturado ${new Date(snapshot.capturedAt).toISOString()}):`]

  if (snapshot.activeFile) {
    lines.push(`\nArchivo activo: ${snapshot.activeFile.path}`)
    lines.push(clip(snapshot.activeFile.content, MAX_ACTIVE_CHARS) || '(vacío)')
  } else {
    lines.push('\nArchivo activo: ninguno')
  }

  if (snapshot.selection) {
    lines.push(`\nSelección: ${snapshot.selection.path}:${snapshot.selection.startLine}-${snapshot.selection.endLine}`)
    lines.push(clip(snapshot.selection.text, MAX_SELECTION_CHARS) || '(vacía)')
  }

  lines.push(`\nEditores visibles (${Math.min(snapshot.visibleFiles.length, MAX_VISIBLE_FILES)}):`)
  lines.push(...snapshot.visibleFiles.slice(0, MAX_VISIBLE_FILES).map((file) => `- ${file}`))
  if (!snapshot.visibleFiles.length) lines.push('- ninguno')

  lines.push(`\nProblems (${Math.min(snapshot.diagnostics.length, 20)} de ${snapshot.diagnostics.length}):`)
  lines.push(...snapshot.diagnostics.slice(0, 20).map((diagnostic) =>
    `- [${diagnostic.severity}] ${diagnostic.path}:${diagnostic.line}: ${clip(oneLine(diagnostic.message), 300)}`,
  ))
  if (!snapshot.diagnostics.length) lines.push('- ninguno')

  lines.push('\nGit status:')
  lines.push(redactSecrets(clip(snapshot.gitStatus, MAX_GIT_STATUS_CHARS)) || '(sin cambios o Git no disponible)')
  lines.push('\nArchivos cambiados:')
  lines.push(...snapshot.changedFiles.slice(0, MAX_CHANGED_FILES).map((file) => `- ${file}`))
  if (!snapshot.changedFiles.length) lines.push('- ninguno')
  lines.push('\nGit diff:')
  lines.push(redactSecrets(clip(snapshot.gitDiff, MAX_GIT_DIFF_CHARS)) || '(vacío o Git no disponible)')

  lines.push('\nTerminales (la API de VS Code no expone el scrollback):')
  lines.push(...snapshot.terminals.slice(0, 30).map((terminal) => `- ${terminal}`))
  if (!snapshot.terminals.length) lines.push('- ninguna')

  return clip(lines.join('\n'), 55_000)
}

/** Descubre evidencia reciente de ejecuciones y devuelve sólo metadatos. */
export async function discoverArtifacts(): Promise<ArtifactInfo[]> {
  if (!vscode.workspace.workspaceFolders?.length) return []

  const settled = await Promise.allSettled(
    ARTIFACT_GLOBS.map((glob) => vscode.workspace.findFiles(glob, ARTIFACT_EXCLUDE, 250)),
  )
  const unique = new Map<string, vscode.Uri>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const uri of result.value) unique.set(uri.toString(), uri)
  }

  const candidates = [...unique.values()].slice(0, 600)
  const artifacts = await Promise.all(candidates.map(async (uri): Promise<ArtifactInfo | undefined> => {
    const kind = artifactKind(uri.path)
    if (!kind) return undefined
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type !== vscode.FileType.File) return undefined
      return {
        path: displayPath(uri),
        kind,
        size: Math.max(0, stat.size),
        modifiedAt: Math.max(0, stat.mtime),
      }
    } catch {
      return undefined
    }
  }))

  return artifacts
    .filter((artifact): artifact is ArtifactInfo => Boolean(artifact))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_ARTIFACTS)
}

/** Lee evidencia textual pequeña; para binarios o archivos grandes devuelve metadatos. */
export async function readArtifact(artifact: ArtifactInfo): Promise<string> {
  const uri = resolveWorkspacePath(artifact.path)
  const metadata = formatArtifactMetadata(artifact)
  if (!uri) return `${metadata}\nContenido no disponible: ruta fuera del workspace.`

  let stat: vscode.FileStat
  try {
    stat = await vscode.workspace.fs.stat(uri)
  } catch {
    return `${metadata}\nContenido no disponible: el archivo ya no existe o no se puede leer.`
  }

  const currentMetadata = formatArtifactMetadata({ ...artifact, size: stat.size, modifiedAt: stat.mtime })
  if (stat.type !== vscode.FileType.File) return `${currentMetadata}\nContenido no disponible: no es un archivo.`
  if (isBinaryArtifact(uri.path, artifact.kind)) {
    return `${currentMetadata}\nContenido binario omitido; se reportan únicamente metadatos.`
  }
  if (stat.size > MAX_ARTIFACT_BYTES_TO_READ) {
    return `${currentMetadata}\nContenido omitido: supera el límite de ${MAX_ARTIFACT_BYTES_TO_READ} bytes.`
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (looksBinary(bytes)) return `${currentMetadata}\nContenido binario omitido; se reportan únicamente metadatos.`
    const text = Buffer.from(bytes).toString('utf8')
    const content = clip(redactSecrets(text), MAX_ARTIFACT_TEXT_CHARS)
    return `${currentMetadata}\n\n${content || '(archivo textual vacío)'}`
  } catch {
    return `${currentMetadata}\nContenido no disponible: error de lectura.`
  }
}

/** Estima los tests afectados usando exclusivamente las rutas conocidas por el índice. */
export async function analyzeTestImpact(snapshot: IdeContextSnapshot, index: ProjectIndex): Promise<TestImpact> {
  const changedFiles = [...new Set(snapshot.changedFiles.map(normalizeRelativePath).filter(Boolean))]
    .slice(0, MAX_CHANGED_FILES)
  const testPaths = index.paths.filter(isTestPath)
  const scores = new Map<string, number>()

  for (const testPath of testPaths) {
    const normalizedTest = normalizeRelativePath(testPath)
    let score = changedFiles.includes(normalizedTest) ? 1_000 : 0
    for (const changedFile of changedFiles) score += impactScore(changedFile, normalizedTest)
    if (score > 0) scores.set(normalizedTest, score)
  }

  for (const testPath of testPaths.slice(0, 160)) {
    const content = (await index.readFile(testPath, 80_000))?.toLowerCase().replace(/\\/g, '/') || ''
    if (!content) continue
    let importScore = 0
    for (const changedFile of changedFiles) {
      const stem = fileStem(changedFile)
      const withoutExtension = changedFile.replace(/\.[^/.]+$/, '').toLowerCase()
      if ((stem.length >= 3 && content.includes(stem)) || content.includes(withoutExtension)) importScore += 160
    }
    if (importScore) scores.set(testPath, (scores.get(testPath) || 0) + importScore)
  }

  const probableTests = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([testPath]) => testPath)

  const fallback = probableTests.length === 0
  const suggestedCommands = suggestTestCommands(probableTests, index, fallback)
  return { changedFiles, probableTests, suggestedCommands, fallback }
}

function collectDiagnostics(): IdeDiagnostic[] {
  const out: IdeDiagnostic[] = []
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (!isSafeWorkspaceDocument(uri)) continue
    for (const diagnostic of diagnostics) {
      if (out.length >= MAX_DIAGNOSTICS) return out
      out.push({
        path: displayPath(uri),
        line: diagnostic.range.start.line + 1,
        severity: diagnosticSeverity(diagnostic.severity),
        message: clip(oneLine(diagnostic.message), 1_000),
      })
    }
  }
  return out
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): IdeDiagnostic['severity'] {
  if (severity === vscode.DiagnosticSeverity.Error) return 'error'
  if (severity === vscode.DiagnosticSeverity.Warning) return 'warning'
  return 'info'
}

async function captureTerminals(): Promise<string[]> {
  return Promise.all(vscode.window.terminals.slice(0, 30).map(async (terminal) => {
    const options = terminal.creationOptions
    const shellPath = 'shellPath' in options && typeof options.shellPath === 'string'
      ? options.shellPath
      : undefined
    const cwdValue = 'cwd' in options ? options.cwd : undefined
    const cwd = typeof cwdValue === 'string'
      ? cwdValue
      : cwdValue instanceof vscode.Uri ? displayPath(cwdValue) : undefined
    const processId = await withTimeout(terminal.processId, 250)
    const exitCode = terminal.exitStatus?.code
    const metadata = [
      `nombre=${JSON.stringify(terminal.name)}`,
      shellPath ? `shell=${JSON.stringify(shellPath)}` : '',
      cwd ? `cwd=${JSON.stringify(cwd)}` : '',
      processId === undefined ? '' : `pid=${processId}`,
      exitCode === undefined ? 'estado=activo' : `estado=finalizado(${exitCode})`,
      'scrollback=no disponible mediante la API de VS Code',
    ].filter(Boolean)
    return metadata.join(', ')
  }))
}

interface GitCapture {
  status: string
  diff: string
  changedFiles: string[]
}

function emptyGit(): GitCapture {
  return { status: '', diff: '', changedFiles: [] }
}

async function captureGit(cwd: string): Promise<GitCapture> {
  const [status, diff, names] = await Promise.all([
    runGit(cwd, ['status', '--short', '--untracked-files=all']),
    runGit(cwd, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--']),
    runGit(cwd, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD', '--']),
  ])
  const statusPaths = pathsFromStatus(status)
  const diffPaths = names.split(/\r?\n/).map(normalizeRelativePath).filter(Boolean)
  return {
    status: clip(status, MAX_GIT_STATUS_CHARS),
    diff: clip(diff, MAX_GIT_DIFF_CHARS),
    changedFiles: [...new Set([...diffPaths, ...statusPaths])].slice(0, MAX_CHANGED_FILES),
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout) => {
      if (error && !stdout) {
        resolve('')
        return
      }
      resolve(typeof stdout === 'string' ? stdout.trimEnd() : '')
    })
  })
}

function pathsFromStatus(status: string): string[] {
  const paths: string[] = []
  for (const line of status.split(/\r?\n/).slice(0, MAX_CHANGED_FILES)) {
    if (line.length < 4) continue
    let file = line.slice(3).trim()
    const renameSeparator = file.lastIndexOf(' -> ')
    if (renameSeparator >= 0) file = file.slice(renameSeparator + 4)
    file = unquoteGitPath(file)
    const normalized = normalizeRelativePath(file)
    if (normalized) paths.push(normalized)
  }
  return paths
}

function unquoteGitPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value
  try {
    return JSON.parse(value)
  } catch {
    return value.slice(1, -1)
  }
}

function isSafeWorkspaceDocument(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (!folder || uri.scheme !== 'file') return false
  const relative = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
  return !/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|credentials?|secrets?|id_rsa|id_ed25519)(\/|$)/i.test(relative)
}

function redactSecrets(value: string): string {
  return value
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
}

function displayPath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (!folder) return uri.scheme === 'file' ? uri.fsPath : uri.toString(true)
  const relative = path.posix.normalize(path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'))
  if ((vscode.workspace.workspaceFolders?.length || 0) > 1) return `${folder.name}/${relative}`
  return relative
}

function resolveWorkspacePath(candidate: string): vscode.Uri | undefined {
  if (!candidate || candidate.includes('\0') || path.isAbsolute(candidate)) return undefined
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return undefined
  const folders = vscode.workspace.workspaceFolders || []

  for (const folder of folders) {
    const prefix = `${folder.name}/`
    const relative = folders.length > 1 && normalized.startsWith(prefix)
      ? normalized.slice(prefix.length)
      : normalized
    if (folders.length > 1 && !normalized.startsWith(prefix)) continue
    const resolved = vscode.Uri.joinPath(folder.uri, relative)
    if (vscode.workspace.getWorkspaceFolder(resolved)?.uri.toString() === folder.uri.toString()) return resolved
  }
  return folders.length === 1 ? vscode.Uri.joinPath(folders[0].uri, normalized) : undefined
}

function artifactKind(filePath: string): ArtifactInfo['kind'] | undefined {
  const lower = filePath.toLowerCase()
  const extension = path.posix.extname(lower)
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return 'screenshot'
  if (extension === '.trace' || /(^|[/_.-])trace(s)?([/_.-]|$)/.test(lower)) return 'trace'
  if (extension === '.log' || /(^|\/)logs?\//.test(lower)) return 'log'
  if (/report|results?|junit|allure|playwright-report/.test(lower)) return 'report'
  return undefined
}

function isBinaryArtifact(filePath: string, kind: ArtifactInfo['kind']): boolean {
  const extension = path.posix.extname(filePath.toLowerCase())
  return kind === 'screenshot' || kind === 'trace' || ['.zip', '.gz', '.pdf'].includes(extension)
}

function looksBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 8_192)
  if (!sampleLength) return false
  let suspicious = 0
  for (let i = 0; i < sampleLength; i++) {
    const byte = bytes[i]
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / sampleLength > 0.1
}

function formatArtifactMetadata(artifact: ArtifactInfo): string {
  const modified = Number.isFinite(artifact.modifiedAt)
    ? new Date(artifact.modifiedAt).toISOString()
    : 'desconocido'
  return [
    `Artefacto: ${artifact.path}`,
    `Tipo: ${artifact.kind}`,
    `Tamaño: ${artifact.size} bytes`,
    `Modificado: ${modified}`,
  ].join('\n')
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase()
  return /(^|\/)(tests?|specs?|e2e|features|cypress|__tests__|src\/test)(\/|$)/.test(normalized)
    || /(?:^|[._-])(test|spec|cy)\.[^/]+$/.test(normalized)
    || normalized.endsWith('.feature')
    || normalized.endsWith('.robot')
}

function impactScore(changedFile: string, testFile: string): number {
  if (!changedFile || !testFile || changedFile === testFile) return 0
  const changedStem = fileStem(changedFile)
  const testStem = fileStem(testFile).replace(/(?:[._-](?:test|spec|cy))$/i, '')
  let score = 0
  if (changedStem && testStem && changedStem === testStem) score += 120
  else if (changedStem.length >= 3 && testFile.toLowerCase().includes(changedStem.toLowerCase())) score += 70

  const changedParts = directoryParts(changedFile)
  const testParts = directoryParts(testFile)
  let shared = 0
  while (shared < changedParts.length && shared < testParts.length && changedParts[shared] === testParts[shared]) shared++
  score += Math.min(shared * 8, 32)

  const changedSegments = new Set(changedFile.toLowerCase().split('/').filter((part) => part.length >= 4))
  const relatedSegments = testFile.toLowerCase().split('/').filter((part) => changedSegments.has(part))
  score += Math.min(relatedSegments.length * 10, 30)
  return score
}

function suggestTestCommands(probableTests: string[], index: ProjectIndex, fallback: boolean): string[] {
  const commands: string[] = []
  const selected = probableTests.slice(0, 8)
  if (!fallback && selected.length) {
    if (selected.every((test) => test.endsWith('.feature'))) commands.push(`behave ${quotePaths(selected)}`)
    else if (selected.some((test) => /playwright|\.spec\.[jt]sx?$/.test(test))) commands.push(`npx playwright test ${quotePaths(selected)}`)
    else if (selected.some((test) => /cypress|\.cy\.[jt]s$/.test(test))) commands.push(`npx cypress run --spec ${quotePaths(selected)}`)
    else if (selected.every((test) => test.endsWith('.py'))) commands.push(`pytest ${quotePaths(selected)}`)
    else if (selected.some((test) => /\.(?:test|spec)\.[jt]sx?$/.test(test))) commands.push(`npm test -- ${quotePaths(selected)}`)
    else if (selected.some((test) => /src\/test|\.java$/.test(test))) commands.push('mvn test')
  }

  for (const configured of index.profile?.testCommands || []) {
    const executable = configured.split(/\s+→\s+/)[0].trim()
    if (executable && !commands.includes(executable)) commands.push(executable)
    if (commands.length >= 3) break
  }
  return commands.slice(0, 3)
}

function quotePaths(paths: string[]): string {
  return paths.map((filePath) => `'${filePath.replace(/'/g, `'\\''`)}'`).join(' ')
}

function fileStem(filePath: string): string {
  const base = path.posix.basename(filePath)
  return base.slice(0, Math.max(0, base.length - path.posix.extname(base).length)).toLowerCase()
}

function directoryParts(filePath: string): string[] {
  return path.posix.dirname(filePath).toLowerCase().split('/').filter(Boolean)
}

function normalizeRelativePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  return normalized === '.' ? '' : normalized
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… [truncado: ${value.length - maxChars} caracteres omitidos]`
}

async function withTimeout<T>(promise: Thenable<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ])
}
