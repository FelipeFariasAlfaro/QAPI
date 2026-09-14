// Configuración de servidores MCP a partir de un único JSON.
//
// Formato aceptado (el mismo que usan VS Code / Claude Desktop):
// {
//   "mcpServers": {
//     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
//     "git":        { "command": "uvx", "args": ["mcp-server-git"], "env": { "KEY": "v" } }
//   }
// }
import { execFile } from 'child_process'
import { McpServerDef, McpValidation, McpServerIssue } from './types'

export const MCP_TEMPLATE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`

/** Parsea el JSON y valida su estructura. No ejecuta nada. */
export function parseMcpConfig(raw: string): { servers: McpServerDef[]; error?: string; issues: McpServerIssue[] } {
  const text = (raw || '').trim()
  if (!text) return { servers: [], issues: [] }

  let data: any
  try {
    data = JSON.parse(text)
  } catch (e: any) {
    return { servers: [], issues: [], error: `JSON inválido: ${String(e?.message || e)}` }
  }

  // Se acepta el objeto raíz con mcpServers, o directamente el mapa de servidores.
  const map = data?.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { servers: [], issues: [], error: 'Se esperaba un objeto "mcpServers" con los servidores.' }
  }

  const servers: McpServerDef[] = []
  const issues: McpServerIssue[] = []
  for (const [name, value] of Object.entries<any>(map)) {
    if (!name.trim()) {
      issues.push({ name: '(vacío)', ok: false, message: 'El nombre del servidor no puede estar vacío.' })
      continue
    }
    if (!value || typeof value !== 'object') {
      issues.push({ name, ok: false, message: 'La definición debe ser un objeto.' })
      continue
    }
    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (!command) {
      issues.push({ name, ok: false, message: 'Falta "command".' })
      continue
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== 'string'))) {
      issues.push({ name, ok: false, message: '"args" debe ser un arreglo de strings.' })
      continue
    }
    if (value.env !== undefined && (
      typeof value.env !== 'object' || Array.isArray(value.env) ||
      Object.values(value.env).some((item) => typeof item !== 'string')
    )) {
      issues.push({ name, ok: false, message: '"env" debe ser un objeto de strings.' })
      continue
    }
    servers.push({
      name,
      command,
      args: value.args || [],
      env: value.env || undefined,
    })
  }
  return { servers, issues }
}

/**
 * Valida la configuración: estructura + que el ejecutable de cada servidor
 * exista en el PATH. No arranca los servidores: los habilitados se inician de
 * forma efímera durante cada consulta del agente.
 */
export async function validateMcpConfig(raw: string): Promise<McpValidation> {
  const { servers, error, issues } = parseMcpConfig(raw)
  if (error) return { ok: false, error, servers: [], issues: [] }

  const checked: McpServerIssue[] = [...issues]
  await Promise.all(servers.map(async (s) => {
    const found = await commandExists(s.command)
    checked.push({
      name: s.name,
      ok: found,
      message: found ? `${s.command} ${s.args.join(' ')}`.trim() : `No se encontró el ejecutable "${s.command}" en el PATH.`,
    })
  }))

  checked.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: checked.every((c) => c.ok), servers, issues: checked }
}

/** Comprueba si un ejecutable está disponible en el sistema. */
function commandExists(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(finder, [command], { timeout: 3000 }, (err) => resolve(!err))
  })
}
