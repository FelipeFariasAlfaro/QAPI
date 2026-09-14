// Adaptadores de proveedores de IA: validar credenciales, listar modelos y
// generar respuestas. Se usa fetch nativo (Node 18+); sin dependencias.
import { ProviderConfig } from './types'

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
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
}

export interface ValidationResult {
  ok: boolean
  models: string[]
  /** Límite real de contexto (tokens) por modelo, cuando la API lo expone. */
  limits?: Record<string, number>
  message?: string
}

const DEFAULT_OLLAMA = 'http://localhost:11434'

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
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey || ''}` },
  })
  if (!r.ok) return { ok: false, models: [], message: `HTTP ${r.status}` }
  const data: any = await r.json()
  const models = (data.data || [])
    .map((m: any) => m.id as string)
    .filter((id: string) => /gpt|o1|o3|o4/i.test(id))
    .sort()
  return { ok: true, models }
}

async function listGeminiModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.apiKey || '')}`,
  )
  if (!r.ok) return { ok: false, models: [], message: `HTTP ${r.status}` }
  const data: any = await r.json()
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
  const r = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
  })
  if (!r.ok) return { ok: false, models: [], message: `HTTP ${r.status}` }
  const data: any = await r.json()
  const models = (data.data || []).map((m: any) => m.id as string)
  return { ok: true, models }
}

async function listOllamaModels(cfg: ProviderConfig): Promise<ValidationResult> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await fetch(`${base}/api/tags`)
  if (!r.ok) return { ok: false, models: [], message: `Ollama no responde (HTTP ${r.status})` }
  const data: any = await r.json()
  const models = (data.models || []).map((m: any) => m.name as string)
  // Ollama expone el context_length real por modelo vía /api/show.
  const limits: Record<string, number> = {}
  await Promise.all(models.map(async (name: string) => {
    try {
      const sr = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!sr.ok) return
      const info: any = await sr.json()
      const ctx = findContextLength(info?.model_info)
      if (ctx) limits[name] = ctx
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

/**
 * Genera una respuesta permitiendo que el modelo invoque herramientas.
 * Devuelve el texto y las llamadas a herramienta detectadas. Usar esto en vez
 * de pedir formatos de texto ad-hoc: es mucho más fiable entre proveedores.
 */
export async function chatWithTools(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<ChatResult> {
  switch (cfg.provider) {
    case 'openai':
      return chatOpenAiTools(cfg, messages, tools)
    case 'gemini':
      return chatGeminiTools(cfg, messages, tools)
    case 'claude':
      return chatClaudeTools(cfg, messages, tools)
    case 'ollama':
      return chatOllamaTools(cfg, messages, tools)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function chatOpenAiTools(cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  })
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  const msg = data.choices?.[0]?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls || []).map((c: any) => ({
    name: c.function?.name,
    args: safeJson(c.function?.arguments),
  }))
  return { text: msg?.content || '', toolCalls }
}

async function chatGeminiTools(cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const body: any = {
    contents,
    tools: [{
      functionDeclarations: tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      })),
    }],
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  const parts: any[] = data.candidates?.[0]?.content?.parts || []
  const text = parts.filter((p) => p.text).map((p) => p.text).join('')
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }))
  return { text, toolCalls }
}

async function chatClaudeTools(cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model, system, messages: msgs, max_tokens: 8192,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  })
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  const blocks: any[] = data.content || []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name, args: b.input || {} }))
  return { text, toolCalls }
}

async function chatOllamaTools(cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, messages, stream: false,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  const toolCalls: ToolCall[] = (data.message?.tool_calls || []).map((c: any) => ({
    name: c.function?.name,
    args: typeof c.function?.arguments === 'string' ? safeJson(c.function.arguments) : (c.function?.arguments || {}),
  }))
  return { text: data.message?.content || '', toolCalls }
}

function safeJson(s: unknown): Record<string, any> {
  if (typeof s !== 'string') return (s as any) || {}
  try { return JSON.parse(s) } catch { return {} }
}

/** Genera una respuesta (no streaming). Devuelve el texto completo. */
export async function chat(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  switch (cfg.provider) {
    case 'openai':
      return chatOpenAi(cfg, messages)
    case 'gemini':
      return chatGemini(cfg, messages)
    case 'claude':
      return chatClaude(cfg, messages)
    case 'ollama':
      return chatOllama(cfg, messages)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function chatOpenAi(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey || ''}`,
    },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3 }),
  })
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  return data.choices?.[0]?.message?.content || ''
}

async function chatGemini(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const body: any = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  return data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || ''
}

async function chatClaude(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: cfg.model, system, messages: msgs, max_tokens: 4096 }),
  })
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  return data.content?.map((c: any) => c.text).join('') || ''
}

async function chatOllama(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`)
  const data: any = await r.json()
  return data.message?.content || ''
}

/**
 * Genera una respuesta emitiendo el texto a medida que llega.
 *
 * Sólo se usa para la respuesta final sin tool calls. Si el proveedor no puede
 * hacer streaming o el flujo se corta antes de emitir nada, la llamada recae en
 * `chat` para no perder el turno.
 */
export async function chatStream(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  try {
    const streamed = await streamByProvider(cfg, messages, onChunk)
    if (streamed.trim()) return streamed
  } catch { /* se resuelve con la ruta no-streaming */ }
  return chat(cfg, messages)
}

function streamByProvider(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  switch (cfg.provider) {
    case 'openai':
      return streamOpenAi(cfg, messages, onChunk)
    case 'claude':
      return streamClaude(cfg, messages, onChunk)
    case 'gemini':
      return streamGemini(cfg, messages, onChunk)
    case 'ollama':
      return streamOllama(cfg, messages, onChunk)
    default:
      throw new Error('Proveedor no soportado')
  }
}

async function streamOpenAi(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream: true }),
  })
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) => payload.choices?.[0]?.delta?.content || '')
}

async function streamClaude(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: cfg.model, system, messages: msgs, max_tokens: 4096, stream: true }),
  })
  if (!response.ok) throw new Error(`Claude HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) =>
    payload.type === 'content_block_delta' ? payload.delta?.text || '' : '')
}

async function streamGemini(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const body: any = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey || '')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`)
  return consumeSse(response, onChunk, (payload) =>
    (payload.candidates?.[0]?.content?.parts || []).map((part: any) => part.text || '').join(''))
}

async function streamOllama(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const base = cfg.baseUrl || DEFAULT_OLLAMA
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
  })
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
  return consumeLines(response, (line) => {
    const payload = safeJson(line)
    const text = payload?.message?.content || ''
    if (text) onChunk(text)
    return text
  })
}

/** Lee un flujo `text/event-stream` y acumula el texto extraído de cada evento. */
async function consumeSse(
  response: Response,
  onChunk: (text: string) => void,
  extract: (payload: any) => string,
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
  })
}

async function consumeLines(
  response: Response,
  handleLine: (line: string) => string,
): Promise<string> {
  const body = response.body as unknown as AsyncIterable<Uint8Array> | null
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Respuesta sin flujo legible')

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  for await (const chunk of body) {
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
}
