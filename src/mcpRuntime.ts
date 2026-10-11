import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import { parseMcpConfig } from './mcp'
import type { ToolDef } from './providers'
import type { McpServerDef } from './types'

const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_TOOLS = 128
const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 64 * 1024

export interface McpRuntimeTool {
  exposedName: string
  serverName: string
  remoteName: string
  definition: ToolDef
}

export interface McpRuntime {
  tools: McpRuntimeTool[]
  issues: string[]
  call(name: string, args: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

type ProgressCallback = (serverName: string, detail: string) => void

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type ListedTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type ToolBinding = {
  client: StdioMcpClient
  remoteName: string
}

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuffer = Buffer.alloc(0)
  private stderrTail = Buffer.alloc(0)
  private terminalError: Error | undefined
  private closed = false
  private cleanupStarted = false

  constructor(
    readonly serverName: string,
    server: McpServerDef,
    cwd: string,
  ) {
    // En Windows `npx`, `uvx`, etc. son `.cmd`/`.bat`: desde Node 18.20/20.12
    // sólo se pueden lanzar con shell. Los argumentos se citan para cmd.exe.
    const windowsShim = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(server.command)
    this.child = windowsShim
      ? spawn([server.command, ...server.args].map(quoteForCmd).join(' '), {
        cwd,
        env: { ...process.env, ...(server.env ?? {}) },
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      : spawn(server.command, server.args, {
        cwd,
        env: { ...process.env, ...(server.env ?? {}) },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    // Always consume stderr so a noisy server cannot block on a full pipe. Only
    // a bounded tail is retained for diagnostics.
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.retainStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    this.child.on('error', (error) => {
      this.fail(new Error(`No se pudo iniciar: ${error.message}`))
    })
    this.child.on('exit', (code, signal) => {
      if (this.closed) return
      const reason = signal ? `señal ${signal}` : `código ${code ?? 'desconocido'}`
      this.fail(new Error(`El servidor terminó (${reason}).${this.stderrSuffix()}`))
    })
    this.child.stdin.on('error', (error) => {
      if (!this.closed) this.fail(new Error(`Falló la entrada estándar: ${error.message}`))
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'qa-pi', version: '1.0.0' },
    })
    this.notify('notifications/initialized', {})
  }

  async listTools(limit: number): Promise<{ tools: ListedTool[]; truncated: boolean }> {
    const tools: ListedTool[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()

    while (tools.length < limit) {
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new Error('tools/list devolvió una respuesta inválida.')
      }

      for (const candidate of result.tools) {
        if (tools.length >= limit) break
        if (!isRecord(candidate) || typeof candidate.name !== 'string' || !candidate.name.trim()) continue
        tools.push({
          name: candidate.name,
          description: typeof candidate.description === 'string' ? candidate.description : undefined,
          inputSchema: isRecord(candidate.inputSchema) ? candidate.inputSchema : undefined,
        })
      }

      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined
      if (!nextCursor) return { tools, truncated: false }
      if (seenCursors.has(nextCursor)) {
        throw new Error('tools/list repitió el cursor de paginación.')
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return { tools, truncated: true }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }, REQUEST_TIMEOUT_MS)
    return renderToolResult(result)
  }

  async close(reason = 'El runtime MCP se cerró.'): Promise<void> {
    if (this.cleanupStarted) return
    this.cleanupStarted = true
    this.closed = true
    this.rejectPending(new Error(reason))
    this.stdoutBuffer = Buffer.alloc(0)

    if (!this.child.stdin.destroyed) this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    await waitForExit(this.child, 500)
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await waitForExit(this.child, 500)
    }
  }

  diagnostics(): string {
    return this.stderrTail.toString('utf8').trim()
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(this.terminalError ?? new Error('El servidor MCP está cerrado.'))

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timeout de ${timeoutMs} ms en ${method}.`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })

      try {
        this.writeMessage({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(asError(error))
      }
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) throw this.terminalError ?? new Error('El servidor MCP está cerrado.')
    this.writeMessage({ jsonrpc: '2.0', method, params })
  }

  private writeMessage(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line, 'utf8') - 1 > MAX_LINE_BYTES) {
      throw new Error(`El mensaje excede el límite de ${MAX_LINE_BYTES} bytes por línea.`)
    }
    this.child.stdin.write(line)
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.closed) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])

    while (!this.closed) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
          this.protocolFailure(`Una línea excedió el límite de ${MAX_LINE_BYTES} bytes.`)
        }
        return
      }
      if (newline > MAX_LINE_BYTES) {
        this.protocolFailure(`Una línea excedió el límite de ${MAX_LINE_BYTES} bytes.`)
        return
      }

      let line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length === 0) continue

      try {
        this.handleMessage(JSON.parse(line.toString('utf8')) as unknown)
      } catch (error) {
        this.protocolFailure(`JSON-RPC inválido: ${asError(error).message}`)
      }
    }
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return
    // Peticiones/notificaciones del servidor (traen `method`): no son respuestas.
    // Antes, un `ping` con un id coincidente resolvía una petición del cliente.
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) return
      const reply = message.method === 'ping'
        ? { jsonrpc: '2.0', id: message.id, result: {} }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Método no soportado: ${message.method}` } }
      try { this.writeMessage(reply) } catch { /* el servidor ya cerró */ }
      return
    }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return
    const numericId = typeof message.id === 'number' ? message.id : Number(message.id)
    if (!Number.isSafeInteger(numericId)) return

    const pending = this.pending.get(numericId)
    if (!pending) return
    this.pending.delete(numericId)
    clearTimeout(pending.timer)

    if (message.error !== undefined) {
      const rpcError = isRecord(message.error) ? message.error : undefined
      const detail = rpcError && typeof rpcError.message === 'string'
        ? rpcError.message
        : safeStringify(message.error)
      pending.reject(new Error(`Error JSON-RPC: ${detail}`))
      return
    }
    pending.resolve(message.result)
  }

