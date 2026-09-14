// Referencias explícitas de contexto (`#`).
//
// La captura automática acierta la mayoría de las veces, pero cuando el usuario
// sabe exactamente qué mirar debe poder decirlo. Estas referencias se resuelven
// en el host contra el índice y el snapshot del IDE, nunca confiando en texto
// libre del modelo.
import * as vscode from 'vscode'
import { ProjectIndex } from './projectIndex'
import { IdeContextSnapshot } from './types'

const REFERENCE_RE = /#(file|folder|problems|gitDiff|steering)(?::([^\s#]+))?/gi
const MAX_FILE_CHARS = 20_000
const MAX_FOLDER_ENTRIES = 60
const MAX_TOTAL_CHARS = 40_000
const MAX_REFERENCES = 10

export interface ResolvedContextRefs {
  /** Bloque listo para inyectar; vacío si no había referencias resolubles. */
  text: string
  sources: string[]
  /** Referencias declaradas que no pudieron resolverse. */
  missing: string[]
  /** Nombres de steering pedidos manualmente. */
  steeringNames: string[]
}

export function hasContextRefs(instruction: string): boolean {
  REFERENCE_RE.lastIndex = 0
  return REFERENCE_RE.test(instruction)
}

export async function resolveContextRefs(
  instruction: string,
  index: ProjectIndex,
  ideContext: IdeContextSnapshot | undefined,
): Promise<ResolvedContextRefs> {
  REFERENCE_RE.lastIndex = 0
  const matches = [...instruction.matchAll(REFERENCE_RE)].slice(0, MAX_REFERENCES)
  const empty: ResolvedContextRefs = { text: '', sources: [], missing: [], steeringNames: [] }
  if (!matches.length) return empty

  const sections: string[] = []
  const sources: string[] = []
  const missing: string[] = []
  const steeringNames: string[] = []
  const seen = new Set<string>()
  let budget = MAX_TOTAL_CHARS

  for (const match of matches) {
    const kind = match[1].toLowerCase()
    const target = match[2]?.trim()
    const key = `${kind}:${target || ''}`
    if (seen.has(key)) continue
    seen.add(key)

    if (kind === 'steering') {
      if (target) steeringNames.push(target)
      else missing.push('#steering')
      continue
    }

    const resolved = await resolveOne(kind, target, index, ideContext)
    if (!resolved) {
      missing.push(target ? `#${match[1]}:${target}` : `#${match[1]}`)
      continue
    }
    if (budget <= 0) break
    const block = resolved.text.slice(0, Math.min(resolved.limit, budget))
    sections.push(block)
    sources.push(resolved.source)
    budget -= block.length
  }

  return {
    text: sections.length
      ? `CONTEXTO SOLICITADO EXPLÍCITAMENTE POR EL USUARIO (prioritario):\n${sections.join('\n\n')}`
      : '',
    sources,
    missing,
    steeringNames,
  }
}

async function resolveOne(
  kind: string,
  target: string | undefined,
  index: ProjectIndex,
  ideContext: IdeContextSnapshot | undefined,
): Promise<{ text: string; source: string; limit: number } | undefined> {
  if (kind === 'problems') {
    const diagnostics = ideContext?.diagnostics || []
    if (!diagnostics.length) return { text: 'PROBLEMS: sin diagnósticos activos.', source: '#problems', limit: 200 }
    const lines = diagnostics.slice(0, 60).map((item) => `${item.severity} ${item.path}:${item.line} ${item.message}`)
    return { text: `PROBLEMS SOLICITADOS:\n${lines.join('\n')}`, source: '#problems', limit: 8_000 }
  }

  if (kind === 'gitdiff') {
    const diff = ideContext?.gitDiff?.trim()
    if (!diff) return { text: 'GIT DIFF: sin cambios registrados.', source: '#gitDiff', limit: 200 }
    return { text: `GIT DIFF SOLICITADO:\n\`\`\`diff\n${diff}\n\`\`\``, source: '#gitDiff', limit: 16_000 }
  }

  if (!target) return undefined

  if (kind === 'file') {
    const path = normalize(target)
    if (!path) return undefined
    const content = await index.readFile(path, MAX_FILE_CHARS)
    if (content === undefined) return undefined
    return {
      text: `ARCHIVO SOLICITADO ${path}:\n\`\`\`\n${content}\n\`\`\``,
      source: `#file:${path}`,
      limit: MAX_FILE_CHARS + 200,
    }
  }

  if (kind === 'folder') {
    const prefix = normalize(target)
    if (prefix === undefined) return undefined
    const files = index.listFiles(prefix, MAX_FOLDER_ENTRIES)
    if (!files.length) return undefined
    return {
      text: `CARPETA SOLICITADA ${prefix || '/'} (${files.length} archivo(s)):\n${files.join('\n')}`,
      source: `#folder:${prefix || '/'}`,
      limit: 6_000,
    }
  }

  return undefined
}

/** Sugerencias para el autocompletado del compositor. */
export async function suggestContextRefs(index: ProjectIndex, query: string): Promise<string[]> {
  const normalized = query.trim().toLowerCase()
  const statics = ['#problems', '#gitDiff']
  const suggestions = statics.filter((item) => !normalized || item.toLowerCase().includes(normalized))

  const paths = index.paths
  const files = paths
    .filter((path) => !normalized || path.toLowerCase().includes(normalized))
    .slice(0, 20)
    .map((path) => `#file:${path}`)

  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.length < 2) continue
    const folder = parts.slice(0, -1).join('/')
    if (!normalized || folder.toLowerCase().includes(normalized)) folders.add(`#folder:${folder}`)
    if (folders.size >= 12) break
  }

  const steering = await steeringSuggestions(normalized)
  return [...suggestions, ...steering, ...files, ...[...folders]].slice(0, 40)
}

async function steeringSuggestions(query: string): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return []
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, '.qapi', 'steering'))
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md'))
      .map(([name]) => `#steering:${name.replace(/\.md$/i, '')}`)
      .filter((item) => !query || item.toLowerCase().includes(query))
      .slice(0, 10)
  } catch {
    return []
  }
}

function normalize(value: string): string | undefined {
  const path = value.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
  if (path.includes('\0') || /^[a-zA-Z]:\//.test(path)) return undefined
  if (path.split('/').some((part) => part === '..')) return undefined
  return path
}
