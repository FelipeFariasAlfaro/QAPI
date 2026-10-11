// Adaptadores de proveedores de IA: validar credenciales, listar modelos y
// generar respuestas. Se usa fetch nativo (Node 18+); sin dependencias.
import { ProviderConfig } from './types'
import { contextLimitFor } from './contextWindow'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Definición de una herramienta que el modelo puede invocar. */
export interface ToolDef {
  name: string
  description: string
  /** JSON Schema de los parámetros. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  name: string
  args: Record<string, any>
  /** true si los argumentos no se pudieron interpretar (JSON truncado o inválido). */
  invalidArgs?: boolean
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  /** El proveedor cortó la respuesta por límite de tokens de salida. */
  truncated?: boolean
}

export interface ValidationResult {
  ok: boolean
  models: string[]
  /** Límite real de contexto (tokens) por modelo, cuando la API lo expone. */
  limits?: Record<string, number>
  message?: string
}

/** Opciones por petición: cancelación externa y timeout total. */
export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_OLLAMA = 'http://localhost:11434'
/** Timeout por defecto de una llamada de generación (escrituras largas incluidas). */
export const REQUEST_TIMEOUT_MS = 300_000
const LIST_TIMEOUT_MS = 30_000
/**
 * Ollama reserva memoria según num_ctx. El context_length reportado es el
 * máximo de entrenamiento (a veces 128k+), así que se acota a un valor usable.
 */
export const OLLAMA_MAX_CTX = 32_768
/** Mensaje de error estable para una cancelación pedida por el usuario. */
export const CANCELLED_ERROR = 'QAPI_REQUEST_CANCELLED'

export function isCancellation(error: unknown): boolean {
  return String((error as any)?.message || error) === CANCELLED_ERROR
}

interface RequestState {
  dispose: () => void
  mapError: (error: unknown) => Error
}

/** El timeout y la cancelación siguen activos hasta terminar de leer el cuerpo. */
const requestStates = new WeakMap<Response, RequestState>()

/**
 * fetch con timeout y cancelación externa. Distingue la cancelación del
 * usuario (CANCELLED_ERROR) de un timeout, para que la UI informe bien.
 * El cuerpo debe leerse con `readJson`/`readText`/`consumeLines` o liberarse
 * con `release`, para cubrir también respuestas que se quedan colgadas.
 */
async function request(url: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const external = options.signal
  const onAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  const state: RequestState = {
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
    mapError: (error) => {
      if (external?.aborted) return new Error(CANCELLED_ERROR)
      if (timedOut) return new Error(`El proveedor no respondió en ${Math.round(timeoutMs / 1000)} s.`)
      return error instanceof Error ? error : new Error(String(error))
    },
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    requestStates.set(response, state)
    return response
  } catch (error) {
    state.dispose()
    throw state.mapError(error)
  }
}

async function readBody<T>(response: Response, read: () => Promise<T>): Promise<T> {
  const state = requestStates.get(response)
  try {
    return await read()
  } catch (error) {
    throw state ? state.mapError(error) : error
  } finally {
    state?.dispose()
  }
}

const readJson = (response: Response): Promise<any> => readBody(response, () => response.json())
const readText = (response: Response): Promise<string> => readBody(response, () => response.text())
function release(response: Response): void {
  requestStates.get(response)?.dispose()
  void response.body?.cancel?.().catch(() => undefined)
}
function httpFailure(response: Response, message: string): Error {
  release(response)
  return new Error(message)
}

/** Verifica la credencial y devuelve los modelos disponibles del proveedor. */
export async function validateProvider(cfg: ProviderConfig): Promise<ValidationResult> {
  try {
    switch (cfg.provider) {
      case 'openai':
        return await listOpenAiModels(cfg)
      case 'gemini':
        return await listGeminiModels(cfg)
      case 'claude':
        return await listClaudeModels(cfg)
      case 'ollama':
        return await listOllamaModels(cfg)
      default:
        return { ok: false, models: [], message: 'Proveedor no soportado' }
    }
  } catch (e: any) {
    return { ok: false, models: [], message: String(e?.message || e) }
  }
}

async function listOpenAiModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const r = await request(`${base}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey || ''}` },
  }, { timeoutMs: LIST_TIMEOUT_MS })
  if (!r.ok) { release(r); return { ok: false, models: [], message: `HTTP ${r.status}` } }
  const data: any = await readJson(r)
  const models = (data.data || [])
    .map((m: any) => m.id as string)
    .filter((id: string) => /gpt|o1|o3|o4/i.test(id))
    .sort()
  return { ok: true, models }
}

