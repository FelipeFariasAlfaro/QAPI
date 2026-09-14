// Índice de contexto del proyecto abierto.
//
// Decisión: recuperación léxica local (BM25-lite) + mapa del repo, por workspace.
// Se eligió esto sobre un servicio externo o embeddings porque: no añade
// dependencias nativas, funciona offline, reindexar es barato y se puede
// mantener al día con un FileSystemWatcher. La interfaz queda lista para
// añadir embeddings (p. ej. Ollama) más adelante sin cambiar los consumidores.
import * as vscode from 'vscode'
import { createHash } from 'crypto'
import { realpath } from 'fs/promises'
import * as nodePath from 'path'
import { detectProfile, ProjectProfile } from './projectProfile'

interface Doc {
  path: string
  text: string
  hash: string
  terms: Map<string, number>
}

export interface GherkinConventions {
  featureCount: number
  languageHeaderCount: number
  usesLanguageHeader: boolean
  languageCode?: string
  predominantKeywords: 'en' | 'es' | 'mixed' | 'unknown'
  examples: { path: string; excerpt: string }[]
}

const CODE_GLOB = '**/*.{ts,tsx,js,jsx,py,java,feature,cy.js,cy.ts,json,md,yml,yaml,robot}'
const EXCLUDE = '**/{node_modules,.git,dist,build,out,.venv,venv,__pycache__,.pytest_cache,coverage,target}/**'
const CODE_EXTENSION_RE = /\.(?:ts|tsx|js|jsx|py|java|feature|json|md|yml|yaml|robot)$/
const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv',
  '__pycache__', '.pytest_cache', 'coverage', 'target',
])
const MAX_FILES = 1500
const MAX_BYTES = 200 * 1024

export class ProjectIndex {
  private docs: Doc[] = []
  private df = new Map<string, number>()
  private avgLen = 0
  private _indexing = false
  private _dirty = false
  private _buildEpoch = 0
  private watcher?: vscode.FileSystemWatcher
  private _profile?: ProjectProfile

  get indexing(): boolean { return this._indexing || this._dirty }
  get fileCount(): number { return this.docs.length }
  /** Perfil detectado del proyecto (stack, frameworks, convenciones). */
  get profile(): ProjectProfile | undefined { return this._profile }
  /** Rutas de todos los archivos indexados. */
  get paths(): string[] { return this.docs.map((d) => d.path) }
  /** Identidad del contenido indexado, incluyendo documentos abiertos. */
  get fingerprint(): string { return fingerprintDocs(this.currentDocs()) }

  /** Snapshot en RAM para validar y reutilizar lecturas previas sin tocar el disco. */
  fileSnapshot(relPath: string, maxChars = 20_000): { path: string; content: string; hash: string } | undefined {
    const norm = safeIndexPath(relPath)
    if (!norm) return undefined
    const doc = this.currentDocs().find((item) => item.path === norm)
    return doc ? { path: norm, content: doc.text.slice(0, maxChars), hash: doc.hash } : undefined
  }

