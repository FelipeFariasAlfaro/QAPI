import type { ProjectIndex } from './projectIndex'
import type { TraceabilitySummary } from './types'

const MAX_GAPS = 20
const MAX_EVIDENCE = 24
const MAX_ITEM_LENGTH = 240

const SCENARIO_RE = /^\s*(?:Scenario(?:\s+(?:Outline|Template))?|Example|Escenario|Ejemplo|Esquema\s+del\s+escenario)\s*:/i
const STEP_RE = /^\s*(?:Given|When|Then|And|But|\*|Dado|Dada|Dados|Dadas|Cuando|Entonces|Y|E|Pero)\s+(.+?)\s*$/i
/**
 * IDs de requisito con forma de ticket (`@ABC-123`, `REQ-12`) o el tag `@REQ`.
 * Sensible a mayúsculas y precedido de espacio: antes `user@foo-bar.com` o el
 * tag `@smoke-test` aparecían como requisitos.
 */
const REQUIREMENT_RE = /(?:^|[\s(,])@([A-Z][A-Z0-9]*-\d+)\b|(?:^|[\s(,])@(REQ)\b|\b(REQ-[A-Z0-9][A-Z0-9-]*)\b/g

interface IndexedFile {
  path: string
  content: string
}

interface FeatureAnalysis {
  path: string
  scenarios: number
  steps: string[]
  requirements: string[]
}

/**
 * Builds a best-effort traceability view from files already known by the project
 * index. The result is deliberately static evidence: it does not claim that a
 * scenario, test or step has executed successfully.
 */
export async function buildTraceability(index: ProjectIndex): Promise<TraceabilitySummary> {
  // El contenido ya está en memoria en el índice: antes se releían hasta 1500
  // archivos desde disco en paralelo (lento y con riesgo de EMFILE) y se
  // truncaban a 20k caracteres.
  const paths = [...new Set(index.paths)].sort((a, b) => a.localeCompare(b))
  const files = paths
    .map((path): IndexedFile | undefined => {
      const snapshot = index.fileSnapshot(path, 400_000)
      return snapshot ? { path, content: snapshot.content } : undefined
    })
    .filter((file): file is IndexedFile => file !== undefined)
  const requirementsByPath = new Map(files.map((file) => [file.path, requirementCandidates(file)]))

  const featureFiles = files.filter((file) => file.path.toLowerCase().endsWith('.feature'))
  const features = featureFiles.map(analyzeFeature)
  const steps = features.flatMap((feature) => feature.steps)
  const definitions = safeStepDefinitions(index)
  const normalizedDefinitions = new Set(
    definitions.map((definition) => normalizeStep(definition.pattern)).filter(Boolean),
  )
  const linkedSteps = steps.reduce(
    (total, step) => total + (normalizedDefinitions.has(normalizeStep(step)) ? 1 : 0),
    0,
  )

  const testFiles = files.filter((file) => isTestPath(file.path))
  const requirementSources = collectRequirementSources(files, requirementsByPath)
  const requirements = [...requirementSources.keys()].sort(naturalCompare)
  const gaps: string[] = []
  const evidence: string[] = [
    'Evidencia estática inferida a partir de rutas y contenido indexado; no representa cobertura ni ejecución runtime.',
    `${featureFiles.length} archivo(s) Gherkin analizado(s), ${definitions.length} definición(es) de step y ${testFiles.length} archivo(s) de prueba detectado(s).`,
    `${linkedSteps} de ${steps.length} step(s) Gherkin enlazado(s) por coincidencia normalizada con una definición.`,
  ]

  if (requirements.length === 0) {
    addBounded(gaps, 'No se detectaron tags o IDs de requisito (@REQ, @ABC-123 o REQ-123).', MAX_GAPS)
  } else {
    for (const requirement of requirements) {
      const sources = requirementSources.get(requirement) || []
      addBounded(evidence, `Requisito ${requirement}: ${summarizePaths(sources)}.`, MAX_EVIDENCE)
    }
  }

  if (features.length === 0) {
    addBounded(gaps, 'No se detectaron archivos .feature con escenarios Gherkin.', MAX_GAPS)
  } else if (features.every((feature) => feature.scenarios === 0)) {
    addBounded(gaps, 'Los archivos .feature detectados no contienen Scenario/Escenario.', MAX_GAPS)
  }

  if (steps.length > 0 && definitions.length === 0) {
    addBounded(gaps, 'Hay steps Gherkin, pero no se detectaron definiciones de steps.', MAX_GAPS)
  } else {
    const unmatched = unique(steps.filter((step) => !normalizedDefinitions.has(normalizeStep(step))))
    for (const step of unmatched) {
      addBounded(gaps, `Step sin definición normalizada: "${step}".`, MAX_GAPS)
    }
  }

  if (testFiles.length === 0) {
    addBounded(gaps, 'No se detectaron archivos de prueba por ruta, nombre o extensión.', MAX_GAPS)
  } else {
    for (const test of testFiles.slice(0, 8)) {
      const relations = relatedPaths(test, files, requirementsByPath)
      addBounded(
        evidence,
        relations.length > 0
          ? `Prueba ${test.path}: relación estática con ${summarizePaths(relations)}.`
          : `Prueba detectada por ruta/extensión: ${test.path}.`,
        MAX_EVIDENCE,
      )
    }
  }

  const featureRequirements = new Set(features.flatMap((feature) => feature.requirements))
  for (const requirement of requirements) {
    if (!featureRequirements.has(requirement)) {
      addBounded(gaps, `Requisito ${requirement} sin vínculo explícito a un archivo .feature.`, MAX_GAPS)
    }
  }

  return {
    generatedAt: Date.now(),
    requirements,
    scenarios: features.reduce((total, feature) => total + feature.scenarios, 0),
    steps: steps.length,
    stepDefinitions: definitions.length,
    tests: testFiles.length,
    linkedSteps,
    gaps,
    evidence,
  }
}

/** Formats a traceability summary for agent context or a compact text view. */
export function formatTraceability(summary: TraceabilitySummary): string {
  const requirements = summary.requirements.length > 0 ? summary.requirements.join(', ') : 'ninguno'
  const gaps = summary.gaps.length > 0
    ? summary.gaps.map((gap) => `- ${gap}`).join('\n')
    : '- Sin huecos estáticos detectados.'
  const evidence = summary.evidence.length > 0
    ? summary.evidence.map((item) => `- ${item}`).join('\n')
    : '- Sin evidencia indexada.'

  return [
    '## Trazabilidad — evidencia estática inferida (no cobertura runtime)',
    `Generada: ${new Date(summary.generatedAt).toISOString()}`,
    `Totales: ${summary.requirements.length} requisito(s), ${summary.scenarios} escenario(s), ${summary.steps} step(s), ${summary.stepDefinitions} definición(es), ${summary.tests} prueba(s), ${summary.linkedSteps} step(s) enlazado(s).`,
    `Requisitos: ${requirements}`,
    'Huecos:',
    gaps,
    'Evidencia:',
    evidence,
  ].join('\n')
}

function analyzeFeature(file: IndexedFile): FeatureAnalysis {
  let scenarios = 0
  const steps: string[] = []
  let inDocString = false
  for (const rawLine of file.content.split(/\r?\n/)) {
    const line = rawLine.trim()
    // Las líneas dentro de docstrings ("""/```) no son steps.
    if (line.startsWith('"""') || line.startsWith('```')) { inDocString = !inDocString; continue }
    if (inDocString || !line || line.startsWith('#') || line.startsWith('|')) continue
    if (SCENARIO_RE.test(line)) scenarios++
    const step = line.match(STEP_RE)
    if (step) steps.push(step[1].trim())
  }
  return {
    path: file.path,
    scenarios,
    steps,
    requirements: extractRequirements(file.content),
  }
}

function safeStepDefinitions(index: ProjectIndex): { pattern: string; file: string }[] {
  try {
    const definitions = index.stepDefinitions()
    return Array.isArray(definitions)
      ? definitions.filter((definition) => definition && typeof definition.pattern === 'string')
      : []
  } catch {
    return []
  }
}

/** Sólo .feature, pruebas y documentación pueden declarar requisitos (no lockfiles ni JSON). */
function requirementCandidates(file: IndexedFile): string[] {
  if (!/\.(?:feature|md)$/i.test(file.path) && !isTestPath(file.path)) return []
  return extractRequirements(file.content)
}

function collectRequirementSources(files: IndexedFile[], byPath: Map<string, string[]>): Map<string, string[]> {
  const sources = new Map<string, string[]>()
  for (const file of files) {
    for (const requirement of byPath.get(file.path) || []) {
      const paths = sources.get(requirement) || []
      if (!paths.includes(file.path)) paths.push(file.path)
      sources.set(requirement, paths)
    }
  }
  return sources
}

function extractRequirements(content: string): string[] {
  const requirements: string[] = []
  REQUIREMENT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = REQUIREMENT_RE.exec(content)) !== null) {
    const requirement = (match[1] || match[2] || match[3] || '').toUpperCase()
    if (requirement && !requirements.includes(requirement)) requirements.push(requirement)
  }
  return requirements
}

