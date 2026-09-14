// Steering: reglas y convenciones versionables del equipo.
//
// Los archivos viven en `.qapi/steering/*.md` y declaran cuándo aplican mediante
// front-matter. A diferencia de la memoria editable (un único texto siempre
// inyectado), el steering permite reglas con alcance: sólo entran al prompt
// cuando el contexto actual las hace pertinentes.
import * as vscode from 'vscode'
import { IdeContextSnapshot, SteeringInclusion, SteeringRule } from './types'

const STEERING_DIR = '.qapi/steering'
const MAX_RULE_CHARS = 6_000
const MAX_TOTAL_CHARS = 12_000
const MAX_RULES = 24
const MAX_REFERENCE_CHARS = 2_000
const MAX_REFERENCES_PER_RULE = 3

/** Lee y parsea todas las reglas declaradas en el workspace. */
export async function loadSteeringRules(): Promise<SteeringRule[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return []
  const dir = vscode.Uri.joinPath(root, STEERING_DIR)
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(dir)
  } catch {
    return []
  }

  const rules: SteeringRule[] = []
  for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) continue
    if (rules.length >= MAX_RULES) break
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))
      const raw = Buffer.from(bytes).toString('utf8')
      const parsed = parseRule(name, raw)
      if (parsed.body.trim()) rules.push(parsed)
    } catch { /* archivo ilegible: se omite */ }
  }
  return rules
}

export interface SteeringSelection {
  text: string
  sources: string[]
}

/**
 * Elige las reglas aplicables al turno actual.
 *
 * `always` entra siempre; `fileMatch` sólo si algún archivo en juego coincide con
 * su patrón; `manual` sólo si el usuario la nombró explícitamente.
 */
export async function selectSteering(
  rules: SteeringRule[],
  ideContext: IdeContextSnapshot | undefined,
  manualNames: string[] = [],
): Promise<SteeringSelection> {
  if (!rules.length) return { text: '', sources: [] }
  const manual = new Set(manualNames.map((name) => normalizeName(name)))
  const candidatePaths = contextPaths(ideContext)

  const applicable = rules.filter((rule) => {
    if (manual.has(normalizeName(rule.name))) return true
    if (rule.inclusion === 'always') return true
    if (rule.inclusion === 'fileMatch') return candidatePaths.some((path) => matchesGlob(path, rule.fileMatchPattern))
    return false
  })
  if (!applicable.length) return { text: '', sources: [] }

  const priority: Record<SteeringInclusion, number> = { always: 0, fileMatch: 1, manual: 2 }
  applicable.sort((a, b) => priority[a.inclusion] - priority[b.inclusion] || a.name.localeCompare(b.name))

  const sections: string[] = []
  const sources: string[] = []
  let budget = MAX_TOTAL_CHARS
  for (const rule of applicable) {
    if (budget <= 0) break
    const body = await expandReferences(rule.body)
    const block = `— ${rule.name} (${rule.inclusion})\n${body}`.slice(0, Math.min(MAX_RULE_CHARS, budget))
    sections.push(block)
    sources.push(`steering:${rule.name}`)
    budget -= block.length
  }

  return {
    text: `STEERING DEL PROYECTO (reglas del equipo, obligatorias salvo conflicto con las reglas del sistema):\n${sections.join('\n\n')}`,
    sources,
  }
}

/** Resuelve `#[[file:ruta]]` a contenido real, sin recursión. */
async function expandReferences(body: string): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  const pattern = /#\[\[file:([^\]]+)\]\]/g
  const matches = [...body.matchAll(pattern)].slice(0, MAX_REFERENCES_PER_RULE)
  if (!root || !matches.length) return body.replace(pattern, '')

  let expanded = body
  for (const match of matches) {
    const relative = safeRelative(match[1])
    let replacement = `[referencia no resuelta: ${match[1].trim()}]`
    if (relative) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, relative))
        const content = Buffer.from(bytes).toString('utf8').slice(0, MAX_REFERENCE_CHARS)
        replacement = `referencia ${relative}:\n\`\`\`\n${content}\n\`\`\``
      } catch { /* se conserva el aviso de no resuelta */ }
    }
    expanded = expanded.replace(match[0], replacement)
  }
  return expanded.replace(pattern, '')
}

function parseRule(fileName: string, raw: string): SteeringRule {
  const name = fileName.replace(/\.md$/i, '')
  const frontMatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!frontMatter) return { name, inclusion: 'always', body: raw.trim() }

  const body = raw.slice(frontMatter[0].length).trim()
  const declared = frontMatter[1].match(/^\s*inclusion\s*:\s*["']?([\w-]+)["']?\s*$/im)?.[1]?.toLowerCase()
  const inclusion: SteeringInclusion = declared === 'filematch' ? 'fileMatch' : declared === 'manual' ? 'manual' : 'always'
  const pattern = frontMatter[1].match(/^\s*fileMatchPattern\s*:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim()
  // Una regla fileMatch sin patrón usable nunca debe activarse por accidente.
  if (inclusion === 'fileMatch' && !pattern) return { name, inclusion: 'manual', body }
  return { name, inclusion, body, fileMatchPattern: pattern }
}

function contextPaths(ideContext?: IdeContextSnapshot): string[] {
  if (!ideContext) return []
  const paths = new Set<string>()
  if (ideContext.activeFile?.path) paths.add(ideContext.activeFile.path)
  if (ideContext.selection?.path) paths.add(ideContext.selection.path)
  for (const path of ideContext.visibleFiles) paths.add(path)
  for (const path of ideContext.changedFiles) paths.add(path)
  return [...paths].map((path) => path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, ''))
}

/** Soporte acotado de globs: `**`, `*` y `?`, suficiente para rutas y extensiones. */
function matchesGlob(path: string, pattern?: string): boolean {
  if (!pattern) return false
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
  if (!normalized) return false
  const source = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  try {
    return new RegExp(`^${source}$`, 'i').test(path)
  } catch {
    return false
  }
}

function safeRelative(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
  if (!normalized || normalized.includes('\0') || /^[a-zA-Z]:\//.test(normalized)) return undefined
  if (normalized.split('/').some((part) => part === '..')) return undefined
  return normalized
}

function normalizeName(value: string): string {
  return value.trim().replace(/\.md$/i, '').toLowerCase()
}
