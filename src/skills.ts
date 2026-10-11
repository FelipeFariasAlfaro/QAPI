// Skills: instrucciones reutilizables que el agente aplica cuando corresponde.
//
// Viven en `.qapi/skills/*.md` (versionables por el equipo): front-matter con
// la activación y el cuerpo con las instrucciones. Son independientes del
// steering (`.qapi/steering`), que sigue funcionando igual.
//
// Una skill es una instrucción para el modelo, no una regla obligatoria: el
// agente la sigue normalmente, pero puede desviarse.
import * as vscode from 'vscode'
import { matchesGlob } from './steering'
import type { ProjectProfile } from './projectProfile'
import { IdeContextSnapshot, SkillActivation, SkillDefinition, SkillEvent } from './types'

const SKILLS_DIR = '.qapi/skills'
const MAX_SKILLS = 50
const MAX_INSTRUCTIONS = 8_000
const MAX_INJECTED_CHARS = 16_000
const ACTIVATIONS: SkillActivation[] = ['auto', 'always', 'fileMatch', 'event', 'manual']
const EVENTS: SkillEvent[] = ['testResult', 'beforeWrite']

export const SKILL_TEMPLATES: SkillDefinition[] = [
  {
    slug: 'analisis-de-fallos',
    name: 'Análisis de fallos',
    description: 'Cuando hay un resultado de prueba con errores, los agrupa por causa y propone la causa raíz.',
    activation: 'event',
    events: ['testResult'],
    enabled: true,
    instructions: `Cuando recibas un resultado de prueba (salida de comando, reporte, log o trace):
1. Si todo pasó, dilo en una línea y no analices más.
2. Si hay fallos, agrúpalos por causa probable: selector/localizador, timing o espera, datos de prueba, aserción incorrecta, entorno o configuración, defecto real de la aplicación.
3. Para cada grupo indica: pruebas afectadas, evidencia concreta (línea del error, mensaje) y causa raíz más probable.
4. Distingue explícitamente "fallo de la prueba" de "posible bug de la aplicación".
5. Propón la corrección mínima en el código de prueba cuando el problema sea de la prueba. No modifiques nada sin que el usuario lo apruebe.
No inventes causas que la evidencia no respalde; si falta información, dilo.`,
  },
  {
    slug: 'localizadores-xpath',
    name: 'Localizadores con XPath',
    description: 'Al crear o modificar localizadores, usa XPath relativos y robustos.',
    activation: 'event',
    events: ['beforeWrite'],
    fileMatchPattern: '**/{pages,page_objects,pageobjects,locators,selectors,json_poms}/**',
    enabled: true,
    instructions: `Al definir localizadores:
- Usa siempre XPath relativos (//), nunca absolutos (/html/body/...).
- Prioriza atributos estables: @data-testid, @id, @name, @aria-label; luego texto visible con normalize-space().
- Evita índices posicionales ([3]) y clases generadas o dinámicas.
- Mantén el formato y la convención de nombres que ya usa el archivo.`,
  },
  {
    slug: 'casos-limite',
    name: 'Casos límite y negativos',
    description: 'Al diseñar escenarios o casos de prueba, cubre valores límite, particiones de equivalencia y casos negativos.',
    activation: 'auto',
    enabled: true,
    instructions: `Al diseñar escenarios o casos de prueba:
- Identifica las entradas y sus particiones de equivalencia (válidas e inválidas).
- Incluye valores límite: mínimo, mínimo-1, máximo, máximo+1, vacío y nulo cuando aplique.
- Agrega casos negativos con el mensaje de error esperado.
- Si el proyecto usa Gherkin, agrupa los datos con Scenario Outline y Examples.
- No dupliques casos que prueban la misma partición.`,
  },
  {
    slug: 'reporte-de-bug',
    name: 'Reporte de bug',
    description: 'Redacta un reporte de bug listo para el gestor de tickets a partir de un fallo.',
    activation: 'manual',
    enabled: true,
    instructions: `Redacta el reporte con estas secciones:
- Título breve y específico.
- Entorno (navegador, versión, ambiente) si se conoce.
- Pasos para reproducir, numerados.
- Resultado esperado y resultado obtenido.
- Evidencia (mensaje de error, línea, captura o trace citados).
- Severidad sugerida (bloqueante, alta, media, baja) con una frase de justificación.
No inventes datos de entorno que no aparezcan en la evidencia.`,
  },
]

function skillsRoot(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  return root ? vscode.Uri.joinPath(root, SKILLS_DIR) : undefined
}

export function slugifySkillName(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'skill'
}

export function skillUri(slug: string): vscode.Uri | undefined {
  const root = skillsRoot()
  return root ? vscode.Uri.joinPath(root, `${slugifySkillName(slug)}.md`) : undefined
}