async function listGeminiModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const r = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: geminiHeaders(cfg),
  }, { timeoutMs: LIST_TIMEOUT_MS })
  if (!r.ok) { release(r); return { ok: false, models: [], message: `HTTP ${r.status}` } }
  const data: any = await readJson(r)
  const usable = (data.models || []).filter((m: any) =>
    (m.supportedGenerationMethods || []).includes('generateContent'))
  const models = usable.map((m: any) => String(m.name).replace(/^models\//, ''))
  // La API de Gemini expone el límite real de entrada por modelo.
  const limits: Record<string, number> = {}
  for (const m of usable) {
    const name = String(m.name).replace(/^models\//, '')
    if (typeof m.inputTokenLimit === 'number') limits[name] = m.inputTokenLimit
  }
  return { ok: true, models, limits }
}

async function listClaudeModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const r = await request('https://api.anthropic.com/v1/models?limit=1000', {
    headers: claudeHeaders(cfg),
  }, { timeoutMs: LIST_TIMEOUT_MS })
  if (!r.ok) { release(r); return { ok: false, models: [], message: `HTTP ${r.status}` } }
  const data: any = await readJson(r)
  const models = (data.data || []).map((m: any) => m.id as string)
  return { ok: true, models }
}

async function listOllamaModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await request(`${base}/api/tags`, {}, { timeoutMs: LIST_TIMEOUT_MS })
  if (!r.ok) { release(r); return { ok: false, models: [], message: `Ollama no responde (HTTP ${r.status})` } }
  const data: any = await readJson(r)
  const models = (data.models || []).map((m: any) => m.name as string)
  // Ollama expone el context_length real por modelo vía /api/show.
  const limits: Record<string, number> = {}
  await Promise.all(models.map(async (name: string) => {
    try {
      const sr = await request(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, { timeoutMs: LIST_TIMEOUT_MS })
      if (!sr.ok) { release(sr); return }
      const info: any = await readJson(sr)
      const ctx = findContextLength(info?.model_info)
      // Se acota al num_ctx que realmente se enviará en cada petición.
      if (ctx) limits[name] = Math.min(ctx, OLLAMA_MAX_CTX)
    } catch { /* modelo sin info: se usa la tabla */ }
  }))
  return { ok: true, models, limits }
}

/** Busca la clave *.context_length dentro de model_info de Ollama. */
function findContextLength(modelInfo: Record<string, any> | undefined): number | undefined {
  if (!modelInfo) return undefined
  for (const [k, v] of Object.entries(modelInfo)) {
    if (k.endsWith('.context_length') && typeof v === 'number') return v
  }
  return undefined
}

// ── Detalles por proveedor ───────────────────────────────────────────────────

function geminiHeaders(cfg: ProviderConfig): Record<string, string> {
  // La key va en header y no en la URL para que no quede en logs de proxies.
  return { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey || '' }
}

function claudeHeaders(cfg: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey || '',
    'anthropic-version': '2023-06-01',
  }
}

/**
 * Tope de tokens de salida de Claude. Los modelos 3.x antiguos rechazan valores
 * altos; los actuales aceptan bastante más, necesario para escribir archivos
 * completos en una sola tool call.
 */
export function claudeMaxTokens(model = ''): number {
  const id = model.toLowerCase()
  if (/claude-3-(?:opus|sonnet|haiku)/.test(id)) return 4096
  if (/claude-3-5/.test(id)) return 8192
  return 32_000
}

/** Los modelos de razonamiento de OpenAI no aceptan `temperature` distinta de 1. */
export function openAiSupportsTemperature(model = ''): boolean {
  return !/^(?:o\d|gpt-5)/i.test(model.trim())
}

function openAiBody(cfg: ProviderConfig, extra: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: cfg.model, ...extra }
  if (openAiSupportsTemperature(cfg.model)) body.temperature = 0.3
  return body
}

function ollamaOptions(cfg: ProviderConfig): Record<string, unknown> {
  const ctx = Math.min(cfg.contextLimit || contextLimitFor('ollama', cfg.model), OLLAMA_MAX_CTX)
  return { num_ctx: ctx }
}

function geminiContents(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  return { system, contents }
}

function claudeMessages(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
  return { system, msgs }
}

/**
 * Genera una respuesta permitiendo que el modelo invoque herramientas.
 * Devuelve el texto y las llamadas a herramienta detectadas. Usar esto en vez
 * de pedir formatos de texto ad-hoc: es mucho más fiable entre proveedores.
 */