  private protocolFailure(message: string): void {
    this.fail(new Error(`${message}${this.stderrSuffix()}`))
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.terminalError = error
    this.closed = true
    this.stdoutBuffer = Buffer.alloc(0)
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private retainStderr(chunk: Buffer): void {
    if (chunk.length >= MAX_STDERR_BYTES) {
      this.stderrTail = Buffer.from(chunk.subarray(chunk.length - MAX_STDERR_BYTES))
      return
    }
    const overflow = this.stderrTail.length + chunk.length - MAX_STDERR_BYTES
    const retained = overflow > 0 ? this.stderrTail.subarray(overflow) : this.stderrTail
    this.stderrTail = Buffer.concat([retained, chunk])
  }

  private stderrSuffix(): string {
    const stderr = this.diagnostics()
    return stderr ? ` stderr: ${stderr}` : ''
  }
}

// ── Pool persistente ────────────────────────────────────────────────────────
//
// Antes cada mensaje del chat arrancaba y cerraba todos los servidores MCP
// habilitados (con `npx`, varios segundos por turno aunque no se usaran). Ahora
// se reutiliza una conexión mientras la configuración no cambie, y se apaga
// tras un período de inactividad o si algún servidor murió.

const IDLE_SHUTDOWN_MS = 10 * 60_000
/** Con servidores que fallaron, se reintenta como mucho cada este intervalo. */
const FAILED_RETRY_MS = 2 * 60_000

interface InternalRuntime extends McpRuntime {
  alive(): boolean
  call(name: string, args: Record<string, unknown>, onProgress?: ProgressCallback): Promise<string>
}

interface PoolEntry {
  key: string
  runtime: Promise<InternalRuntime>
  createdAt: number
  inUse: number
  idleTimer?: NodeJS.Timeout
}

let poolEntry: PoolEntry | undefined

function closeEntry(entry: PoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  void entry.runtime.then((runtime) => runtime.close()).catch(() => undefined)
}

function scheduleIdle(entry: PoolEntry): void {
  if (entry.inUse > 0) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => {
    if (poolEntry === entry && entry.inUse === 0) {
      poolEntry = undefined
      closeEntry(entry)
    }
  }, IDLE_SHUTDOWN_MS)
  entry.idleTimer.unref?.()
}

/** Cierra los servidores MCP del pool (al desactivar la extensión o cambiar de workspace). */
export async function shutdownMcpPool(): Promise<void> {
  const entry = poolEntry
  poolEntry = undefined
  if (!entry) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  try { await (await entry.runtime).close() } catch { /* ya cerrado */ }
}

