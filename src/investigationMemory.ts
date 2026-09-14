// Memoria automática y acotada de investigación por workspace.
// Reutiliza lecturas verificadas por hash y descarta consultas al cambiar el índice.
import { createHash } from 'crypto'
import { ProjectIndex } from './projectIndex'
import { ChatTurn, InvestigationMemory } from './types'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'para', 'con', 'del', 'las', 'los',
  'una', 'uno', 'que', 'por', 'como', 'esto', 'esta', 'este', 'pero', 'sin', 'sobre', 'ahora',
])

export interface InvestigationRecall {
  text: string
  paths: string[]
}

export function synchronizeInvestigationMemory(index: ProjectIndex, memory: InvestigationMemory): void {
  if (index.indexing) return
  const fingerprint = index.fingerprint
  if (memory.indexFingerprint !== fingerprint) {
    memory.files = memory.files.filter((entry) => index.fileSnapshot(entry.path, 0)?.hash === entry.hash)
    // Los resultados list/search dependen del índice completo y se invalidan conservadoramente.
    memory.queries = []
  }
  memory.indexFingerprint = fingerprint
}

export function recallInvestigationMemory(
  index: ProjectIndex,
  memory: InvestigationMemory,
  instruction: string,
  history: ChatTurn[],
): InvestigationRecall {
  // El índice parcial no puede validar de forma fiable hashes ni consultas globales.
  if (index.indexing) return { text: '', paths: [] }
  synchronizeInvestigationMemory(index, memory)
  const recentRequests = history
    .filter((turn) => turn.role === 'user')
    .slice(-4)
    .map((turn) => turn.text)
    .join('\n')
  const queryTerms = terms(`${recentRequests}\n${instruction}`)

  const files = memory.files
    .map((entry) => ({
      entry,
      score: relevance(queryTerms, entry.path, 5) + relevance(queryTerms, entry.cues.join(' '), 3) + relevance(queryTerms, entry.content, 0.25),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, 4)

  const queries = memory.queries
    .map((entry) => ({
      entry,
      score: relevance(queryTerms, entry.cues.join(' '), 3) + relevance(queryTerms, entry.result, 0.2),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, 2)

  if (!files.length && !queries.length) return { text: '', paths: [] }
  const sections: string[] = [
    'MEMORIA AUTOMÁTICA DE INVESTIGACIÓN (vigente y validada contra el índice actual).',
    'Este contenido ya fue investigado. Reutilízalo y no repitas list_files, read_file o search_code salvo que falte un detalle exacto.',
  ]
  if (files.length) {
    sections.push('ARCHIVOS YA LEÍDOS:\n' + files.map(({ entry }) =>
      `— ${entry.path} [sha256:${entry.hash.slice(0, 12)}]\n\`\`\`\n${entry.content.slice(0, 6_000)}\n\`\`\``,
    ).join('\n\n'))
  }
  if (queries.length) {
    sections.push('CONSULTAS YA REALIZADAS:\n' + queries.map(({ entry }) =>
      `— ${entry.kind} [resultado validado]\n${entry.result.slice(0, 4_000)}`,
    ).join('\n\n'))
  }
  return {
    text: sections.join('\n\n').slice(0, 30_000),
    paths: files.map((item) => item.entry.path),
  }
}

export function cachedReadToolResult(
  index: ProjectIndex,
  memory: InvestigationMemory,
  name: string,
  args: Record<string, any>,
): string | undefined {
  if (index.indexing) return undefined
  // Revalida el fingerprint en cada hit para cubrir cambios ocurridos dentro del turno actual.
  synchronizeInvestigationMemory(index, memory)

  if (name === 'read_file') {
    const path = cleanPath(String(args?.path || ''))
    const entry = memory.files.find((item) => item.path === path)
    if (!entry) return undefined
    const current = index.fileSnapshot(path, 0)
    if (!current || current.hash !== entry.hash) {
      memory.files = memory.files.filter((item) => item.path !== path)
      return undefined
    }
    touch(entry, '')
    return `read_file(${path}) [memoria automática validada]:\n\`\`\`\n${entry.content}\n\`\`\``
  }
  if (name === 'list_files' || name === 'search_code') {
    const key = queryKey(name, args)
    const entry = memory.queries.find((item) => item.key === key)
    if (!entry) return undefined
    touch(entry, '')
    return entry.result
  }
  return undefined
}

export function rememberFileRead(
  index: ProjectIndex,
  memory: InvestigationMemory,
  pathValue: string,
  redactedContent: string,
  cue: string,
): void {
  if (index.indexing) return
  const path = cleanPath(pathValue)
  const snapshot = index.fileSnapshot(path, 0)
  if (!snapshot) return
  const existing = memory.files.find((entry) => entry.path === path)
  const next = existing || { path, hash: snapshot.hash, content: '', cues: [], updatedAt: Date.now() }
  next.hash = snapshot.hash
  next.content = redactInvestigationText(redactedContent).slice(0, 20_000)
  touch(next, cue)
  memory.files = [next, ...memory.files.filter((entry) => entry.path !== path)].slice(0, 18)
  memory.indexFingerprint = index.fingerprint
}

export function rememberQueryResult(
  index: ProjectIndex,
  memory: InvestigationMemory,
  name: 'list_files' | 'search_code',
  args: Record<string, any>,
  result: string,
  cue: string,
): void {
  if (index.indexing) return
  const key = queryKey(name, args)
  const existing = memory.queries.find((entry) => entry.key === key)
  const next = existing || { kind: name, key, result: '', cues: [], updatedAt: Date.now() }
  next.result = redactInvestigationText(result).slice(0, 12_000)
  touch(next, cue)
  memory.queries = [next, ...memory.queries.filter((entry) => entry.key !== key)].slice(0, 12)
  memory.indexFingerprint = index.fingerprint
}

function queryKey(name: string, args: Record<string, any>): string {
  const canonicalValue = name === 'list_files'
    ? cleanPath(String(args?.prefix || '/')) || '/'
    : String(args?.query || '').trim()
  const hash = createHash('sha256').update(canonicalValue).digest('hex')
  return `${name}:sha256:${hash}`
}

function touch(entry: { cues: string[]; updatedAt: number }, cue: string): void {
  const safeCue = redactInvestigationText(cue.trim()).slice(0, 500)
  if (safeCue) entry.cues = [...entry.cues.filter((item) => item !== safeCue), safeCue].slice(-3)
  entry.updatedAt = Date.now()
}

function cleanPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
}

function redactInvestigationText(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
}

function terms(value: string): Set<string> {
  const found = value.toLowerCase().match(/[a-záéíóúñ0-9_./-]{3,}/gi) || []
  return new Set(found.filter((term) => !STOP_WORDS.has(term)).slice(0, 2_000))
}

function relevance(query: Set<string>, value: string, weight: number): number {
  if (!value || !query.size) return 0
  const candidate = terms(value)
  let matches = 0
  for (const term of query) if (candidate.has(term)) matches++
  return matches * weight
}