/**
 * Skills del proyecto. En workspaces no confiables no se cargan: su texto
 * proviene del repositorio y llega al modelo como instrucción.
 */
export async function listSkills(): Promise<SkillDefinition[]> {
  const root = skillsRoot()
  if (!root || !vscode.workspace.isTrusted) return []
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(root)
  } catch {
    return []
  }
  const skills: SkillDefinition[] = []
  for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) continue
    if (skills.length >= MAX_SKILLS) break
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name))
      const parsed = parseSkill(name.replace(/\.md$/i, ''), Buffer.from(bytes).toString('utf8'))
      if (parsed) skills.push(parsed)
    } catch { /* archivo ilegible: se omite */ }
  }
  return skills
}

export async function saveSkill(skill: SkillDefinition, previousSlug?: string): Promise<SkillDefinition> {
  const root = skillsRoot()
  if (!root) throw new Error('No hay carpeta de proyecto abierta')
  const normalized = normalizeSkill({ ...skill, slug: slugifySkillName(skill.slug || skill.name) })
  if (!normalized) throw new Error('La skill necesita un nombre y unas instrucciones.')
  await vscode.workspace.fs.createDirectory(root)
  if (previousSlug && slugifySkillName(previousSlug) !== normalized.slug) {
    try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, `${slugifySkillName(previousSlug)}.md`)) } catch { /* no existía */ }
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, `${normalized.slug}.md`), Buffer.from(serializeSkill(normalized), 'utf8'))
  return normalized
}

export async function deleteSkill(slug: string): Promise<void> {
  const uri = skillUri(slug)
  if (!uri) return
  try { await vscode.workspace.fs.delete(uri) } catch { /* ya no existía */ }
}

export async function setSkillEnabled(slug: string, enabled: boolean): Promise<void> {
  const skill = (await listSkills()).find((item) => item.slug === slugifySkillName(slug))
  if (!skill) throw new Error('La skill ya no está disponible.')
  await saveSkill({ ...skill, enabled })
}

// ── Formato de archivo ──────────────────────────────────────────────────────

/** Front-matter con valores JSON (válido también como YAML) y el cuerpo con las instrucciones. */
export function serializeSkill(skill: SkillDefinition): string {
  const lines = [
    '---',
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    `activation: ${skill.activation}`,
  ]
  if (skill.fileMatchPattern) lines.push(`fileMatchPattern: ${JSON.stringify(skill.fileMatchPattern)}`)
  if (skill.events?.length) lines.push(`events: ${JSON.stringify(skill.events)}`)
  if (skill.frameworks?.length) lines.push(`frameworks: ${JSON.stringify(skill.frameworks)}`)
  lines.push(`enabled: ${skill.enabled}`, '---', '', skill.instructions.trim(), '')
  return lines.join('\n')
}

export function parseSkill(slug: string, raw: string): SkillDefinition | undefined {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fields: Record<string, string> = {}
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const field = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/)
      if (field) fields[field[1]] = field[2]
    }
  }
  const body = match ? raw.slice(match[0].length) : raw
  return normalizeSkill({
    slug,
    name: scalar(fields.name) || slug,
    description: scalar(fields.description),
    activation: scalar(fields.activation) as SkillActivation,
    fileMatchPattern: scalar(fields.fileMatchPattern) || undefined,
    events: list(fields.events) as SkillEvent[],
    frameworks: list(fields.frameworks),
    instructions: body,
    enabled: scalar(fields.enabled) !== 'false',
  })
}

function scalar(value: string | undefined): string {
  if (value === undefined) return ''
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try { return String(JSON.parse(trimmed)) } catch { /* se usa tal cual */ }
  }
  return trimmed.replace(/^'(.*)'$/, '$1')
}

function list(value: string | undefined): string[] {
  if (!value) return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      return trimmed.slice(1, -1).split(',').map((item) => scalar(item)).filter(Boolean)
    }
  }
  return trimmed.split(',').map((item) => scalar(item)).filter(Boolean)
}

