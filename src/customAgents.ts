// Agentes personalizados: presets ejecutables con instrucción fija y entrada
// acotada a un glob de archivos, para tareas repetibles que no deberían
// depender de que el usuario redacte el prompt correcto cada vez.
//
// Se guardan en `.qapi/agents/*.json` (versionable por el equipo) y se
// combinan con 6 agentes incluidos con la extensión. Ejecutar un agente no es
// más que armar una instrucción fija + contenido de archivos y llamar a
// `ask()` como cualquier mensaje del chat: mismas barreras de autorización,
// verificación y checkpoints ya vigentes.
import * as vscode from 'vscode'
import { ProjectIndex } from './projectIndex'
import { CustomAgentDefinition } from './types'

const AGENTS_DIR = '.qapi/agents'
const MAX_AGENTS = 40
const MAX_FILES_PER_RUN = 40
const MAX_CHARS_PER_FILE = 20_000
const MAX_TOTAL_CHARS = 200_000

export const BUILT_IN_AGENTS: CustomAgentDefinition[] = [
  {
    slug: 'documentacion-negocio',
    name: 'Documentación de negocio',
    description: 'Lee .feature seleccionados y redacta reglas de negocio y flujos en lenguaje humano.',
    icon: '📘',
    inputGlob: '**/*.feature',
    outputMode: 'file',
    outputPathTemplate: 'docs/negocio/{name}.md',
    builtIn: true,
    instructions: `Eres un analista de negocio. A partir de los archivos .feature seleccionados,
redacta un documento Markdown para personas no técnicas (producto, negocio, QA funcional):
1. Resumen del área funcional cubierta.
2. Reglas de negocio inferidas (una lista clara, sin jerga técnica ni Gherkin).
3. Flujos funcionales principales, descritos como pasos en lenguaje humano (no copies los steps).
4. Casos alternativos y de error relevantes.
5. Supuestos o vacíos detectados (información que falta o es ambigua en los .feature).
No inventes reglas que no estén respaldadas por el contenido leído.`,
  },
  {
    slug: 'checklist-riesgos',
    name: 'Checklist de riesgos de release',
    description: 'Analiza el Git diff y genera un checklist de riesgos y pruebas de regresión antes de liberar.',
    icon: '⚠️',
    outputMode: 'chat',
    builtIn: true,
    instructions: `Eres un QA lead evaluando el riesgo de una release. Usa el contexto del proyecto,
el Git diff y los archivos que te indiquen (si los hay) para producir:
1. Nivel de riesgo general (bajo/medio/alto) con justificación breve.
2. Checklist de verificaciones manuales antes de liberar.
3. Pruebas de regresión prioritarias y por qué.
4. Áreas del sistema no cubiertas por pruebas automatizadas que deberían revisarse.
Sé concreto y basado en evidencia real del proyecto, no genérico.`,
  },
  {
    slug: 'generador-casos-prueba',
    name: 'Generador de casos de prueba',
    description: 'Lee especificaciones o código seleccionado y propone casos de prueba en una tabla.',
    icon: '🧪',
    outputMode: 'file',
    outputPathTemplate: 'docs/casos-prueba/{name}.md',
    builtIn: true,
    instructions: `Eres un diseñador de casos de prueba. A partir de los archivos seleccionados,
genera una tabla Markdown de casos de prueba con columnas: ID, Título, Precondición,
Pasos, Resultado esperado, Prioridad (alta/media/baja), Tipo (positivo/negativo/límite).
Cubre camino feliz, casos límite y casos negativos. No dupliques casos equivalentes.`,
  },
  {
    slug: 'revision-accesibilidad',
    name: 'Revisión de accesibilidad',
    description: 'Analiza componentes de UI seleccionados y reporta problemas de accesibilidad (WCAG).',
    icon: '♿',
    inputGlob: '**/*.{tsx,jsx,vue,html}',
    outputMode: 'file',
    outputPathTemplate: 'docs/accesibilidad/{name}.md',
    builtIn: true,
    instructions: `Eres un auditor de accesibilidad. Revisa los archivos de UI seleccionados y reporta,
en Markdown, problemas concretos agrupados por severidad (alta/media/baja) con referencia a
criterios WCAG 2.1 cuando aplique: contraste, etiquetas ARIA, foco de teclado, textos alternativos,
estructura semántica. Para cada hallazgo indica archivo, línea aproximada y corrección sugerida.
Aclara al inicio que esto es un análisis estático y no reemplaza pruebas con lectores de pantalla
ni validación manual con personas usuarias.`,
  },
  {
    slug: 'documentador-api',
    name: 'Documentador de API',
    description: 'Lee rutas/controladores seleccionados y genera documentación de endpoints en Markdown.',
    icon: '🔌',
    inputGlob: '**/*.{ts,js,py,java}',
    outputMode: 'file',
    outputPathTemplate: 'docs/api/{name}.md',
    builtIn: true,
    instructions: `Eres un documentador técnico de APIs. A partir del código seleccionado, extrae los
endpoints reales (método, ruta, parámetros, body, respuestas y códigos de estado) y documéntalos
en Markdown, agrupados por recurso. No inventes endpoints ni parámetros que no estén en el código.
Si detectas autenticación o validaciones relevantes, menciónalas por endpoint.`,
  },
  {
    slug: 'auditor-dependencias',
    name: 'Auditor de dependencias',
    description: 'Revisa manifiestos de dependencias y señala riesgos de versiones, licencias u obsolescencia.',
    icon: '📦',
    inputGlob: '**/{package.json,requirements.txt,pom.xml,build.gradle,Gemfile,go.mod}',
    outputMode: 'chat',
    builtIn: true,
    instructions: `Eres un auditor de dependencias. Revisa los manifiestos seleccionados y reporta:
1. Dependencias con versiones no fijadas (rangos abiertos) y el riesgo que implican.
2. Dependencias que parecen obsoletas o sin mantenimiento evidente por el nombre/versión.
3. Cualquier paquete con nombre sospechoso de typosquatting.
4. Recomendaciones concretas de siguiente paso (fijar versión, revisar, reemplazar).
No accedas a internet ni asumas datos que no puedas justificar con el contenido leído.`,
  },
]

