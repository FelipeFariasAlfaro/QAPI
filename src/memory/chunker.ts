// Fragmentador: divide cada archivo en unidades con significado propio
// (funciones, clases, métodos, escenarios Gherkin, secciones Markdown) para que
// el agente reciba y lea piezas pequeñas en lugar de archivos completos.
export type ChunkKind = 'module' | 'function' | 'class' | 'method' | 'step' | 'feature' | 'scenario' | 'section' | 'block'

export interface RawChunk {
  kind: ChunkKind
  title: string
  /** Líneas 1-based, inclusivas. */
  start: number
  end: number
  text: string
  /** Primera línea significativa (firma, encabezado o nombre del escenario). */
  signature: string
  /** Primer comentario o docstring, si existe. */
  doc?: string
}

const MAX_CHUNK_LINES = 80
const WINDOW_LINES = 60
const GENERIC_WINDOW = 40
const MAX_CHUNKS_PER_FILE = 150
const MAX_CHUNK_CHARS = 6000

interface Boundary { line: number; kind: ChunkKind; title: string }

const STEP_DECORATOR_RE = /^\s*@(?:given|when|then|step|dado|cuando|entonces|and|but)\s*\(\s*(?:u|r|ur|ru)?(["'])((?:\\.|(?!\1).)*)\1/i
const JS_STEP_RE = /^\s{0,4}(?:Given|When|Then|And|But|defineStep|Step)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/
const JS_TEST_RE = /^\s{0,6}(?:describe|it|test|context)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/
const JVM_STEP_RE = /^\s*@(?:Given|When|Then|And|But|Dado|Cuando|Entonces|Y|Pero)\s*\(\s*"((?:\\.|[^"\\])*)"/
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new'])

function extension(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

function baseName(path: string): string {
  return path.split('/').pop() || path
}

function pythonBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = []
  let currentClass = ''
  let pendingStep = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const step = STEP_DECORATOR_RE.exec(line)
    if (step) { pendingStep = step[2]; continue }
    const match = /^( {0,4}|\t?)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(line)
    if (!match) {
      if (pendingStep && line.trim() && !line.trim().startsWith('@')) pendingStep = ''
      continue
    }
    const indent = match[1].length
    const name = match[3]
    if (match[2] === 'class') {
      if (indent === 0) currentClass = name
      out.push({ line: i, kind: 'class', title: indent === 0 ? name : `${currentClass}.${name}` })
    } else if (pendingStep) {
      out.push({ line: i, kind: 'step', title: pendingStep })
    } else {
      if (indent === 0) currentClass = ''
      out.push({ line: i, kind: indent === 0 ? 'function' : 'method', title: indent > 0 && currentClass ? `${currentClass}.${name}` : name })
    }
    pendingStep = ''
  }
  return out
}

function jsBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = []
  let currentClass = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let match: RegExpExecArray | null
    if ((match = JS_STEP_RE.exec(line))) { out.push({ line: i, kind: 'step', title: match[2] }); continue }
    if ((match = JS_TEST_RE.exec(line))) { out.push({ line: i, kind: 'scenario', title: match[2] }); continue }
    if ((match = /^\s{0,2}(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      currentClass = match[1]
      out.push({ line: i, kind: 'class', title: match[1] })
      continue
    }
    if ((match = /^\s{0,2}(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      out.push({ line: i, kind: 'function', title: match[1] })
      continue
    }
    if ((match = /^\s{0,2}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(line))) {
      out.push({ line: i, kind: 'function', title: match[1] })
      continue
    }
    if ((match = /^\s{2,4}(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/.exec(line))) {
      if (!CONTROL_WORDS.has(match[1])) out.push({ line: i, kind: 'method', title: currentClass ? `${currentClass}.${match[1]}` : match[1] })
    }
  }
  return out
}

function jvmBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = []
  let currentClass = ''
  let pendingStep = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let match: RegExpExecArray | null
    if ((match = JVM_STEP_RE.exec(line))) { pendingStep = match[1]; continue }
    if ((match = /^\s{0,4}(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial)\s+)*(?:class|interface|enum|object|record)\s+(\w+)/.exec(line))) {
      currentClass = match[1]
      out.push({ line: i, kind: 'class', title: match[1] })
      pendingStep = ''
      continue
    }
    match = /^\s{2,8}(?:(?:public|private|protected|internal|static|final|override|suspend|open|async|virtual|abstract|synchronized)\s+)*(?:fun\s+(\w+)|[\w<>[\],.? ]+?\s+(\w+))\s*\(/.exec(line)
    if (match && !line.trim().endsWith(';')) {
      const name = match[1] || match[2]
      if (name && !CONTROL_WORDS.has(name)) {
        out.push({ line: i, kind: pendingStep ? 'step' : 'method', title: pendingStep || (currentClass ? `${currentClass}.${name}` : name) })
      }
    }
    pendingStep = ''
  }
  return out
}

function simpleBoundaries(lines: string[], re: RegExp, kind: ChunkKind): Boundary[] {
  const out: Boundary[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = re.exec(lines[i])
    if (match) out.push({ line: i, kind, title: match[match.length - 1] })
  }
  return out
}

function gherkinBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let match: RegExpExecArray | null
    if ((match = /^\s*(?:Feature|Característica|Caracteristica|Funcionalidad|Business Need|Ability)\s*:\s*(.*)$/.exec(line))) {
      out.push({ line: i, kind: 'feature', title: match[1].trim() || 'Feature' })
    } else if ((match = /^\s*(?:Background|Antecedentes|Contexto)\s*:\s*(.*)$/.exec(line))) {
      out.push({ line: i, kind: 'scenario', title: match[1].trim() || 'Background' })
    } else if ((match = /^\s*(?:Scenario Outline|Scenario Template|Scenario|Example|Esquema del escenario|Plantilla del escenario|Escenario|Ejemplo)\s*:\s*(.*)$/.exec(line))) {
      out.push({ line: i, kind: 'scenario', title: match[1].trim() || 'Scenario' })
    }
  }
  return out
}

function markdownBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue }
    if (fenced) continue
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (match) out.push({ line: i, kind: 'section', title: match[2] })
  }
  return out
}

function boundariesFor(path: string, lines: string[]): Boundary[] | undefined {
  const ext = extension(path)
  if (ext === 'py') return pythonBoundaries(lines)
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return jsBoundaries(lines)
  if (['java', 'kt', 'kts', 'cs', 'scala'].includes(ext)) return jvmBoundaries(lines)
  if (ext === 'go') return simpleBoundaries(lines, /^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function')
  if (ext === 'rb') return simpleBoundaries(lines, /^\s{0,2}(?:def|class|module)\s+([\w.?!:]+)/, 'function')
  if (ext === 'php') return simpleBoundaries(lines, /^\s{0,4}(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class)\s+(\w+)/, 'function')
  if (ext === 'feature') return gherkinBoundaries(lines)
  if (ext === 'md') return markdownBoundaries(lines)
  return undefined
}

/** Sube el inicio para incluir decoradores, etiquetas Gherkin y comentarios pegados a la firma. */
function attachPreamble(lines: string[], line: number, floor: number): number {
  let start = line
  while (start - 1 > floor) {
    const previous = lines[start - 1].trim()
    if (/^(@|#|\/\/|\/\*\*?|\*)/.test(previous) && previous.length > 0) start--
    else break
  }
  return start
}

function docFor(lines: string[], from: number, to: number): string | undefined {
  for (let i = from + 1; i <= Math.min(to, from + 4); i++) {
    const text = lines[i]?.trim() || ''
    const match = /^(?:"""|'''|\/\*\*|\/\/|#(?!\s*language)|\*)\s*(.+?)(?:"""|'''|\*\/)?$/.exec(text)
    if (match && match[1].length > 3) return match[1].slice(0, 140)
  }
  return undefined
}

function makeChunk(lines: string[], kind: ChunkKind, title: string, start: number, end: number): RawChunk {
  const slice = lines.slice(start, end + 1)
  const firstReal = slice.findIndex((line) => line.trim() && !/^\s*(@|#|\/\/)/.test(line))
  const signatureIndex = firstReal >= 0 ? start + firstReal : start
  return {
    kind,
    title: title.slice(0, 160),
    start: start + 1,
    end: end + 1,
    text: slice.join('\n').slice(0, MAX_CHUNK_CHARS),
    signature: (lines[signatureIndex] || '').trim().slice(0, 160),
    doc: docFor(lines, signatureIndex, end),
  }
}

/** Parte un fragmento largo en ventanas, conservando el título del original. */
function splitLong(lines: string[], chunk: { kind: ChunkKind; title: string; start: number; end: number }): RawChunk[] {
  const length = chunk.end - chunk.start + 1
  if (length <= MAX_CHUNK_LINES) return [makeChunk(lines, chunk.kind, chunk.title, chunk.start, chunk.end)]
  const out: RawChunk[] = []
  for (let from = chunk.start, part = 1; from <= chunk.end; from += WINDOW_LINES, part++) {
    const to = Math.min(chunk.end, from + WINDOW_LINES - 1)
    out.push(makeChunk(lines, part === 1 ? chunk.kind : 'block', part === 1 ? chunk.title : `${chunk.title} (parte ${part})`, from, to))
  }
  return out
}

export function chunkFile(path: string, text: string): RawChunk[] {
  const lines = text.split(/\r?\n/)
  if (!text.trim()) return []
  const boundaries = boundariesFor(path, lines)
  const chunks: RawChunk[] = []
  if (!boundaries) {
    for (let from = 0, part = 1; from < lines.length; from += GENERIC_WINDOW, part++) {
      const to = Math.min(lines.length - 1, from + GENERIC_WINDOW - 1)
      chunks.push(makeChunk(lines, 'block', part === 1 ? baseName(path) : `${baseName(path)} (parte ${part})`, from, to))
    }
  } else {
    const starts = boundaries.map((boundary, i) => ({
      ...boundary,
      start: attachPreamble(lines, boundary.line, i > 0 ? boundaries[i - 1].line : -1),
    }))
    const firstStart = starts.length ? starts[0].start : lines.length
    if (firstStart > 0 && lines.slice(0, firstStart).some((line) => line.trim())) {
      chunks.push(...splitLong(lines, { kind: 'module', title: baseName(path), start: 0, end: firstStart - 1 }))
    }
    for (let i = 0; i < starts.length; i++) {
      const end = (i + 1 < starts.length ? starts[i + 1].start : lines.length) - 1
      if (end < starts[i].start) continue
      chunks.push(...splitLong(lines, { kind: starts[i].kind, title: starts[i].title, start: starts[i].start, end }))
    }
  }
  return chunks.filter((chunk) => chunk.text.trim()).slice(0, MAX_CHUNKS_PER_FILE)
}
