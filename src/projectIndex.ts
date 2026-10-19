// Índice de contexto del proyecto abierto.
//
// Decisión: recuperación léxica local (BM25-lite) + mapa del repo, por workspace.
// Se eligió esto sobre un servicio externo o embeddings porque: no añade
// dependencias nativas, funciona offline, reindexar es barato y se puede
// mantener al día con un FileSystemWatcher. La interfaz queda lista para
// añadir embeddings (p. ej. Ollama) más adelante sin cambiar los consumidores.
import * as vscode from 'vscode'
import { createHash } from 'crypto'
import { open, realpath, stat } from 'fs/promises'
import * as nodePath from 'path'
import { detectProfile, ProjectProfile } from './projectProfile'
import { isPrivatePath, looksLikeBrowserSession } from './memory/memory'

interface Doc {
  path: string
  text: string
  hash: string
  terms: Map<string, number>
  length: number
}

export interface GherkinConventions {
  featureCount: number
  languageHeaderCount: number
  usesLanguageHeader: boolean
  languageCode?: string
  predominantKeywords: 'en' | 'es' | 'mixed' | 'unknown'
  examples: { path: string; excerpt: string }[]
}

const CODE_EXTENSIONS = 'ts,tsx,js,jsx,mjs,cjs,py,java,kt,cs,rb,go,php,feature,json,md,yml,yaml,robot,toml,ini,cfg,gradle,kts'
const CODE_GLOB = `**/*.{${CODE_EXTENSIONS}}`
/**
 * Manifiestos y configuraciones sin extensión de código: sin ellos no se
 * detectaba Behave/pytest/Maven ni sus comandos de prueba.
 */
const MANIFEST_GLOB = '**/{requirements*.txt,Pipfile,pom.xml,testng.xml,Gemfile,go.mod,setup.py,setup.cfg,tox.ini,behave.ini,pytest.ini,.mocharc.*}'
const MANIFEST_NAME_RE = /(?:^|\/)(?:requirements[\w.-]*\.txt|Pipfile|pom\.xml|testng\.xml|Gemfile|go\.mod|setup\.py|setup\.cfg|tox\.ini|behave\.ini|pytest\.ini|\.mocharc\.[\w]+)$/
const CODE_EXTENSION_RE = new RegExp(`\\.(?:${CODE_EXTENSIONS.split(',').join('|')})$`)
const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'coverage', 'target',
  'playwright-report', 'test-results', 'allure-results', 'allure-report', 'blob-report',
  '.next', '.nuxt', '.svelte-kit', '.angular', '.gradle', '.idea', '.vs', 'site-packages', 'obj',
  '.qapi-cache', '.cache', '.turbo', '.parcel-cache', 'screenshots', 'videos', 'traces',
])
const EXCLUDE = `**/{${[...EXCLUDED_PATH_SEGMENTS].join(',')}}/**`
/** Archivos generados que no aportan contexto y ocupan el cupo del índice. */
const GENERATED_FILE_RE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|composer\.lock|[^/]+\.min\.(?:js|css)|[^/]+\.map)$/
const MAX_FILES = 1500
const MAX_BYTES = 200 * 1024
/** Lectura directa desde disco: tope duro para no cargar archivos gigantes en RAM. */
const MAX_READ_BYTES = 8 * 1024 * 1024
const READ_CONCURRENCY = 16
/** Con más cambios pendientes que esto, conviene reconstruir el índice completo. */
const FULL_REBUILD_THRESHOLD = 200

export class ProjectIndex {
  private docs: Doc[] = []
  private df = new Map<string, number>()
  private avgLen = 0
  private _indexing = false
  private _dirty = false
  private _buildEpoch = 0
  private _version = 0
  private watcher?: vscode.FileSystemWatcher
  private manifestWatcher?: vscode.FileSystemWatcher
  private _profile?: ProjectProfile
  /** Documentos abiertos ya tokenizados, por URI y versión del editor. */
  private openDocCache = new Map<string, { version: number; doc: Doc }>()
  private memo = new Map<string, unknown>()

