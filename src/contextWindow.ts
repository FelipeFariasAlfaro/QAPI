// Estimación de uso de la ventana de contexto por modelo.
//
// Cada modelo tiene un límite de tokens distinto. Aquí mapeamos límites
// conocidos (por patrón de nombre) y estimamos los tokens usados por la
// conversación para poder mostrar una barra y decidir cuándo resumir.
import { ChatTurn, ProviderId } from './types'

/** Umbral (0-1) a partir del cual se sugiere/hace el resumen automático. */
export const SUMMARIZE_THRESHOLD = 0.85
/** Debe coincidir con OLLAMA_MAX_CTX de providers.ts (num_ctx enviado). */
const OLLAMA_CTX_CAP = 32_768

interface LimitRule { re: RegExp; limit: number }

// Límites aproximados de ventana de contexto (tokens de entrada). El orden
// importa: las reglas específicas van antes que las genéricas.
const RULES: Record<ProviderId, LimitRule[]> = {
  openai: [
    { re: /gpt-5/i, limit: 400_000 },
    { re: /gpt-4\.1/i, limit: 1_000_000 },
    { re: /gpt-4\.5|gpt-4o|gpt-4-turbo|gpt-oss/i, limit: 128_000 },
    { re: /(?:^|[^a-z0-9])o[1-9]/i, limit: 200_000 },
    { re: /gpt-4/i, limit: 8192 },
    { re: /gpt-3\.5/i, limit: 16_385 },
  ],
  gemini: [
    { re: /gemini-1\.0|gemini-pro(?:-vision)?$/i, limit: 32_000 },
    { re: /1\.5-pro/i, limit: 2_000_000 },
    { re: /gemini/i, limit: 1_048_576 },
  ],
  claude: [
    { re: /claude-2|claude-instant/i, limit: 100_000 },
    { re: /claude/i, limit: 200_000 },
  ],
  ollama: [
    // Ollama trabaja con el num_ctx que se le envía, no con el máximo de entrenamiento.
    { re: /llama3\.[1-9]|llama-3\.[1-9]|qwen2\.5|qwen3|mistral-nemo|gemma3|phi4|deepseek|gpt-oss/i, limit: OLLAMA_CTX_CAP },
    { re: /./, limit: 8192 },
  ],
}

/** Modelos no reconocidos de proveedores en la nube: hoy casi todos superan 128k. */
const DEFAULT_LIMIT = 128_000

export function contextLimitFor(provider: ProviderId, model?: string): number {
  const rules = RULES[provider] || []
  for (const r of rules) if (r.re.test(model || '')) return r.limit
  return provider === 'ollama' ? 8192 : DEFAULT_LIMIT
}

/** Estimación barata de tokens: ~4 caracteres por token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Tokens de la conversación que realmente se envía al modelo (el texto de los
 * turnos). El contenido de las propuestas no viaja en el historial; contarlo
 * disparaba resúmenes innecesarios tras crear archivos grandes.
 */
export function historyTokens(history: ChatTurn[]): number {
  let n = 0
  for (const t of history) n += estimateTokens(t.text || '')
  return n
}

export interface ContextUsage {
  used: number
  limit: number
  ratio: number
  needsSummary: boolean
}

export function computeUsage(
  history: ChatTurn[],
  provider: ProviderId,
  model?: string,
  explicitLimit?: number,
): ContextUsage {
  // Prioriza el límite real obtenido de la API; si no, usa la tabla por patrón.
  let limit = explicitLimit && explicitLimit > 0 ? explicitLimit : contextLimitFor(provider, model)
  if (provider === 'ollama') limit = Math.min(limit, OLLAMA_CTX_CAP)
  // El contador visible representa sólo la conversación actual. El contexto fijo
  // del sistema/proyecto se reserva únicamente para decidir cuándo resumir; es
  // proporcional para que modelos de 8k no resuman en cada turno.
  const used = historyTokens(history)
  const reservedOverhead = Math.min(12_000, Math.floor(limit * 0.25))
  const ratio = Math.min(1, used / limit)
  const projectedRatio = Math.min(1, (used + reservedOverhead) / limit)
  return { used, limit, ratio, needsSummary: used > 0 && projectedRatio >= SUMMARIZE_THRESHOLD }
}
