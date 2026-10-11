// Redacción reversible de secretos.
//
// El modelo nunca recibe el valor real de un secreto: recibe un marcador
// estable `[REDACTED_SECRET_<hash>]`. Cuando el modelo devuelve contenido para
// escribir (write_file / edit_file), los marcadores se restauran al valor real
// antes de preparar la propuesta. Sin esto, reescribir un archivo con
// credenciales de prueba sustituía los valores por `[REDACTED]` y las
// ediciones exactas no coincidían con el archivo real.
//
// El hash es determinista: si la extensión se reinicia, basta con volver a
// "aprender" el archivo real (`learnSecrets`) para resolver los marcadores que
// quedaron en memoria persistida o en el historial.
import { createHash } from 'crypto'

const MAX_ENTRIES = 5000
const MARKER_RE = /\[REDACTED_SECRET_([a-f0-9]{12})\]/g

const byHash = new Map<string, string>()

function markerFor(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12)
  if (!byHash.has(hash) && byHash.size < MAX_ENTRIES) byHash.set(hash, value)
  return `[REDACTED_SECRET_${hash}]`
}

/** Patrones de secretos: la parte capturada en `secret` es la que se oculta. */
const WHOLE_MATCH_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:sk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

/** Prefijo conservado + valor oculto. */
const PREFIXED_PATTERNS: RegExp[] = [
  /((?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|token|password|passwd|pwd|secret|authorization)\s*[:=]\s*["']?)([^\s"'`,;]+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+\/-]{12,})/gi,
  // Credenciales embebidas en URLs: scheme://user:password@host
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi,
]

/** Oculta secretos con marcadores reversibles. */
export function redactSecrets(value: string): string {
  if (!value) return value
  let output = value
  for (const pattern of WHOLE_MATCH_PATTERNS) {
    output = output.replace(pattern, (match) => isMarker(match) ? match : markerFor(match))
  }
  PREFIXED_PATTERNS.forEach((pattern, index) => {
    output = output.replace(pattern, (match, prefix: string, secret: string) => {
      if (isMarker(secret) || secret.startsWith('[REDACTED')) return match
      // En `password: string` o `token = os.getenv(...)` el "valor" es código,
      // no un secreto: ocultarlo confundía al modelo al escribir pruebas.
      if (index === 0 && looksLikeCode(secret)) return match
      return `${prefix}${markerFor(secret)}`
    })
  })
  return output
}

function looksLikeCode(value: string): boolean {
  if (/[()[\]{}$<>]/.test(value)) return true
  if (/^(?:string|number|boolean|bool|any|str|int|float|none|null|undefined|true|false|optional|required|object|dict)$/i.test(value)) return true
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)
}

/** Registra los secretos de un contenido real para poder restaurar sus marcadores. */
export function learnSecrets(value: string | undefined): void {
  if (value) redactSecrets(value)
}

/** Sustituye los marcadores conocidos por su valor real. */
export function restoreSecrets(value: string): string {
  if (!value || !value.includes('[REDACTED_SECRET_')) return value
  return value.replace(MARKER_RE, (marker, hash: string) => byHash.get(hash) ?? marker)
}

/** Marcadores que siguen sin resolverse después de restaurar. */
export function unresolvedSecrets(value: string): string[] {
  return [...new Set(value.match(MARKER_RE) || [])]
}

function isMarker(value: string): boolean {
  return /^\[REDACTED_SECRET_[a-f0-9]{12}\]$/.test(value)
}
