// Estimación de uso de la ventana de contexto por modelo.
//
// Cada modelo tiene un límite de tokens distinto. Aquí mapeamos límites
// conocidos (por patrón de nombre) y estimamos los tokens usados por la
// conversación para poder mostrar una barra y decidir cuándo resumir.
import { ChatTurn, ProviderId } from './types'

/** Umbral (0-1) a partir del cual se sugiere/hace el resumen automático. */
export const SUMMARIZE_THRESHOLD = 0.85

interface LimitRule { re: RegExp; limit: number }

// Límites aproximados de ventana de contexto (tokens de entrada).
const RULES: Record<ProviderId, LimitRule[]> = {
  openai: [
    { re: /gpt-4\.1/i, limit: 1000000 },
    { re: /gpt-4o|gpt-4-turbo/i, limit: 128000 },
    { re: /o1|o3|o4/i, limit: 200000 },
    { re: /gpt-4/i, limit: 8192 },
    { re: /gpt-3\.5/i, limit: 16385 },
  ],
  gemini: [
    { re: /1\.5-pro|2\.5-pro/i, limit: 2000000 },
    // Gemini 1.5+ (flash/pro y versiones nuevas como 2.x/3.x) usan 1M por defecto.
    { re: /gemini-(1\.5|2|3|[3-9])|flash|pro/i, limit: 1000000 },
    { re: /gemini-1\.0|gemini-pro\b/i, limit: 32000 },
    { re: /gemini/i, limit: 1000000 },
  ],
  claude: [
    { re: /claude-3|claude-3\.5|sonnet|opus|haiku/i, limit: 200000 },
    { re: /claude/i, limit: 100000 },
  ],
  ollama: [
    { re: /llama3|llama-3|qwen2|mistral-nemo/i, limit: 128000 },
    { re: /./, limit: 8192 },
  ],
}

const DEFAULT_LIMIT = 16000

export function contextLimitFor(provider: ProviderId, model?: string): number {
  const rules = RULES[provider] || []
  for (const r of rules) if (r.re.test(model || '')) return r.limit
  return DEFAULT_LIMIT
}

/** Estimación barata de tokens: ~4 caracteres por token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function historyTokens(history: ChatTurn[]): number {
  let n = 0
  for (const t of history) {
    n += estimateTokens(t.text)
    for (const p of t.proposals || []) n += estimateTokens(p.content)
  }
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
  const limit = explicitLimit && explicitLimit > 0 ? explicitLimit : contextLimitFor(provider, model)
  // El contador visible representa sólo la conversación actual. El contexto fijo
  // del sistema/proyecto se reserva únicamente para decidir cuándo resumir.
  const used = historyTokens(history)
  const reservedOverhead = 12000
  const ratio = Math.min(1, used / limit)
  const projectedRatio = Math.min(1, (used + reservedOverhead) / limit)
  return { used, limit, ratio, needsSummary: used > 0 && projectedRatio >= SUMMARIZE_THRESHOLD }
}