export async function chatWithTools(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  options: RequestOptions = {},
): Promise<ChatResult> {
  switch (cfg.provider) {
    case 'openai':
      return chatOpenAiTools(cfg, messages, tools, options)
    case 'gemini':
      return chatGeminiTools(cfg, messages, tools, options)
    case 'claude':
      return chatClaudeTools(cfg, messages, tools, options)
    case 'ollama':
      return chatOllamaTools(cfg, messages, tools, options)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function chatOpenAiTools(
  cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], options: RequestOptions,
): Promise<ChatResult> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const r = await request(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify(openAiBody(cfg, {
      messages,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    })),
  }, options)
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  const choice = data.choices?.[0]
  const msg = choice?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls || []).map((c: any) => parseToolCall(c.function?.name, c.function?.arguments))
  return { text: msg?.content || '', toolCalls, truncated: choice?.finish_reason === 'length' }
}

async function chatGeminiTools(
  cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], options: RequestOptions,
): Promise<ChatResult> {
  const { system, contents } = geminiContents(messages)
  const body: any = {
    contents,
    tools: [{
      functionDeclarations: tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      })),
    }],
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const r = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model || '')}:generateContent`,
    { method: 'POST', headers: geminiHeaders(cfg), body: JSON.stringify(body) },
    options,
  )
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  const candidate = data.candidates?.[0]
  const parts: any[] = candidate?.content?.parts || []
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('')
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }))
  return { text, toolCalls, truncated: candidate?.finishReason === 'MAX_TOKENS' }
}

async function chatClaudeTools(
  cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], options: RequestOptions,
): Promise<ChatResult> {
  const { system, msgs } = claudeMessages(messages)
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(cfg),
    body: JSON.stringify({
      model: cfg.model, system, messages: msgs, max_tokens: claudeMaxTokens(cfg.model),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  }, options)
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  const blocks: any[] = data.content || []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name, args: b.input || {} }))
  return { text, toolCalls, truncated: data.stop_reason === 'max_tokens' }
}

async function chatOllamaTools(
  cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], options: RequestOptions,
): Promise<ChatResult> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await request(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, messages, stream: false, options: ollamaOptions(cfg),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  }, options)
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  const toolCalls: ToolCall[] = (data.message?.tool_calls || []).map((c: any) =>
    parseToolCall(c.function?.name, c.function?.arguments))
  return { text: data.message?.content || '', toolCalls, truncated: data.done_reason === 'length' }
}

function parseToolCall(name: unknown, rawArgs: unknown): ToolCall {
  if (typeof rawArgs !== 'string') return { name: String(name || ''), args: (rawArgs as any) || {} }
  try {
    const parsed = JSON.parse(rawArgs || '{}')
    return { name: String(name || ''), args: parsed && typeof parsed === 'object' ? parsed : {} }
  } catch {
    return { name: String(name || ''), args: {}, invalidArgs: true }
  }
}

function safeJson(s: unknown): Record<string, any> | undefined {
  if (typeof s !== 'string') return (s as any) || {}
  try { return JSON.parse(s) } catch { return undefined }
}

/** Genera una respuesta (no streaming). Devuelve el texto completo. */
export async function chat(cfg: ProviderConfig, messages: ChatMessage[], options: RequestOptions = {}): Promise<string> {
  switch (cfg.provider) {
    case 'openai':
      return chatOpenAi(cfg, messages, options)
    case 'gemini':
      return chatGemini(cfg, messages, options)
    case 'claude':
      return chatClaude(cfg, messages, options)
    case 'ollama':
      return chatOllama(cfg, messages, options)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function chatOpenAi(cfg: ProviderConfig, messages: ChatMessage[], options: RequestOptions): Promise<string> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const r = await request(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify(openAiBody(cfg, { messages })),
  }, options)
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  return data.choices?.[0]?.message?.content || ''
}

async function chatGemini(cfg: ProviderConfig, messages: ChatMessage[], options: RequestOptions): Promise<string> {
  const { system, contents } = geminiContents(messages)
  const body: any = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const r = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model || '')}:generateContent`,
    { method: 'POST', headers: geminiHeaders(cfg), body: JSON.stringify(body) },
    options,
  )
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  return (data.candidates?.[0]?.content?.parts || [])
    .filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('')
}