function agentsRoot(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  return root ? vscode.Uri.joinPath(root, AGENTS_DIR) : undefined
}

export function slugifyAgentName(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'agente'
}

/** Agentes incluidos + personalizados del workspace. Un slug de usuario puede sobrescribir uno incluido. */
export async function listCustomAgents(): Promise<CustomAgentDefinition[]> {
  const custom = await readCustomAgents()
  const customSlugs = new Set(custom.map((agent) => agent.slug))
  const builtIn = BUILT_IN_AGENTS.filter((agent) => !customSlugs.has(agent.slug))
  return [...builtIn, ...custom]
}

async function readCustomAgents(): Promise<CustomAgentDefinition[]> {
  const root = agentsRoot()
  if (!root) return []
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(root)
  } catch {
    return []
  }

  const agents: CustomAgentDefinition[] = []
  for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.json')) continue
    if (agents.length >= MAX_AGENTS) break
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name))
      const parsed = normalizeAgent(JSON.parse(Buffer.from(bytes).toString('utf8')), name.replace(/\.json$/i, ''))
      if (parsed) agents.push(parsed)
    } catch { /* archivo inválido: se omite */ }
  }
  return agents
}

export async function saveCustomAgent(
  agent: CustomAgentDefinition,
  previousSlug?: string,
): Promise<CustomAgentDefinition> {
  const root = agentsRoot()
  if (!root) throw new Error('No hay carpeta de proyecto abierta')
  const slug = slugifyAgentName(agent.slug || agent.name)
  const normalized = normalizeAgent({ ...agent, slug, builtIn: false }, slug)
  if (!normalized) throw new Error('Definición de agente inválida: falta nombre o instrucciones.')

  await vscode.workspace.fs.createDirectory(root)
  if (previousSlug && slugifyAgentName(previousSlug) !== slug) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, `${slugifyAgentName(previousSlug)}.json`))
    } catch { /* no existía: se ignora */ }
  }
  const body = JSON.stringify({ ...normalized, builtIn: undefined }, null, 2)
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, `${slug}.json`), Buffer.from(body, 'utf8'))
  return normalized
}

export async function deleteCustomAgent(slug: string): Promise<void> {
  const root = agentsRoot()
  if (!root) return
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, `${slugifyAgentName(slug)}.json`))
  } catch { /* ya no existía */ }
}

export async function findCustomAgent(slug: string): Promise<CustomAgentDefinition | undefined> {
  const agents = await listCustomAgents()
  return agents.find((agent) => agent.slug === slugifyAgentName(slug))
}

/** Rutas indexadas que coinciden con el glob de entrada del agente. */
export function matchAgentFiles(index: ProjectIndex, glob: string | undefined, limit = 200): string[] {
  if (!glob) return []
  return index.paths.filter((path) => matchesGlob(path, glob)).slice(0, limit)
}