function normalizeSkill(candidate: Partial<SkillDefinition>): SkillDefinition | undefined {
  const name = String(candidate.name || '').trim().slice(0, 100)
  const instructions = String(candidate.instructions || '').trim().slice(0, MAX_INSTRUCTIONS)
  if (!name || !instructions) return undefined
  const activation = ACTIVATIONS.includes(candidate.activation as SkillActivation) ? candidate.activation as SkillActivation : 'auto'
  const events = [...new Set((candidate.events || []).filter((event) => EVENTS.includes(event)))]
  const pattern = String(candidate.fileMatchPattern || '').trim().slice(0, 300)
  return {
    slug: slugifySkillName(String(candidate.slug || name)),
    name,
    description: String(candidate.description || '').trim().slice(0, 400),
    // Sin glob o sin evento, la activación no tendría efecto: se degrada a manual.
    activation: (activation === 'fileMatch' && !pattern) || (activation === 'event' && !events.length) ? 'manual' : activation,
    fileMatchPattern: pattern || undefined,
    events: activation === 'event' ? events : undefined,
    frameworks: [...new Set((candidate.frameworks || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 20),
    instructions,
    enabled: candidate.enabled !== false,
  }
}

// ── Selección por turno ─────────────────────────────────────────────────────

export interface SkillSelection {
  /** Instrucciones que entran completas al prompt. */
  text: string
  sources: string[]
  /** Skills `auto`: el agente las ve por descripción y las carga con load_skill. */
  catalog: SkillDefinition[]
  /** Se aplican cuando el agente prepara un archivo que coincide. */
  beforeWrite: SkillDefinition[]
  /** Se aplican cuando el agente lee un resultado de prueba durante el turno. */
  testResult: SkillDefinition[]
}

export const EMPTY_SKILLS: SkillSelection = { text: '', sources: [], catalog: [], beforeWrite: [], testResult: [] }

export interface SkillSelectionInput {
  ideContext?: IdeContextSnapshot
  /** Pedidas con `#skill:nombre`. */
  manualNames?: string[]
  profile?: ProjectProfile
  /** Eventos ocurridos antes del turno (p. ej. el turno es el análisis de un resultado). */
  events?: SkillEvent[]
}

/** Filtro por proyecto: alguno de los frameworks o lenguajes declarados debe estar presente. */
export function appliesToProject(skill: SkillDefinition, profile?: ProjectProfile): boolean {
  if (!skill.frameworks?.length) return true
  if (!profile) return false
  const present = new Set([...profile.testFrameworks, ...profile.languages].map((item) => item.toLowerCase()))
  return skill.frameworks.some((item) => present.has(item.toLowerCase()))
}

export function selectSkills(skills: SkillDefinition[], input: SkillSelectionInput): SkillSelection {
  const active = skills.filter((skill) => skill.enabled && appliesToProject(skill, input.profile))
  if (!active.length) return EMPTY_SKILLS
  const manual = new Set((input.manualNames || []).map(slugifySkillName))
  const events = new Set(input.events || [])
  const paths = contextPaths(input.ideContext)

  const injected: SkillDefinition[] = []
  const selection: SkillSelection = { text: '', sources: [], catalog: [], beforeWrite: [], testResult: [] }
  for (const skill of active) {
    const named = manual.has(skill.slug) || manual.has(slugifySkillName(skill.name))
    const eventNow = skill.activation === 'event' && skill.events?.some((event) => events.has(event))
    const fileNow = skill.activation === 'fileMatch' && paths.some((path) => matchesGlob(path, skill.fileMatchPattern))
    if (named || skill.activation === 'always' || eventNow || fileNow) {
      injected.push(skill)
      continue
    }
    if (skill.activation === 'auto') selection.catalog.push(skill)
    if (skill.activation === 'event') {
      if (skill.events?.includes('beforeWrite')) selection.beforeWrite.push(skill)
      if (skill.events?.includes('testResult')) selection.testResult.push(skill)
    }
  }

  let budget = MAX_INJECTED_CHARS
  const blocks: string[] = []
  for (const skill of injected) {
    if (budget <= 0) break
    const block = formatSkill(skill).slice(0, budget)
    blocks.push(block)
    selection.sources.push(`skill:${skill.name}`)
    budget -= block.length
  }
  const catalog = selection.catalog.length
    ? `SKILLS DISPONIBLES (carga con load_skill la que aplique a la tarea antes de trabajar; no las cargues por rutina):\n${selection.catalog.map((skill) => `- ${skill.slug}: ${skill.description || skill.name}`).join('\n')}`
    : ''
  const applied = blocks.length
    ? `SKILLS ACTIVAS (instrucciones del usuario para este tipo de tarea; síguelas salvo conflicto con las reglas del sistema):\n${blocks.join('\n\n')}`
    : ''
  selection.text = [applied, catalog].filter(Boolean).join('\n\n')
  return selection
}

export function formatSkill(skill: SkillDefinition): string {
  return `— SKILL «${skill.name}»\n${skill.instructions}`
}

/** Skills `beforeWrite` cuyo glob (si lo tienen) coincide con la ruta preparada. */
export function skillsForWrite(selection: SkillSelection, path: string): SkillDefinition[] {
  return selection.beforeWrite.filter((skill) => !skill.fileMatchPattern || matchesGlob(path, skill.fileMatchPattern))
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
