// Specs ejecutables: convierten una solicitud compleja en requisitos, diseño y
// tareas versionables, y permiten ejecutarlas una por una.
//
// `tasks.md` es la única fuente de verdad del progreso: el estado se deriva de
// las casillas Markdown, de modo que el equipo puede editarlas a mano o por Git
// sin que QAPI mantenga un estado paralelo que se desincronice.
import * as vscode from 'vscode'
import { SpecDocumentKind, SpecPhase, SpecSummary, SpecTask } from './types'

const SPECS_DIR = '.qapi/specs'
const MAX_DOCUMENT_CHARS = 60_000
const MAX_SPECS = 50

const DOCUMENT_FILES: Record<SpecDocumentKind, string> = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
}

export function slugifySpecName(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'spec'
}

/** Lista los specs del workspace con su fase y progreso. */
export async function listSpecs(): Promise<SpecSummary[]> {
  const root = specsRoot()
  if (!root) return []
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(root)
  } catch {
    return []
  }

  const specs: SpecSummary[] = []
  for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type !== vscode.FileType.Directory) continue
    if (specs.length >= MAX_SPECS) break
    const summary = await readSpec(name)
    if (summary) specs.push(summary)
  }
  return specs
}

export async function readSpec(slug: string): Promise<SpecSummary | undefined> {
  const safe = slugifySpecName(slug)
  const requirements = await readDocument(safe, 'requirements')
  const design = await readDocument(safe, 'design')
  const tasksDocument = await readDocument(safe, 'tasks')
  if (requirements === undefined && design === undefined && tasksDocument === undefined) return undefined

  const tasks = tasksDocument ? parseTasks(tasksDocument) : []
  return {
    slug: safe,
    title: extractTitle(requirements || design || tasksDocument || '', safe),
    phase: derivePhase(requirements, design, tasksDocument, tasks),
    hasRequirements: requirements !== undefined,
    hasDesign: design !== undefined,
    hasTasks: tasksDocument !== undefined,
    tasks,
  }
}

export async function readSpecDocument(slug: string, kind: SpecDocumentKind): Promise<string | undefined> {
  return readDocument(slugifySpecName(slug), kind)
}

/** Crea o reemplaza un documento del spec. */
export async function writeSpecDocument(
  slug: string,
  kind: SpecDocumentKind,
  content: string,
): Promise<SpecSummary | undefined> {
  const root = specsRoot()
  if (!root) throw new Error('No hay carpeta de proyecto abierta')
  const safe = slugifySpecName(slug)
  const dir = vscode.Uri.joinPath(root, safe)
  await vscode.workspace.fs.createDirectory(dir)
  const body = content.slice(0, MAX_DOCUMENT_CHARS)
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, DOCUMENT_FILES[kind]), Buffer.from(body, 'utf8'))
  return readSpec(safe)
}

/**
 * Cambia el estado de una tarea reescribiendo su casilla en `tasks.md`.
 *
 * Se busca por identificador declarado para no depender del orden de líneas.
 */
export async function updateTaskStatus(
  slug: string,
  taskId: string,
  status: SpecTask['status'],
): Promise<SpecSummary | undefined> {
  const safe = slugifySpecName(slug)
  const document = await readDocument(safe, 'tasks')
  if (document === undefined) throw new Error(`El spec ${safe} no tiene tasks.md`)

  const marker = status === 'completed' ? 'x' : status === 'in-progress' ? '-' : ' '
  const lines = document.split(/\r?\n/)
  let updated = false
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseTaskLine(lines[index])
    if (!parsed || parsed.id !== taskId.trim()) continue
    lines[index] = lines[index].replace(/\[([ xX-])\]/, `[${marker}]`)
    updated = true
    break
  }
  if (!updated) throw new Error(`No encontré la tarea ${taskId} en el spec ${safe}`)

  return writeSpecDocument(safe, 'tasks', lines.join('\n'))
}

/** Contexto textual del spec para acotar el trabajo del agente a una tarea. */
export async function buildTaskContext(slug: string, taskId: string): Promise<string | undefined> {
  const spec = await readSpec(slug)
  if (!spec) return undefined
  const task = spec.tasks.find((item) => item.id === taskId.trim())
  if (!task) return undefined

  const requirements = await readDocument(spec.slug, 'requirements')
  const design = await readDocument(spec.slug, 'design')
  const sections = [
    `SPEC ACTIVO: ${spec.title} (${spec.slug})`,
    `TAREA ASIGNADA: ${task.id}. ${task.title}`,
    'Trabaja únicamente en el alcance de esta tarea. No adelantes tareas siguientes.',
  ]
  if (task.children.length) {
    sections.push(`SUBTAREAS:\n${task.children.map((child) => `- ${child.id}. ${child.title}`).join('\n')}`)
  }
  if (requirements) sections.push(`REQUISITOS DEL SPEC:\n${requirements.slice(0, 12_000)}`)
  if (design) sections.push(`DISEÑO DEL SPEC:\n${design.slice(0, 12_000)}`)
  return sections.join('\n\n')
}

function specsRoot(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  return root ? vscode.Uri.joinPath(root, SPECS_DIR) : undefined
}

async function readDocument(slug: string, kind: SpecDocumentKind): Promise<string | undefined> {
  const root = specsRoot()
  if (!root) return undefined
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, slug, DOCUMENT_FILES[kind]))
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return undefined
  }
}

interface ParsedTaskLine {
  indent: number
  id: string
  title: string
  status: SpecTask['status']
}

function parseTaskLine(line: string): ParsedTaskLine | undefined {
  const match = line.match(/^(\s*)[-*]\s+\[([ xX-])\]\s*(?:([\d.]+)\.?\s*)?(.*)$/)
  if (!match) return undefined
  const marker = match[2].toLowerCase()
  const title = match[4].trim()
  if (!title && !match[3]) return undefined
  return {
    indent: match[1].replace(/\t/g, '  ').length,
    id: (match[3] || title).trim().replace(/\.$/, ''),
    title: title || match[3] || '',
    status: marker === 'x' ? 'completed' : marker === '-' ? 'in-progress' : 'pending',
  }
}

export function parseTasks(document: string): SpecTask[] {
  const tasks: SpecTask[] = []
  let baseIndent: number | undefined
  for (const line of document.split(/\r?\n/)) {
    const parsed = parseTaskLine(line)
    if (!parsed) continue
    if (baseIndent === undefined) baseIndent = parsed.indent
    const task: SpecTask = { id: parsed.id, title: parsed.title, status: parsed.status, children: [] }
    if (parsed.indent > (baseIndent ?? 0) && tasks.length) {
      tasks[tasks.length - 1].children.push(task)
    } else {
      tasks.push(task)
    }
  }
  return tasks
}

function derivePhase(
  requirements: string | undefined,
  design: string | undefined,
  tasks: string | undefined,
  parsedTasks: SpecTask[],
): SpecPhase {
  if (!requirements) return 'requirements'
  if (!design) return 'design'
  if (!tasks) return 'tasks'
  const all = flatten(parsedTasks)
  if (all.length && all.every((task) => task.status === 'completed')) return 'done'
  return 'execution'
}

export function flatten(tasks: SpecTask[]): SpecTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.children)])
}

function extractTitle(document: string, fallback: string): string {
  const heading = document.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading.replace(/^(?:Requisitos|Requirements|Diseño|Design|Tareas|Tasks)\s*[—-]\s*/i, '').slice(0, 120)
  return fallback
}