function normalizeStep(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\s*(?:given|when|then|and|but|dado|dada|dados|dadas|cuando|entonces|y|pero)\s+/, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' value ')
    .replace(/<[^>]+>|\{[^}]+\}|\(\?p?<[^>]+>[^)]*\)|\([^)]*[+*][^)]*\)/gi, ' value ')
    .replace(/\b-?\d+(?:[.,]\d+)?\b/g, ' value ')
    .replace(/\\[wds][+*?]?/gi, ' value ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function isTestPath(path: string): boolean {
  const normalized = `/${path.toLowerCase().replace(/\\/g, '/')}`
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (name.endsWith('.robot')) return true
  if (/\.(?:test|spec|cy)\.[cm]?[jt]sx?$/.test(name)) return true
  if (/^test_.+\.py$|^.+_test\.py$/.test(name)) return true
  return /\/(?:tests?|specs?|__tests__|e2e|integration)(?:\/|$)/.test(normalized)
}

function relatedPaths(test: IndexedFile, files: IndexedFile[], requirementsByPath: Map<string, string[]>): string[] {
  const related = new Set<string>()
  const testStem = pathStem(test.path)
  const testRequirements = new Set(requirementsByPath.get(test.path) || [])

  for (const candidate of files) {
    if (candidate.path === test.path || isTestPath(candidate.path)) continue
    const candidateStem = pathStem(candidate.path)
    // Igualdad de nombre base (o prefijo seguido de separador): "app" ya no se
    // relaciona con "application_test".
    const sameBase = Boolean(testStem && candidateStem && candidateStem.length >= 3 && (
      testStem === candidateStem || testStem.startsWith(`${candidateStem}_`) || testStem.startsWith(`${candidateStem}-`)
    ))
    const imported = importsPath(test.content, candidate.path)
    const sharedRequirement = testRequirements.size > 0
      && (requirementsByPath.get(candidate.path) || []).some((requirement) => testRequirements.has(requirement))
    if (sameBase || imported || sharedRequirement) related.add(candidate.path)
    if (related.size >= 4) break
  }
  return [...related]
}

