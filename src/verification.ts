// Bucle de verificación: aplicar → validar → corregir → revalidar.
//
// Sin este ciclo el agente entrega trabajo sin comprobar; con él, cada cambio se
// contrasta contra el comando de validación declarado por el proyecto y los
// errores introducidos se corrigen antes de devolver el control al usuario.
import { chat, ChatMessage } from './providers'
import { ProjectIndex } from './projectIndex'
import { applyProposalSelections } from './changes'
import { detectValidationCommand, formatRun, runCommand } from './execution'
import { parseProposals } from './agent'
import type { ProjectProfile } from './projectProfile'
import {
  Checkpoint, ExecutionRun, FileProposal, ProviderConfig, UiLanguage, VerificationMode,
} from './types'

const MAX_ATTEMPTS = 3
const MAX_OUTPUT_CHARS = 8_000

export interface VerificationOutcome {
  runs: ExecutionRun[]
  appliedFixes: FileProposal[]
  checkpoints: Checkpoint[]
  /** Resumen legible del ciclo para adjuntar al turno. */
  note?: string
}

export interface VerificationRequest {
  mode: VerificationMode
  provider: ProviderConfig
  profile?: ProjectProfile
  index: ProjectIndex
  language: UiLanguage
  trusted: boolean
  onRun: (command: string) => void
  runCommandExclusive: (proposal: ReturnType<typeof detectValidationCommand>) => Promise<ExecutionRun>
  persistCheckpoint: (checkpoint: Checkpoint) => Promise<void>
}

/**
 * Ejecuta la validación y, en modo `autofix`, intenta corregir los fallos.
 *
 * Se detiene al pasar, al agotar los intentos, cuando el modelo no propone una
 * corrección o cuando la salida de error se repite (falta de progreso).
 */
export async function verifyAndFix(request: VerificationRequest): Promise<VerificationOutcome> {
  const outcome: VerificationOutcome = { runs: [], appliedFixes: [], checkpoints: [] }
  if (request.mode === 'off' || !request.trusted || !request.profile) return outcome

  const seenFailures = new Set<string>()
  const maxAttempts = request.mode === 'autofix' ? MAX_ATTEMPTS : 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proposal = detectValidationCommand(request.profile)
    if (!proposal) return outcome

    request.onRun(proposal.command)
    const run = await request.runCommandExclusive(proposal)
    outcome.runs.push(run)
    if (run.status === 'passed') return outcome
    if (run.status === 'blocked') {
      outcome.note = note(request.language,
        'La validación quedó bloqueada por las reglas de seguridad de ejecución.',
        'Validation was blocked by the execution safety rules.')
      return outcome
    }
    if (request.mode !== 'autofix' || attempt === maxAttempts) break

    const signature = failureSignature(run)
    if (seenFailures.has(signature)) {
      outcome.note = note(request.language,
        'Detuve la corrección automática: el error se repitió sin avanzar.',
        'Automatic fixing stopped: the same error repeated without progress.')
      return outcome
    }
    seenFailures.add(signature)

    const fixes = await requestFix(request, run, attempt)
    if (!fixes.length) {
      outcome.note = note(request.language,
        'La validación falló y no obtuve una corrección aplicable automáticamente.',
        'Validation failed and no automatically applicable fix was produced.')
      return outcome
    }

    try {
      const applied = await applyProposalSelections(
        fixes,
        fixes.map((fix) => ({ proposalId: fix.id!, hunkIds: (fix.hunks || []).map((hunk) => hunk.id) })),
        note(request.language, 'Corrección automática de validación', 'Automatic validation fix'),
        request.persistCheckpoint,
      )
      outcome.appliedFixes.push(...applied.applied)
      outcome.checkpoints.push(applied.checkpoint)
    } catch (error) {
      outcome.note = note(request.language,
        `No pude aplicar la corrección automática: ${message(error)}`,
        `The automatic fix could not be applied: ${message(error)}`)
      return outcome
    }

    await request.index.build()
  }

  if (!outcome.note && outcome.runs.some((run) => run.status !== 'passed')) {
    outcome.note = note(request.language,
      'La validación sigue fallando; revisa la salida antes de continuar.',
      'Validation is still failing; review the output before continuing.')
  }
  return outcome
}

/** Pide al modelo una corrección acotada al fallo observado. */
async function requestFix(
  request: VerificationRequest,
  run: ExecutionRun,
  attempt: number,
): Promise<FileProposal[]> {
  const failing = await relevantSources(request.index, run.output)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Eres QAPI corrigiendo una validación fallida en el proyecto abierto.',
        'Devuelve únicamente los archivos completos que deben cambiar, usando bloques:',
        '<<<FILE path="ruta/relativa.ext">>>',
        'contenido completo',
        '<<<END>>>',
        'No expliques nada fuera de los bloques. Si no puedes determinar una corrección segura, no devuelvas ningún bloque.',
        'Corrige la causa del error; no desactives pruebas, no elimines validaciones y no cambies archivos ajenos al fallo.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Intento de corrección ${attempt} de ${MAX_ATTEMPTS}.`,
        'Resultado de la validación:',
        formatRun({ ...run, output: run.output.slice(-MAX_OUTPUT_CHARS) }),
        failing ? `\nArchivos relacionados:\n${failing}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ]

  try {
    const raw = await chat(request.provider, messages)
    const parsed = parseProposals(raw)
    return parsed.proposals.map((proposal) => ({
      ...proposal,
      purpose: note(request.language,
        'Corrección automática para que la validación del proyecto vuelva a pasar.',
        'Automatic fix so the project validation passes again.'),
    }))
  } catch {
    return []
  }
}

/** Extrae rutas citadas en la salida y adjunta su contenido actual. */
async function relevantSources(index: ProjectIndex, output: string): Promise<string> {
  const candidates = new Set<string>()
  const pattern = /(?:^|[\s('"])((?:[\w.@-]+\/)*[\w.@-]+\.[a-z]{1,5})(?::\d+)?/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(output)) !== null) {
    const path = match[1].replace(/^\.?\//, '')
    if (path && !path.startsWith('node_modules/')) candidates.add(path)
    if (candidates.size >= 6) break
  }

  const sections: string[] = []
  for (const path of candidates) {
    const content = await index.readFile(path, 12_000)
    if (content !== undefined) sections.push(`— ${path}\n\`\`\`\n${content}\n\`\`\``)
  }
  return sections.join('\n\n')
}

function failureSignature(run: ExecutionRun): string {
  return `${run.command}::${run.output.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 800)}`
}

function note(language: UiLanguage, es: string, en: string): string {
  return language === 'en' ? en : es
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