  /** Lee un archivo del índice (o del disco si no está indexado). */
  async readFile(relPath: string, maxChars = 20000): Promise<string | undefined> {
    const norm = safeIndexPath(relPath)
    if (!norm) return undefined
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!root) return undefined
    const uri = vscode.Uri.joinPath(root, norm)
    if (!await isRealPathInside(root, uri)) return undefined
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    if (open && !open.isClosed) return open.getText().slice(0, maxChars)
    try {
      const bytes = await vscode.workspace.fs.readFile(uri)
      return Buffer.from(bytes).toString('utf8').slice(0, maxChars)
    } catch {
      const doc = this.docs.find((item) => item.path === norm)
      return doc?.text.slice(0, maxChars)
    }
  }

  /** Lista rutas que empiecen por un prefijo (para explorar el árbol). */
  listFiles(prefix = '', limit = 200): string[] {
    const p = prefix.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
    return this.docs
      .map((d) => d.path)
      .filter((path) => !p || path.startsWith(p))
      .sort()
      .slice(0, limit)
  }

  /** Búsqueda literal/regex en el contenido indexado. */
  searchCode(query: string, limit = 40): { path: string; line: number; text: string }[] {
    const out: { path: string; line: number; text: string }[] = []
    let re: RegExp
    try { re = new RegExp(query, 'i') } catch { re = new RegExp(escapeRe(query), 'i') }
    for (const doc of this.currentDocs()) {
      const lines = doc.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ path: doc.path, line: i + 1, text: lines[i].trim().slice(0, 200) })
          if (out.length >= limit) return out
        }
      }
    }
    return out
  }

  /** Nombre del proyecto (primera carpeta del workspace). */
  get projectName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name || 'sin proyecto'
  }

  async build(onStatus?: (indexing: boolean, files: number) => void): Promise<void> {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) { this.docs = []; this._dirty = false; return }
    const epoch = ++this._buildEpoch
    this._dirty = false
    this._indexing = true
    onStatus?.(true, 0)
    try {
      const uris = await vscode.workspace.findFiles(CODE_GLOB, EXCLUDE, MAX_FILES)
      const docs: Doc[] = []
      for (const uri of uris) {
        try {
          const rel = safeIndexPath(vscode.workspace.asRelativePath(uri, false))
          if (!rel || !isIndexablePath(rel)) continue
          const stat = await vscode.workspace.fs.stat(uri)
          if (stat.size > MAX_BYTES) continue
          const bytes = await vscode.workspace.fs.readFile(uri)
          const text = Buffer.from(bytes).toString('utf8')
          docs.push({ path: rel, text, hash: hashText(text), terms: tokenizeCount(text) })
        } catch { /* archivo ilegible: se omite */ }
      }
      const profile = await detectProfile(docs.map((d) => d.path))
      // Si empezó una reconstrucción más reciente, ésta es la única autorizada a publicar resultados.
      if (epoch !== this._buildEpoch) return
      this.docs = docs
      this.computeDf()
      this._profile = profile
      if (!this._dirty) onStatus?.(false, docs.length)
    } finally {
      if (epoch === this._buildEpoch) this._indexing = false
    }
  }

  /** Mantiene el índice al día ante cambios en disco. */
  watch(
    onStatus?: (indexing: boolean, files: number) => void,
    onFilesChanged?: (paths: string[]) => void,
  ): vscode.Disposable {
    this.watcher?.dispose()
    this.watcher = vscode.workspace.createFileSystemWatcher(CODE_GLOB)
    let timer: NodeJS.Timeout | undefined
    const schedule = (uri: vscode.Uri) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri
      const path = root ? indexPathForUri(uri, root) : undefined
      if (!path) return
      this._dirty = true
      onStatus?.(true, this.docs.length)
      onFilesChanged?.([path])
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void this.build(onStatus), 800)
    }
    this.watcher.onDidChange(schedule)
    this.watcher.onDidCreate(schedule)
    this.watcher.onDidDelete(schedule)
    return this.watcher
  }

  private currentDocs(): Doc[] {
    const byPath = new Map(this.docs.map((doc) => [doc.path, doc]))
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!root) return this.docs
    for (const document of vscode.workspace.textDocuments) {
      if (document.isClosed) continue
      const rel = indexPathForUri(document.uri, root)
      if (!rel) continue
      const text = document.getText()
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) continue
      byPath.set(rel, { path: rel, text, hash: hashText(text), terms: tokenizeCount(text) })
    }
    return [...byPath.values()]
  }

  private computeDf() {
    this.df.clear()
    let total = 0
    for (const doc of this.docs) {
      total += sum(doc.terms.values())
      for (const term of doc.terms.keys()) this.df.set(term, (this.df.get(term) || 0) + 1)
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0
  }

  /** Recupera los fragmentos más relevantes para la consulta (contexto RAG). */
  retrieve(query: string, k = 6): { path: string; excerpt: string }[] {
    const docs = this.currentDocs()
    if (docs.length === 0) return []
    const qTerms = tokenize(query)
    const N = docs.length
    const k1 = 1.5
    const b = 0.75
    const df = new Map<string, number>()
    let totalTerms = 0
    for (const doc of docs) {
      totalTerms += sum(doc.terms.values())
      for (const term of doc.terms.keys()) df.set(term, (df.get(term) || 0) + 1)
    }
    const avgLen = totalTerms / N
    const scored = docs.map((doc) => {
      const len = sum(doc.terms.values())
      let score = 0
      for (const term of qTerms) {
        const tf = doc.terms.get(term) || 0
        if (!tf) continue
        const idf = Math.log(1 + (N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5))
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / (avgLen || 1)))
      }
      return { doc, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => ({ path: s.doc.path, excerpt: bestExcerpt(s.doc.text, qTerms) }))
  }

  /**
   * Convenciones Gherkin observadas en los .feature del proyecto.
   *
   * La mayoría del repositorio manda: el idioma de conversación no debe hacer
   * que el modelo introduzca una directiva `# language` ajena al proyecto.
   */
  gherkinConventions(): GherkinConventions {
    const features = this.currentDocs().filter((doc) => doc.path.toLowerCase().endsWith('.feature'))
    const languageCodes = new Map<string, number>()
    let languageHeaderCount = 0
    let englishKeywords = 0
    let spanishKeywords = 0

    const headerRe = /^\s*#\s*language\s*:\s*([\w-]+)/im
    const englishRe = /^\s*(?:Feature|Background|Scenario(?: Outline)?|Examples)\s*:|^\s*(?:Given|When|Then|And|But)\b/i
    const spanishRe = /^\s*(?:Característica|Antecedentes|Escenario|Esquema del escenario|Ejemplos)\s*:|^\s*(?:Dado|Dada|Dados|Dadas|Cuando|Entonces|Y|Pero)\b/i

    for (const feature of features) {
      const header = feature.text.match(headerRe)
      if (header) {
        languageHeaderCount++
        const code = header[1].toLowerCase()
        languageCodes.set(code, (languageCodes.get(code) || 0) + 1)
      }
      for (const line of feature.text.split(/\r?\n/)) {
        if (englishRe.test(line)) englishKeywords++
        if (spanishRe.test(line)) spanishKeywords++
      }
    }

    let predominantKeywords: GherkinConventions['predominantKeywords'] = 'unknown'
    if (englishKeywords || spanishKeywords) {
      if (englishKeywords > spanishKeywords * 1.25) predominantKeywords = 'en'
      else if (spanishKeywords > englishKeywords * 1.25) predominantKeywords = 'es'
      else predominantKeywords = 'mixed'
    }

    const languageCode = [...languageCodes.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0]

    return {
      featureCount: features.length,
      languageHeaderCount,
      usesLanguageHeader: features.length > 0 && languageHeaderCount > features.length / 2,
      languageCode,
      predominantKeywords,
      examples: features.slice(0, 3).map((feature) => ({
        path: feature.path,
        excerpt: feature.text.slice(0, 1600),
      })),
    }
  }

  /**
   * Step definitions realmente disponibles en el proyecto.
   *
   * Se extraen de los decoradores de Behave (@given/@when/@then/@step, y sus
   * equivalentes en español) y de los step definitions de Cucumber/Cypress en
   * JS/TS. Sirven como fuente de verdad para que la IA no invente steps que no
   * existen (p. ej. los de otro framework que el proyecto no tiene instalado).
   */
  stepDefinitions(): { pattern: string; file: string }[] {
    const out: { pattern: string; file: string }[] = []
    const seen = new Set<string>()
    // Python/Behave: @given('...') @when("...") @step(u'...')
    const PY = /@\s*(given|when|then|step|dado|dada|cuando|entonces)\s*\(\s*[ur]?["'](.+?)["']\s*\)/gi
    // JS/TS Cucumber: Given('...', ...) / When("...", ...)
    const JS = /\b(Given|When|Then|And|But)\s*\(\s*["'`](.+?)["'`]/g
    for (const doc of this.currentDocs()) {
      const isPy = doc.path.endsWith('.py')
      const isJs = /\.(ts|js|tsx|jsx)$/.test(doc.path)
      if (!isPy && !isJs) continue
      const re = isPy ? PY : JS
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(doc.text)) !== null) {
        const pattern = `${m[1].toLowerCase()} ${m[2]}`
        if (seen.has(pattern)) continue
        seen.add(pattern)
        out.push({ pattern: m[2], file: doc.path })
      }
    }
    return out
  }

  /**
   * Archivo de steps más representativo (el que más steps define), recortado.
   * Se usa como plantilla de estilo para implementar steps nuevos.
   */
  sampleStepFile(): { path: string; excerpt: string } | undefined {
    const counts = new Map<string, number>()
    for (const s of this.stepDefinitions()) counts.set(s.file, (counts.get(s.file) || 0) + 1)
    let best: string | undefined
    let max = 0
    for (const [file, n] of counts) if (n > max) { max = n; best = file }
    if (!best) return undefined
    const doc = this.currentDocs().find((d) => d.path === best)
    if (!doc) return undefined
    return { path: doc.path, excerpt: doc.text.slice(0, 4000) }
  }

  /** Resumen estructural del repo para dar visión de conjunto a la IA. */
  repoMap(limit = 60): string {
    const byDir = new Map<string, string[]>()
    for (const doc of this.docs) {
      const parts = doc.path.split('/')
      const dir = parts.slice(0, -1).join('/') || '.'
      if (!byDir.has(dir)) byDir.set(dir, [])
      byDir.get(dir)!.push(parts[parts.length - 1])
    }
    const lines: string[] = []
    let count = 0
    for (const [dir, files] of [...byDir.entries()].sort()) {
      if (count >= limit) { lines.push('…'); break }
      lines.push(`${dir}/`)
      for (const f of files.slice(0, 12)) { lines.push(`  ${f}`); count++ }
    }
    return lines.join('\n')
  }

  dispose() { this.watcher?.dispose() }
}

function isIndexablePath(path: string): boolean {
  return CODE_EXTENSION_RE.test(path)
    && !path.split('/').some((part) => EXCLUDED_PATH_SEGMENTS.has(part))
}

function indexPathForUri(uri: vscode.Uri, root: vscode.Uri): string | undefined {
  if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== root.toString()) return undefined
  const path = safeIndexPath(vscode.workspace.asRelativePath(uri, false))
  return path && isIndexablePath(path) ? path : undefined
}

function safeIndexPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.includes('\0')) return undefined
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..')) return undefined
  return parts.filter((part) => part && part !== '.').join('/') || undefined
}