  get indexing(): boolean { return this._indexing || this._dirty }
  get fileCount(): number { return this.docs.length }
  /** Perfil detectado del proyecto (stack, frameworks, convenciones). */
  get profile(): ProjectProfile | undefined { return this._profile }
  /** Rutas de todos los archivos indexados. */
  get paths(): string[] { return this.docs.map((d) => d.path) }
  /** Identidad del contenido indexado, incluyendo documentos abiertos. */
  get fingerprint(): string {
    return this.memoize('fingerprint', () => fingerprintDocs(this.currentDocs()))
  }

  /** Snapshot en RAM para validar y reutilizar lecturas previas sin tocar el disco. */
  fileSnapshot(relPath: string, maxChars = 20_000): { path: string; content: string; hash: string } | undefined {
    const norm = safeIndexPath(relPath)
    if (!norm) return undefined
    const doc = this.docMap().get(norm)
    return doc ? { path: norm, content: doc.text.slice(0, maxChars), hash: doc.hash } : undefined
  }

  /** Lee un archivo del workspace (editor abierto, disco o índice). */
  async readFile(relPath: string, maxChars = 20000): Promise<string | undefined> {
    const norm = safeIndexPath(relPath)
    if (!norm || isSensitivePath(norm)) return undefined
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!root) return undefined
    const uri = vscode.Uri.joinPath(root, norm)
    if (!await isRealPathInside(root, uri)) return undefined
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    let text: string | undefined
    if (openDocument && !openDocument.isClosed) text = openDocument.getText().slice(0, maxChars)
    else {
      try {
        text = await readTextPrefix(uri.fsPath, maxChars)
      } catch {
        text = this.docs.find((item) => item.path === norm)?.text.slice(0, maxChars)
      }
    }
    // Un storageState de Playwright tiene cookies de sesión: no se entrega al modelo.
    return text !== undefined && looksLikeBrowserSession(norm, text) ? undefined : text
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