/**
 * Devuelve un runtime MCP listo para usar. `close()` sólo libera el préstamo;
 * los servidores siguen vivos en el pool para el siguiente mensaje.
 */
export async function openMcpRuntime(
  raw: string,
  enabled: Readonly<Record<string, boolean>>,
  cwd: string,
  onProgress?: ProgressCallback,
): Promise<McpRuntime> {
  const enabledNames = Object.keys(enabled).filter((name) => enabled[name] === true).sort()
  if (!enabledNames.length) {
    if (poolEntry) await shutdownMcpPool()
    return { tools: [], issues: [], call: async () => '', close: async () => {} }
  }
  const key = createHash('sha256').update(JSON.stringify([raw, enabledNames, cwd])).digest('hex')

  if (poolEntry && poolEntry.key !== key) {
    closeEntry(poolEntry)
    poolEntry = undefined
  }
  if (poolEntry) {
    const existing = await poolEntry.runtime.catch(() => undefined)
    const retryFailures = existing && existing.issues.length > 0 && Date.now() - poolEntry.createdAt > FAILED_RETRY_MS
    if (!existing || !existing.alive() || retryFailures) {
      closeEntry(poolEntry)
      poolEntry = undefined
    }
  }
  if (!poolEntry) {
    poolEntry = { key, runtime: createMcpRuntime(raw, enabled, cwd, onProgress), createdAt: Date.now(), inUse: 0 }
  }

  const entry = poolEntry
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.inUse++
  let runtime: InternalRuntime
  try {
    runtime = await entry.runtime
  } catch (error) {
    entry.inUse--
    if (poolEntry === entry) poolEntry = undefined
    throw error
  }
  let released = false
  return {
    tools: runtime.tools,
    issues: runtime.issues,
    call: (name, args) => runtime.call(name, args, onProgress),
    close: async () => {
      if (released) return
      released = true
      entry.inUse = Math.max(0, entry.inUse - 1)
      if (poolEntry === entry) scheduleIdle(entry)
      else if (entry.inUse === 0) closeEntry(entry)
    },
  }
}

export interface McpProbeResult {
  ok: boolean
  tools: { name: string; description?: string }[]
  message?: string
  durationMs: number
}

/**
 * Prueba un servidor de la configuración: lo inicia, lista sus tools y lo
 * cierra. No usa el pool ni lo habilita para el chat.
 */
export async function probeMcpServer(raw: string, name: string, cwd: string): Promise<McpProbeResult> {
  const startedAt = Date.now()
  const runtime = await createMcpRuntime(raw, { [name]: true }, cwd)
  try {
    const ownIssues = runtime.issues.filter((issue) => issue.startsWith(`${name}:`))
    const tools = runtime.tools.map((tool) => ({
      name: tool.remoteName,
      description: tool.definition.description?.slice(0, 160),
    }))
    const connected = runtime.alive() && ownIssues.every((issue) => /se limitó a/.test(issue))
    return {
      ok: connected,
      tools,
      message: connected ? undefined : (ownIssues[0]?.slice(name.length + 1).trim() || 'El servidor no respondió.'),
      durationMs: Date.now() - startedAt,
    }
  } finally {
    await runtime.close()
  }
}