async function isRealPathInside(root: vscode.Uri, target: vscode.Uri): Promise<boolean> {
  if (root.scheme !== 'file' || target.scheme !== 'file') return false
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(root.fsPath), realpath(target.fsPath)])
    const relative = nodePath.relative(rootReal, targetReal)
    return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative))
  } catch {
    return false
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprintDocs(docs: Doc[]): string {
  return hashText(docs
    .map((doc) => `${doc.path}\u0000${doc.hash}`)
    .sort()
    .join('\u0001'))
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-záéíóúñ0-9_]{2,}/gi) || []).slice(0, 20000)
}

function tokenizeCount(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokenize(text)) m.set(t, (m.get(t) || 0) + 1)
  return m
}

function sum(it: Iterable<number>): number {
  let s = 0
  for (const n of it) s += n
  return s
}

/** Devuelve el fragmento del texto con mayor densidad de términos de la query. */
function bestExcerpt(text: string, qTerms: string[], window = 40): string {
  const lines = text.split('\n')
  const qset = new Set(qTerms)
  let bestLine = 0
  let bestHits = -1
  for (let i = 0; i < lines.length; i++) {
    const hits = tokenize(lines[i]).filter((t) => qset.has(t)).length
    if (hits > bestHits) { bestHits = hits; bestLine = i }
  }
  const start = Math.max(0, bestLine - 4)
  const end = Math.min(lines.length, bestLine + window)
  return lines.slice(start, end).join('\n').slice(0, 2500)
}