/**
 * Construye la instrucción fija que se envía al agente principal (`ask()`),
 * incluyendo el contenido de los archivos de entrada seleccionados.
 */
export async function buildRunInstruction(
  agent: CustomAgentDefinition,
  index: ProjectIndex,
  selectedFiles: string[],
): Promise<string> {
  const sections = [
    `AGENTE PERSONALIZADO: ${agent.name}`,
    agent.instructions.trim(),
  ]

  const files = selectedFiles.slice(0, MAX_FILES_PER_RUN)
  if (files.length) {
    let budget = MAX_TOTAL_CHARS
    const blocks: string[] = []
    for (const path of files) {
      if (budget <= 0) break
      const content = await index.readFile(path, MAX_CHARS_PER_FILE)
      if (content === undefined) continue
      const block = `— ${path}\n\`\`\`\n${content}\n\`\`\``.slice(0, Math.min(MAX_CHARS_PER_FILE + 200, budget))
      blocks.push(block)
      budget -= block.length
    }
    if (blocks.length) sections.push(`ARCHIVOS DE ENTRADA SELECCIONADOS (${blocks.length}):\n${blocks.join('\n\n')}`)
  }

  if (agent.outputMode === 'file') {
    const outputPath = resolveOutputPath(agent, selectedFiles)
    sections.push(
      `SALIDA REQUERIDA: crea o reemplaza el archivo \`${outputPath}\` con el resultado usando write_file. ` +
      'No propongas otros archivos salvo que sea imprescindible para completar la tarea.',
    )
  } else {
    sections.push('SALIDA REQUERIDA: responde en el chat con el resultado; no crees ni modifiques archivos salvo que el usuario lo pida explícitamente.')
  }

  return sections.join('\n\n')
}

function resolveOutputPath(agent: CustomAgentDefinition, selectedFiles: string[]): string {
  const template = agent.outputPathTemplate || 'docs/{name}.md'
  const baseName = selectedFiles.length === 1
    ? fileBaseName(selectedFiles[0])
    : slugifyAgentName(agent.name)
  const date = new Date().toISOString().slice(0, 10)
  return template.replace('{name}', baseName).replace('{date}', date)
}

function fileBaseName(path: string): string {
  const last = path.split('/').pop() || path
  return slugifyAgentName(last.replace(/\.[^.]+$/, ''))
}

function normalizeAgent(candidate: any, fallbackSlug: string): CustomAgentDefinition | undefined {
  const name = String(candidate?.name || '').trim().slice(0, 100)
  const instructions = String(candidate?.instructions || '').trim().slice(0, 8_000)
  if (!name || !instructions) return undefined
  const outputMode: CustomAgentDefinition['outputMode'] = candidate?.outputMode === 'file' ? 'file' : 'chat'
  return {
    slug: slugifyAgentName(String(candidate?.slug || fallbackSlug)),
    name,
    description: String(candidate?.description || '').trim().slice(0, 300),
    icon: candidate?.icon ? String(candidate.icon).slice(0, 8) : undefined,
    instructions,
    inputGlob: candidate?.inputGlob ? String(candidate.inputGlob).trim().slice(0, 200) : undefined,
    outputMode,
    outputPathTemplate: outputMode === 'file'
      ? String(candidate?.outputPathTemplate || 'docs/{name}.md').trim().slice(0, 200)
      : undefined,
    builtIn: false,
  }
}

/** Soporte acotado de globs: `**`, `*`, `?` y `{a,b,c}`. */
function matchesGlob(path: string, pattern: string): boolean {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
  if (!normalized) return false

  // Tokeniza en literales/comodines/grupos antes de escapar, así cada
  // fragmento se traduce a regex sin que un escape interfiera con otro.
  const tokens = normalized.split(/(\*\*\/|\*\*|\*|\?|\{[^{}]*\})/g).filter((token) => token !== '')
  const source = tokens.map((token) => {
    if (token === '**/') return '(?:.*/)?'
    if (token === '**') return '.*'
    if (token === '*') return '[^/]*'
    if (token === '?') return '[^/]'
    const brace = token.match(/^\{([^{}]*)\}$/)
    if (brace) return `(?:${brace[1].split(',').map((alt) => escapeRegex(alt.trim())).join('|')})`
    return escapeRegex(token)
  }).join('')

  try {
    return new RegExp(`^${source}$`, 'i').test(path)
  } catch {
    return false
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}