async function chatClaude(cfg: ProviderConfig, messages: ChatMessage[], options: RequestOptions): Promise<string> {
  const { system, msgs } = claudeMessages(messages)
  const r = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(cfg),
    body: JSON.stringify({ model: cfg.model, system, messages: msgs, max_tokens: claudeMaxTokens(cfg.model) }),
  }, options)
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  return (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
}

async function chatOllama(cfg: ProviderConfig, messages: ChatMessage[], options: RequestOptions): Promise<string> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await request(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: false, options: ollamaOptions(cfg) }),
  }, options)
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await readText(r)}`)
  const data: any = await readJson(r)
  return data.message?.content || ''
}

/**
 * Genera una respuesta emitiendo el texto a medida que llega.
 *
 * Sólo se usa para la respuesta final sin tool calls. Si el proveedor no puede
 * hacer streaming o el flujo se corta antes de emitir nada, la llamada recae en
 * `chat` para no perder el turno. Una cancelación del usuario nunca reintenta.
 */
export async function chatStream(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions = {},
): Promise<string> {
  try {
    const streamed = await streamByProvider(cfg, messages, onChunk, options)
    if (streamed.trim()) return streamed
  } catch (error) {
    if (isCancellation(error) || options.signal?.aborted) throw new Error(CANCELLED_ERROR)
    /* se resuelve con la ruta no-streaming */
  }
  return chat(cfg, messages, options)
}

function streamByProvider(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions,
): Promise<string> {
  switch (cfg.provider) {
    case 'openai':
      return streamOpenAi(cfg, messages, onChunk, options)
    case 'claude':
      return streamClaude(cfg, messages, onChunk, options)
    case 'gemini':
      return streamGemini(cfg, messages, onChunk, options)
    case 'ollama':
      return streamOllama(cfg, messages, onChunk, options)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function streamOpenAi(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions,
): Promise<string> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const response = await request(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify(openAiBody(cfg, { messages, stream: true })),
  }, options)
  if (!response.ok) throw httpFailure(response, `OpenAI HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) => payload.choices?.[0]?.delta?.content || '', options)
}

async function streamClaude(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions,
): Promise<string> {
  const { system, msgs } = claudeMessages(messages)
  const response = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: claudeHeaders(cfg),
    body: JSON.stringify({ model: cfg.model, system, messages: msgs, max_tokens: claudeMaxTokens(cfg.model), stream: true }),
  }, options)
  if (!response.ok) throw httpFailure(response, `Claude HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) =>
    payload.type === 'content_block_delta' ? payload.delta?.text || '' : '', options)
}

async function streamGemini(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions,
): Promise<string> {
  const { system, contents } = geminiContents(messages)
  const body: any = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const response = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model || '')}:streamGenerateContent?alt=sse`,
    { method: 'POST', headers: geminiHeaders(cfg), body: JSON.stringify(body) },
    options,
  )
  if (!response.ok) throw httpFailure(response, `Gemini HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) =>
    (payload.candidates?.[0]?.content?.parts || [])
      .filter((part: any) => !part.thought).map((part: any) => part.text || '').join(''), options)
}

async function streamOllama(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: RequestOptions,
): Promise<string> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const response = await request(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: true, options: ollamaOptions(cfg) }),
  }, options)
  if (!response.ok) throw httpFailure(response, `Ollama HTTP ${response.status}`)
  return consumeLines(response, (line) => {
    const payload = safeJson(line)
    const text = payload?.message?.content || ''
    if (text) onChunk(text)
    return text
  }, options)
}

/** Lee un flujo `text/event-stream` y acumula el texto extraído de cada evento. */
async function consumeSse(
  response: Response,
  onChunk: (text: string) => void,
  extract: (payload: any) => string,
  options: RequestOptions,
): Promise<string> {
  return consumeLines(response, (line) => {
    if (!line.startsWith('data:')) return ''
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return ''
    const payload = safeJson(data)
    if (!payload) return ''
    const text = extract(payload)
    if (text) onChunk(text)
    return text
  }, options)
}

async function consumeLines(
  response: Response,
  handleLine: (line: string) => string,
  options: RequestOptions,
): Promise<string> {
  const body = response.body as unknown as AsyncIterable<Uint8Array> | null
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Respuesta sin flujo legible')

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  return readBody(response, async () => {
    for await (const chunk of body) {
      if (options.signal?.aborted) throw new Error(CANCELLED_ERROR)
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) accumulated += handleLine(trimmed)
      }
    }
    const tail = (buffer + decoder.decode()).trim()
    if (tail) accumulated += handleLine(tail)
    return accumulated
  })
}