  /**
   * Búsqueda en el contenido indexado. Por defecto es literal (sin distinguir
   * mayúsculas): los selectores como `[data-testid="login"]` se interpretaban
   * como regex. Para una regex explícita se usa `/patrón/` o `/patrón/i`.
   */
  searchCode(query: string, limit = 40): { path: string; line: number; text: string }[] {
    const matcher = buildMatcher(query)
    if (!matcher) return []
    const out: { path: string; line: number; text: string }[] = []
    const perFileLimit = Math.max(3, Math.ceil(limit / 5))
    for (const doc of this.currentDocs()) {
      const lines = doc.text.split('\n')
      let inFile = 0
      for (let i = 0; i < lines.length; i++) {
        if (!matcher(lines[i])) continue
        out.push({ path: doc.path, line: i + 1, text: lines[i].trim().slice(0, 200) })
        if (out.length >= limit) return out
        if (++inFile >= perFileLimit) break
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
    if (!folders || folders.length === 0) { this.docs = []; this._dirty = false; this.touch(); return }
    const epoch = ++this._buildEpoch
    this._dirty = false
    this._indexing = true
    onStatus?.(true, 0)
    try {
      // Los manifiestos van primero: nunca deben quedar fuera por el tope de archivos.
      const [manifestUris, codeUris] = await Promise.all([
        vscode.workspace.findFiles(MANIFEST_GLOB, EXCLUDE, 200),
        vscode.workspace.findFiles(CODE_GLOB, EXCLUDE, MAX_FILES * 2),
      ])
      const seen = new Set<string>()
      const candidates: { uri: vscode.Uri; rel: string }[] = []
      for (const uri of [...manifestUris, ...codeUris]) {
        const rel = safeIndexPath(vscode.workspace.asRelativePath(uri, false))
        if (!rel || seen.has(rel) || !isIndexablePath(rel)) continue
        seen.add(rel)
        candidates.push({ uri, rel })
      }
      // Prioridad: manifiestos, luego archivos poco profundos (fuentes y pruebas reales).
      candidates.sort((a, b) => priority(a.rel) - priority(b.rel) || a.rel.localeCompare(b.rel))
      const selected = candidates.slice(0, MAX_FILES)
      const docs = (await mapLimit(selected, READ_CONCURRENCY, ({ uri, rel }) => readDoc(uri, rel)))
        .filter((doc): doc is Doc => Boolean(doc))
      if (epoch !== this._buildEpoch) return
      const profile = await detectProfile(docs.map((d) => d.path))
      // Si empezó una reconstrucción más reciente, ésta es la única autorizada a publicar resultados.
      if (epoch !== this._buildEpoch) return
      this.docs = docs
      this.computeDf()
      this._profile = profile
      this.touch()
      if (!this._dirty) onStatus?.(false, docs.length)
    } finally {
      if (epoch === this._buildEpoch) this._indexing = false
    }
  }

  /**
   * Mantiene el índice al día ante cambios en disco. Los cambios se aplican de
   * forma incremental (sólo los archivos tocados); antes cada guardado
   * reconstruía el índice completo.
   */
  watch(
    onStatus?: (indexing: boolean, files: number) => void,
    onFilesChanged?: (paths: string[]) => void,
  ): vscode.Disposable {
    this.watcher?.dispose()
    this.manifestWatcher?.dispose()
    this.watcher = vscode.workspace.createFileSystemWatcher(CODE_GLOB)
    this.manifestWatcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB)
    const pending = new Map<string, vscode.Uri>()
    let timer: NodeJS.Timeout | undefined
    const flush = async () => {
      timer = undefined
      const batch = [...pending.entries()]
      pending.clear()
      if (!batch.length) return
      onFilesChanged?.(batch.map(([path]) => path))
      if (batch.length > FULL_REBUILD_THRESHOLD || this._indexing) {
        await this.build(onStatus)
        return
      }
      await this.applyIncremental(batch)
      this._dirty = pending.size > 0
      if (!this._dirty) onStatus?.(false, this.docs.length)
    }
    const schedule = (uri: vscode.Uri) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri
      const path = root ? indexPathForUri(uri, root) : undefined
      if (!path) return
      pending.set(path, uri)
      if (!this._dirty) onStatus?.(true, this.docs.length)
      this._dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), 600)
    }
    for (const watcher of [this.watcher, this.manifestWatcher]) {
      watcher.onDidChange(schedule)
      watcher.onDidCreate(schedule)
      watcher.onDidDelete(schedule)
    }
    const watchers = [this.watcher, this.manifestWatcher]
    return new vscode.Disposable(() => {
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.dispose()
    })
  }

  private async applyIncremental(batch: [string, vscode.Uri][]): Promise<void> {
    const byPath = new Map(this.docs.map((doc) => [doc.path, doc]))
    let manifestTouched = false
    let added = false
    for (const [path, uri] of batch) {
      if (isManifestPath(path)) manifestTouched = true
      const doc = await readDoc(uri, path)
      if (doc) {
        if (!byPath.has(path)) added = true
        if (byPath.size < MAX_FILES || byPath.has(path)) byPath.set(path, doc)
      } else if (byPath.delete(path)) {
        added = true
      }
    }
    this.docs = [...byPath.values()]
    this.computeDf()
    // El perfil depende de rutas y manifiestos: sólo se recalcula si cambiaron.
    if (manifestTouched || added) this._profile = await detectProfile(this.docs.map((d) => d.path))
    this.touch()
  }

  private touch() {
    this._version++
    this.memo.clear()
  }

  /** Documentos indexados con el contenido vigente de los editores abiertos. */
  private currentDocs(): Doc[] {
    return [...this.docMap().values()]
  }

  private docMap(): Map<string, Doc> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    const byPath = new Map(this.docs.map((doc) => [doc.path, doc]))
    if (!root) return byPath
    const liveUris = new Set<string>()
    for (const document of vscode.workspace.textDocuments) {
      if (document.isClosed) continue
      const rel = indexPathForUri(document.uri, root)
      if (!rel) continue
      const key = document.uri.toString()
      liveUris.add(key)
      const cached = this.openDocCache.get(key)
      if (cached && cached.version === document.version && cached.doc.path === rel) {
        byPath.set(rel, cached.doc)
        continue
      }
      const text = document.getText()
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) continue
      const indexed = byPath.get(rel)
      const hash = hashText(text)
      // Sin cambios respecto al disco: se reutiliza el documento ya tokenizado.
      const doc = indexed && indexed.hash === hash ? indexed : makeDoc(rel, text, hash)
      this.openDocCache.set(key, { version: document.version, doc })
      byPath.set(rel, doc)
    }
    for (const key of this.openDocCache.keys()) if (!liveUris.has(key)) this.openDocCache.delete(key)
    return byPath
  }

  private computeDf() {
    this.df.clear()
    let total = 0
    for (const doc of this.docs) {
      total += doc.length
      for (const term of doc.terms.keys()) this.df.set(term, (this.df.get(term) || 0) + 1)
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0
  }

  /** Recupera los fragmentos más relevantes para la consulta (contexto RAG). */
  retrieve(query: string, k = 6): { path: string; excerpt: string }[] {
    const docs = this.currentDocs()
    if (docs.length === 0) return []
    // Términos únicos: repetir una palabra en la consulta no debe duplicar su peso.
    const qTerms = [...new Set(tokenize(query))]
    if (!qTerms.length) return []
    // df/avgLen precalculados en cada build; los editores abiertos no alteran la idf de forma relevante.
    const N = Math.max(this.docs.length, 1)
    const avgLen = this.avgLen || 1
    const k1 = 1.5
    const b = 0.75
    const scored = docs.map((doc) => {
      let score = 0
      for (const term of qTerms) {
        const tf = doc.terms.get(term) || 0
        if (!tf) continue
        const df = this.df.get(term) || 1
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen))
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
    return this.memoize('gherkin', () => computeGherkinConventions(this.currentDocs()))
  }

  /**
   * Step definitions realmente disponibles en el proyecto.
   *
   * Soporta Behave y pytest-bdd (Python), Cucumber-JS/Cypress (JS/TS, con
   * strings o expresiones regulares) y Cucumber-JVM (Java/Kotlin). Sirven como
   * fuente de verdad para que la IA reutilice steps en lugar de inventarlos.
   */
  stepDefinitions(): { pattern: string; file: string }[] {
    return this.memoize('steps', () => extractStepDefinitions(this.currentDocs()))
  }

  /**
   * Archivo de steps más representativo (el que más steps define), recortado.
   * Se usa como plantilla de estilo para implementar steps nuevos.
   */
  sampleStepFile(): { path: string; excerpt: string } | undefined {
    return this.memoize('sampleStep', () => {
      const counts = new Map<string, number>()
      for (const s of this.stepDefinitions()) counts.set(s.file, (counts.get(s.file) || 0) + 1)
      let best: string | undefined
      let max = 0
      for (const [file, n] of counts) if (n > max) { max = n; best = file }
      if (!best) return undefined
      const doc = this.docMap().get(best)
      return doc ? { path: doc.path, excerpt: doc.text.slice(0, 4000) } : undefined
    })
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

  /**
   * Memo invalidado por cada cambio del índice y por la versión de los
   * editores abiertos con cambios sin guardar.
   */
  private memoize<T>(name: string, compute: () => T): T {
    const dirtyKey = vscode.workspace.textDocuments
      .filter((document) => !document.isClosed && document.isDirty)
      .map((document) => `${document.uri.toString()}@${document.version}`)
      .join('|')
    const key = `${name}\u0000${this._version}\u0000${dirtyKey}`
    if (this.memo.has(key)) return this.memo.get(key) as T
    const value = compute()
    if (this.memo.size > 64) this.memo.clear()
    this.memo.set(key, value)
    return value
  }

  dispose() {
    this.watcher?.dispose()
    this.manifestWatcher?.dispose()
  }
}

// ── Lectura e indexado ──────────────────────────────────────────────────────

async function readDoc(uri: vscode.Uri, rel: string): Promise<Doc | undefined> {
  try {
    const info = await vscode.workspace.fs.stat(uri)
    if (info.size > MAX_BYTES) return undefined
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (looksBinary(bytes)) return undefined
    const text = Buffer.from(bytes).toString('utf8')
    // storageState con otro nombre de archivo: se reconoce por su contenido.
    if (looksLikeBrowserSession(rel, text)) return undefined
    return makeDoc(rel, text, hashText(text))
  } catch {
    return undefined
  }
}

function makeDoc(path: string, text: string, hash: string): Doc {
  const terms = tokenizeCount(text)
  return { path, text, hash, terms, length: sum(terms.values()) }
}

/** Lee como mucho `maxChars` caracteres sin cargar archivos enormes completos. */
async function readTextPrefix(fsPath: string, maxChars: number): Promise<string> {
  const info = await stat(fsPath)
  // UTF-8 usa hasta 4 bytes por carácter; se lee un margen y se recorta.
  const wanted = Math.min(info.size, MAX_READ_BYTES, Math.max(4096, maxChars * 4))
  const handle = await open(fsPath, 'r')
  try {
    const buffer = Buffer.alloc(wanted)
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (looksBinary(bytes)) return `[archivo binario de ${info.size} bytes; contenido omitido]`
    return bytes.toString('utf8').slice(0, maxChars)
  } finally {
    await handle.close()
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000)
  for (const byte of sample) if (byte === 0) return true
  return false
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

function priority(path: string): number {
  if (isManifestPath(path) || /(?:^|\/)package\.json$/.test(path)) return 0
  const depth = path.split('/').length
  const docsPenalty = /\.(?:md|json|ya?ml)$/.test(path) ? 3 : 0
  return 1 + depth + docsPenalty
}

function isManifestPath(path: string): boolean {
  return MANIFEST_NAME_RE.test(path) || /(?:^|\/)(?:package\.json|pyproject\.toml|build\.gradle(?:\.kts)?|composer\.json)$/.test(path)
}

function isIndexablePath(path: string): boolean {
  return (CODE_EXTENSION_RE.test(path) || MANIFEST_NAME_RE.test(path))
    && !GENERATED_FILE_RE.test(path)
    && !isSensitivePath(path)
    && !path.split('/').some((part) => EXCLUDED_PATH_SEGMENTS.has(part))
}

/**
 * Nunca se indexan ni se leen credenciales locales, la configuración de Git ni
 * estados de sesión del navegador (storageState de Playwright con cookies).
 */
function isSensitivePath(path: string): boolean {
  return isPrivatePath(path) || isLegacySensitivePath(path)
}

function isLegacySensitivePath(path: string): boolean {
  return /(?:^|\/)\.git(?:\/|$)/.test(path)
    || /(?:^|\/)\.env(?:\.[^/]*)?$/.test(path)
    || /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/.test(path)
    || /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(path)
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

// ── Búsqueda ────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Patrones con cuantificadores anidados, típicos de backtracking catastrófico. */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)\s*[+*{]/

/**
 * Literal por defecto; regex sólo con la forma explícita `/.../flags`, acotada
 * en longitud y sin cuantificadores anidados (ReDoS).
 */
export function buildMatcher(query: string): ((line: string) => boolean) | undefined {
  const trimmed = query.trim()
  if (!trimmed) return undefined
  const explicit = trimmed.match(/^\/(.+)\/([imsu]*)$/)
  if (explicit && explicit[1].length <= 200 && !NESTED_QUANTIFIER_RE.test(explicit[1])) {
    try {
      const re = new RegExp(explicit[1], explicit[2].includes('i') ? explicit[2] : `${explicit[2]}i`)
      return (line) => re.test(line)
    } catch { /* se trata como literal */ }
  }
  const needle = trimmed.toLowerCase()
  return (line) => line.toLowerCase().includes(needle)
}

// ── Gherkin y steps ─────────────────────────────────────────────────────────

function computeGherkinConventions(docs: Doc[]): GherkinConventions {
  const features = docs.filter((doc) => doc.path.toLowerCase().endsWith('.feature'))
  const languageCodes = new Map<string, number>()
  let languageHeaderCount = 0
  let englishKeywords = 0
  let spanishKeywords = 0

  const englishRe = /^\s*(?:Feature|Background|Rule|Scenario(?: Outline| Template)?|Example|Examples|Scenarios)\s*:|^\s*(?:Given|When|Then|And|But)\b/i
  const spanishRe = /^\s*(?:Característica|Caracteristica|Antecedentes|Regla|Escenario|Esquema del escenario|Ejemplo|Ejemplos|Escenarios)\s*:|^\s*(?:Dado|Dada|Dados|Dadas|Cuando|Entonces|Y|E|Pero)\b/i

  for (const feature of features) {
    const code = languageHeader(feature.text)
    if (code) {
      languageHeaderCount++
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

/** `# language:` sólo cuenta en la cabecera (antes de la primera línea con contenido). */
export function languageHeader(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^#\s*language\s*:\s*([\w-]+)/i)
    if (match) return match[1].toLowerCase()
    if (!trimmed.startsWith('#')) return undefined
  }
  return undefined
}

// Se captura la comilla de apertura y se exige la misma de cierre: antes
// `Given('I see "Login" button')` se cortaba en la primera comilla interna.
// Grupos: 1 = keyword, 2 = comilla, 3 = patrón.
const PY_STEP_RE = /@\s*(?:\w+\.)?(given|when|then|step|dado|dada|cuando|entonces)\s*\(\s*(?:parsers\.\w+\(\s*)?(?:[rRuUbB]{1,2})?(["'])((?:\\.|(?!\2)[^\\\n])*)\2/gi
const JS_STEP_RE = /\b(Given|When|Then|And|But|defineStep|Step)\s*\(\s*(["'`])((?:\\.|(?!\2)[^\\])*?)\2/g
const JS_REGEX_STEP_RE = /\b(Given|When|Then|And|But|defineStep|Step)\s*\(\s*\/((?:\\.|[^/\n])+)\/[gimsuy]*/g
const JVM_STEP_RE = /@(Given|When|Then|And|But|Dado|Cuando|Entonces|Y|Pero)\s*\(\s*"((?:\\.|[^"\\])*)"/g

export function extractStepDefinitions(docs: { path: string; text: string }[]): { pattern: string; file: string }[] {
  const out: { pattern: string; file: string }[] = []
  const seen = new Set<string>()
  const add = (keyword: string, pattern: string, file: string) => {
    const clean = pattern.replace(/\\(["'`])/g, '$1').trim()
    if (!clean) return
    const key = `${keyword.toLowerCase()} ${clean}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ pattern: clean, file })
  }
  for (const doc of docs) {
    const regexes = doc.path.endsWith('.py')
      ? [PY_STEP_RE]
      : /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(doc.path)
        ? [JS_STEP_RE, JS_REGEX_STEP_RE]
        : /\.(?:java|kt)$/.test(doc.path)
          ? [JVM_STEP_RE]
          : []
    for (const re of regexes) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(doc.text)) !== null) {
        // Grupos: 1 = keyword; el patrón es el último grupo capturado.
        add(m[1], m[m.length - 1], doc.path)
      }
    }
  }
  return out
}

// ── Utilidades ──────────────────────────────────────────────────────────────

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprintDocs(docs: Doc[]): string {
  return hashText(docs
    .map((doc) => `${doc.path}\u0000${doc.hash}`)
    .sort()
    .join('\u0001'))
}

/** Sin tildes: "caracteristica" y "característica" deben coincidir. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9_ñ]{2,}/g) || []).slice(0, 20000)
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