async function createMcpRuntime(
  raw: string,
  enabled: Readonly<Record<string, boolean>>,
  cwd: string,
  onProgress?: ProgressCallback,
): Promise<InternalRuntime> {
  const parsed = parseMcpConfig(raw)
  const issues: string[] = parsed.issues.map((issue) => `${issue.name}: ${issue.message}`)
  if (parsed.error) issues.push(parsed.error)

  const activeServers = parsed.servers.filter((server) => enabled[server.name] === true)
  const settled = await Promise.all(activeServers.map(async (server) => {
    progress(onProgress, server.name, 'Conectando servidor MCP…')
    let client: StdioMcpClient | undefined
    try {
      client = new StdioMcpClient(server.name, server, cwd)
      await client.initialize()
      const listed = await client.listTools(MAX_TOOLS)
      progress(onProgress, server.name, `${listed.tools.length} herramienta(s) disponible(s).`)
      return { server, client, listed }
    } catch (error) {
      const stderr = client?.diagnostics() ?? ''
      if (client) await client.close(`Falló la inicialización de ${server.name}.`)
      const suffix = stderr ? ` stderr: ${stderr}` : ''
      issues.push(`${server.name}: ${asError(error).message}${suffix}`)
      progress(onProgress, server.name, `No disponible: ${asError(error).message}`)
      return undefined
    }
  }))

  const tools: McpRuntimeTool[] = []
  const bindings = new Map<string, ToolBinding>()
  const clients: StdioMcpClient[] = []
  const usedAliases = new Set<string>()
  let omitted = 0

  for (const connection of settled) {
    if (!connection) continue
    clients.push(connection.client)
    if (connection.listed.truncated) {
      issues.push(`${connection.server.name}: tools/list se limitó a ${MAX_TOOLS} herramientas.`)
    }

    for (const remote of connection.listed.tools) {
      if (tools.length >= MAX_TOOLS) {
        omitted++
        continue
      }
      const exposedName = uniqueAlias(connection.server.name, remote.name, usedAliases)
      const schema = sanitizeSchema(remote.inputSchema)
      const definition: ToolDef = {
        name: exposedName,
        description: (remote.description?.trim() || `Herramienta MCP ${connection.server.name}/${remote.name}`).slice(0, 1024),
        parameters: schema,
      }
      tools.push({
        exposedName,
        serverName: connection.server.name,
        remoteName: remote.name,
        definition,
      })
      bindings.set(exposedName, { client: connection.client, remoteName: remote.name })
    }
  }

  if (omitted > 0) issues.push(`Se omitieron ${omitted} herramientas al alcanzar el límite global de ${MAX_TOOLS}.`)

  let runtimeClosed = false
  return {
    tools,
    issues,
    alive: () => !runtimeClosed && clients.every((client) => client.isAlive()),
    async call(name: string, args: Record<string, unknown>, callProgress?: ProgressCallback): Promise<string> {
      if (runtimeClosed) throw new Error('El runtime MCP está cerrado.')
      const binding = bindings.get(name)
      if (!binding) throw new Error(`Herramienta MCP desconocida: ${name}`)
      const safeArgs = isRecord(args) ? args : {}
      progress(callProgress ?? onProgress, name, 'Ejecutando herramienta MCP…')
      return binding.client.callTool(binding.remoteName, safeArgs)
    },
    async close(): Promise<void> {
      if (runtimeClosed) return
      runtimeClosed = true
      await Promise.all(clients.map((client) => client.close()))
    },
  }
}

/** Cita un argumento para cmd.exe (sólo se usa en Windows con shims .cmd). */
function quoteForCmd(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value
  // Dentro de comillas, cmd.exe trata literalmente & | < > ^; sólo se duplican las comillas.
  return `"${value.replace(/"/g, '""')}"`
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve() }
    const timer = setTimeout(done, timeoutMs)
    child.once('exit', done)
  })
}

function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} }
  try {
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 32 * 1024) return { type: 'object', properties: {} }
    return normalizeSchemaNode(schema, 0, true)
  } catch {
    return { type: 'object', properties: {} }
  }
}

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])
const MAX_VARIANTS = 10

/**
 * Normaliza un JSON Schema de MCP a un subconjunto que aceptan todos los
 * proveedores. Conserva `anyOf`/`oneOf` y los tipos múltiples (antes se
 * convertían en `string` y el modelo enviaba argumentos del tipo equivocado).
 * `null` se descarta: basta con no enviar el campo, y no todos los proveedores
 * aceptan `type: "null"` o `nullable`.
 */
export function normalizeSchemaNode(value: unknown, depth: number, root = false): Record<string, unknown> {
  if (!isRecord(value) || depth > 6) return root ? { type: 'object', properties: {} } : { type: 'string' }
  if (root) return withDescription(typedSchemaNode(value, 'object', depth), value)

  const variants = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined
  if (variants) {
    const branches = variants
      .filter((branch) => isRecord(branch) && branch.type !== 'null')
      .slice(0, MAX_VARIANTS)
      .map((branch) => normalizeSchemaNode(branch, depth + 1))
    if (branches.length === 0) return withDescription({ type: 'string' }, value)
    if (branches.length === 1) return withDescription(branches[0], value)
    return withDescription({ anyOf: branches }, value)
  }

  const declared = (Array.isArray(value.type) ? value.type : [value.type])
    .filter((type): type is string => typeof type === 'string' && SCHEMA_TYPES.has(type))
  const types = declared.length ? [...new Set(declared)] : [inferSchemaType(value)]
  if (types.length > 1) {
    return withDescription({ anyOf: types.map((type) => typedSchemaNode(value, type, depth)) }, value)
  }
  return withDescription(typedSchemaNode(value, types[0], depth), value)
}

