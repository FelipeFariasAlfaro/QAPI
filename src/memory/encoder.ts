// Codificador determinista de texto y código a vectores de contenido.
//
// No usa modelos: extrae rasgos (raíces de palabras, identificadores partidos
// en camelCase/snake_case, conceptos bilingües del glosario, bigramas y
// trigramas de caracteres) y los proyecta con una proyección aleatoria dispersa
// (feature hashing con signo) a DIM dimensiones. La misma entrada produce
// siempre el mismo vector, en cualquier máquina.
import { CONCEPT_GROUPS } from './glossary'
import { DIM, fnv1a, normalizeInPlace, rng } from './hdc'

export type FeatureBag = Map<string, number>

/** Peso de los conceptos del glosario por palabra cubierta (expuesto para medir variantes). */
export const ENCODER_TUNING = { conceptPerWord: 2 }

/** Posiciones por rasgo en la proyección dispersa. */
const SPREAD = 4
const MAX_TOKENS = 4000
const MAX_TRIGRAMS = 300

const STOPWORDS = new Set([
  // español
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'en', 'y', 'o', 'u', 'que', 'por', 'para',
  'con', 'sin', 'se', 'su', 'sus', 'lo', 'le', 'les', 'es', 'son', 'esta', 'este', 'estos', 'estas', 'eso', 'esto', 'como',
  'donde', 'cuando', 'cual', 'cuales', 'qué', 'que', 'mi', 'mis', 'tu', 'tus', 'me', 'te', 'nos', 'ya', 'muy', 'mas', 'pero',
  'si', 'no', 'hay', 'ser', 'fue', 'era', 'han', 'ha', 'he', 'hace', 'hacer', 'tiene', 'tener', 'puede', 'puedo', 'debe',
  'cada', 'otro', 'otra', 'sobre', 'entre', 'desde', 'hasta', 'tambien', 'solo', 'cómo', 'dónde', 'forma', 'manera', 'dado',
  'entonces', 'pero', 'ante',
  // relleno típico de preguntas ("cómo funciona X en este proyecto"); "función" se conserva
  'funciona', 'funcionan', 'funcionar', 'funcionamiento', 'works', 'work',
  // inglés
  'the', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'and', 'or', 'is', 'are', 'be', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'if', 'then', 'else', 'when', 'given', 'but', 'not', 'how', 'what', 'where', 'which', 'do',
  'does', 'can', 'should', 'into', 'out', 'up', 'so', 'we', 'you', 'my', 'our',
  // palabras clave de código muy frecuentes
  'def', 'return', 'self', 'none', 'true', 'false', 'null', 'undefined', 'const', 'let', 'var', 'function', 'import', 'export',
  'from', 'class', 'public', 'private', 'protected', 'static', 'void', 'new', 'this', 'await', 'async', 'try', 'except', 'catch',
  'finally', 'raise', 'throw', 'pass', 'elif', 'while', 'for', 'in', 'lambda', 'yield', 'string', 'str', 'int', 'bool', 'dict',
  'list', 'any', 'interface', 'extends', 'implements', 'package', 'java', 'util', 'lang', 'args', 'kwargs', 'utf',
  // sintaxis Gherkin (aparece en cada paso y no distingue nada)
  'and', 'pero', 'cuando', 'entonces', 'dado', 'dada', 'dados', 'dadas',
])

/** Plural español/inglés, después sufijo derivativo y vocal final de género. */
const DERIVATIONAL = [
  'amiento', 'imiento', 'ieron', 'acion', 'icion', 'ucion', 'mente', 'ancia', 'encia', 'iendo', 'aron', 'ador', 'idor', 'ante',
  'able', 'ible', 'ista', 'ando', 'cion', 'sion', 'ment', 'ness', 'less', 'amos', 'emos', 'imos', 'aban', 'ado', 'ido', 'ada',
  'ida', 'ing', 'ion', 'ity', 'ive', 'ous', 'ful', 'ian', 'er', 'ar', 'ir', 'an', 'en', 'ed', 'ly',
]

export function stem(word: string): string {
  let w = word
  if (w.length <= 3) return w
  if (w.endsWith('es') && w.length > 4 && !/[aeiou]/.test(w[w.length - 3])) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1)
  for (const suffix of DERIVATIONAL) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) { w = w.slice(0, -suffix.length); break }
  }
  if (w.length > 4 && /[aoe]$/.test(w)) w = w.slice(0, -1)
  return w
}