function pathStem(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() || ''
  return name
    .toLowerCase()
    .replace(/\.(?:feature|robot|py|[cm]?[jt]sx?)$/, '')
    .replace(/(?:[._-](?:test|spec|cy|steps?))+$/g, '')
}

function importsPath(content: string, candidatePath: string): boolean {
  const normalizedContent = content.replace(/\\/g, '/').toLowerCase()
  const withoutExtension = candidatePath.replace(/\\/g, '/').replace(/\.[^.\/]+$/, '').toLowerCase()
  const basename = withoutExtension.split('/').pop() || ''
  if (!basename || basename.length < 2) return false
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Límites de palabra: antes `import a` coincidía con `import axios`.
  return new RegExp(`/${escaped}(?:\\.[\\w]+)?['"]|from\\s+[\\w.]*\\b${escaped}\\s+import\\b|\\bimport\\s+[\\w.]*\\b${escaped}\\b(?![\\w-])`).test(normalizedContent)
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 0) return 'sin rutas relacionadas'
  const shown = paths.slice(0, 3)
  return shown.join(', ') + (paths.length > shown.length ? ` (+${paths.length - shown.length})` : '')
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = normalizeStep(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function addBounded(target: string[], value: string, limit: number): void {
  if (target.length >= limit) return
  const compact = value.replace(/\s+/g, ' ').trim()
  target.push(compact.length > MAX_ITEM_LENGTH ? `${compact.slice(0, MAX_ITEM_LENGTH - 1)}…` : compact)
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