function inferSchemaType(value: Record<string, unknown>): string {
  if (isRecord(value.properties)) return 'object'
  if (value.items !== undefined) return 'array'
  return 'string'
}

function withDescription(node: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.description === 'string' && node.description === undefined) node.description = value.description.slice(0, 500)
  return node
}

function typedSchemaNode(value: Record<string, unknown>, type: string, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = { type }
  if (Array.isArray(value.enum)) {
    const expected = type === 'integer' ? 'number' : type
    const values = value.enum.slice(0, 50).filter((item) => typeof item === expected)
    if (values.length) output.enum = values
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value.minimum === 'number') output.minimum = value.minimum
    if (typeof value.maximum === 'number') output.maximum = value.maximum
  }
  if (type === 'object') {
    const properties: Record<string, unknown> = {}
    if (isRecord(value.properties)) {
      for (const [name, child] of Object.entries(value.properties).slice(0, 100)) {
        properties[name] = normalizeSchemaNode(child, depth + 1)
      }
    }
    output.properties = properties
    if (Array.isArray(value.required)) output.required = value.required.filter((item): item is string => typeof item === 'string' && item in properties)
  } else if (type === 'array') {
    output.items = normalizeSchemaNode(value.items, depth + 1)
  }
  return output
}

function uniqueAlias(serverName: string, remoteName: string, used: Set<string>): string {
  const serverSlug = slug(serverName).slice(0, 20)
  const toolSlug = slug(remoteName).slice(0, 24)
  let salt = 0
  while (true) {
    const identity = `${serverName}\0${remoteName}\0${salt}`
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 10)
    const alias = `mcp_${serverSlug}_${toolSlug}_${hash}`
    if (!used.has(alias)) {
      used.add(alias)
      return alias
    }
    salt++
  }
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'unnamed'
}

function renderToolResult(value: unknown): string {
  const result = isRecord(value) ? value : {}
  const parts: string[] = []

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) continue
      const type = typeof item.type === 'string' ? item.type : 'unknown'
      if (type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if ((type === 'image' || type === 'audio') && typeof item.data === 'string') {
        parts.push(binaryMetadata(type, item.mimeType, item.data))
      } else if (type === 'resource' && isRecord(item.resource)) {
        const resource = item.resource
        if (typeof resource.text === 'string') {
          parts.push(resource.text)
        } else if (typeof resource.blob === 'string') {
          const label = typeof resource.uri === 'string' ? `resource ${resource.uri}` : 'resource'
          parts.push(binaryMetadata(label, resource.mimeType, resource.blob))
        } else {
          parts.push(`[resource${typeof resource.uri === 'string' ? `: ${resource.uri}` : ''}]`)
        }
      } else if (type === 'resource_link') {
        const uri = typeof item.uri === 'string' ? `: ${item.uri}` : ''
        parts.push(`[resource_link${uri}]`)
      } else {
        parts.push(`[contenido MCP ${type}]`)
      }
    }
  }

  if (result.structuredContent !== undefined) {
    parts.push(`structuredContent:\n${safeStringify(result.structuredContent)}`)
  }

  if (parts.length === 0) {
    parts.push(safeStringify(value))
  }
  if (result.isError === true) parts.unshift('Error MCP:')
  return truncateUtf8(parts.join('\n'), MAX_RESULT_BYTES)
}

function binaryMetadata(label: string, mimeType: unknown, base64: string): string {
  const mime = typeof mimeType === 'string' && mimeType ? `, ${mimeType}` : ''
  const compactLength = base64.replace(/\s/g, '').length
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = Math.max(0, Math.floor(compactLength * 3 / 4) - padding)
  return `[${label}${mime}, ${bytes} bytes binarios omitidos]`
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return '[valor no serializable]'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function progress(callback: ProgressCallback | undefined, serverName: string, detail: string): void {
  try {
    callback?.(serverName, detail)
  } catch {
    // El progreso es observacional y nunca debe afectar al protocolo.
  }
}