export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Palabras crudas → partes en minúscula (camelCase, snake_case, kebab-case). */
export function splitWords(text: string): { parts: string[]; compound?: string }[] {
  const out: { parts: string[]; compound?: string }[] = []
  const raw = foldAccents(text).match(/[A-Za-z0-9_]+/g) || []
  for (const word of raw.slice(0, MAX_TOKENS)) {
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 2 && !/^\d+$/.test(part))
    if (!parts.length) continue
    out.push({ parts, compound: parts.length > 1 ? parts.join('') : undefined })
  }
  return out
}

// ── Glosario: frase normalizada → concepto ─────────────────────────────────
const CONCEPTS = new Map<string, string>()
let maxPhrase = 1
for (let group = 0; group < CONCEPT_GROUPS.length; group++) {
  for (const entry of CONCEPT_GROUPS[group]) {
    const stems = splitWords(entry).flatMap((word) => word.parts).filter((part) => !STOPWORDS.has(part)).map(stem)
    if (!stems.length) continue
    maxPhrase = Math.max(maxPhrase, stems.length)
    CONCEPTS.set(stems.join(' '), `c:${group}`)
  }
}

/** Raíces del texto en orden, sin palabras vacías. Útil para mostrar o depurar. */
export function stemsOf(text: string): string[] {
  return splitWords(text).flatMap((word) => word.parts).filter((part) => !STOPWORDS.has(part)).map(stem)
}

/**
 * Añade los rasgos de un texto a una bolsa con el peso indicado.
 * El peso de cada raíz es sublineal en su frecuencia (1 + log tf).
 */
export function addTextFeatures(
  bag: FeatureBag,
  text: string,
  weight: number,
  options: { bigrams?: boolean; trigrams?: boolean } = {},
): void {
  if (!text || weight <= 0) return
  const counts = new Map<string, number>()
  const bump = (key: string, amount: number) => counts.set(key, (counts.get(key) || 0) + amount)
  const sequence: string[] = []
  for (const word of splitWords(text)) {
    for (const part of word.parts) {
      if (STOPWORDS.has(part)) continue
      const root = stem(part)
      sequence.push(root)
      bump(`t:${root}`, 1)
    }
    if (word.compound && !STOPWORDS.has(word.compound)) bump(`i:${word.compound}`, 0.7)
  }
  // Conceptos del glosario: frases de hasta maxPhrase raíces consecutivas. El
  // concepto pesa en proporción a las palabras que cubre: es el único puente
  // entre "aserciones suaves" y "soft assertions", y antes pesaba menos que las
  // propias palabras en español, que el documento en inglés no contiene.
  for (let i = 0; i < sequence.length; i++) {
    for (let n = Math.min(maxPhrase, sequence.length - i); n >= 1; n--) {
      const concept = CONCEPTS.get(sequence.slice(i, i + n).join(' '))
      if (concept) { bump(concept, ENCODER_TUNING.conceptPerWord * n); i += n - 1; break }
    }
  }
  if (options.bigrams !== false) {
    for (let i = 0; i + 1 < sequence.length; i++) bump(`b:${sequence[i]}_${sequence[i + 1]}`, 0.35)
  }
  if (options.trigrams) {
    let emitted = 0
    for (const root of new Set(sequence)) {
      if (root.length < 5) continue
      for (let i = 0; i + 3 <= root.length && emitted < MAX_TRIGRAMS; i++, emitted++) bump(`g:${root.slice(i, i + 3)}`, 0.05)
    }
  }
  for (const [key, count] of counts) {
    const scaled = key.startsWith('t:') ? 1 + Math.log(count) : Math.min(count, 3)
    bag.set(key, (bag.get(key) || 0) + scaled * weight)
  }
}

/** Identificador numérico estable de un rasgo (también se usa para contar frecuencias). */
export function featureId(key: string): number {
  return fnv1a(key)
}

/**
 * Proyecta una bolsa de rasgos a un vector normalizado, ponderando con idf.
 * Cada rasgo cae en SPREAD posiciones con signo, derivadas de su hash: no se
 * guarda ninguna tabla, así que no retiene memoria por rasgo.
 */
export function vectorize(bag: FeatureBag, idf: (id: number) => number): Float32Array {
  const vector = new Float32Array(DIM)
  for (const [key, weight] of bag) {
    const id = featureId(key)
    const w = weight * idf(id)
    if (!w) continue
    const next = rng(id)
    for (let i = 0; i < SPREAD; i++) {
      const bits = next()
      vector[bits % DIM] += bits >>> 31 ? -w : w
    }
  }
  return normalizeInPlace(vector)
}

/** Rasgos de una consulta del usuario (con trigramas para tolerar variantes). */
export function queryBag(text: string): FeatureBag {
  const bag: FeatureBag = new Map()
  addTextFeatures(bag, text, 1, { bigrams: true, trigrams: true })
  return bag
}
