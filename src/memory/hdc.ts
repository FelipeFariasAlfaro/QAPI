// Primitivas de computación hiperdimensional (HDC / memoria holográfica).
//
// - Vectores de contenido: reales de DIM dimensiones, normalizados. Se comparan
//   por coseno (resonancia) y se superponen sumándolos.
// - Códigos de identidad: bipolares (+1/-1) pseudoaleatorios y deterministas.
//   El binding es la multiplicación elemento a elemento, que es su propia
//   inversa (a ⊙ a = 1): unir y desunir es exacto y barato.
// - Los paquetes de asociaciones se acumulan en enteros, así que añadir y
//   quitar una contribución es reversible sin error de redondeo.
export const DIM = 1024

/** FNV-1a de 32 bits: hash estable y rápido para derivar semillas. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Generador xorshift32 a partir de una semilla (nunca 0). */
export function rng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
}

/** Código bipolar pseudoaleatorio y determinista para un identificador. */
export function randomBipolar(id: string): Int8Array {
  const next = rng(fnv1a(id) ^ 0x5bd1e995)
  const code = new Int8Array(DIM)
  for (let i = 0; i < DIM; i += 32) {
    const bits = next()
    for (let j = 0; j < 32 && i + j < DIM; j++) code[i + j] = (bits >>> j) & 1 ? 1 : -1
  }
  return code
}

export function normalizeInPlace(vector: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 1e-12) for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return vector
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Coseno contra un acumulador no normalizado (superposición de una región). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0
}

/** Superposición: acc += weight · vector. Con weight negativo se retira la contribución. */
export function superpose(acc: Float64Array, vector: Float32Array, weight: number): void {
  for (let i = 0; i < acc.length; i++) acc[i] += vector[i] * weight
}

/** acc += weight · (role ⊙ item). Exacto en enteros. */
export function bindInto(acc: Int16Array, role: Int8Array, item: Int8Array, weight: number): void {
  for (let i = 0; i < DIM; i++) acc[i] += role[i] * item[i] * weight
}

/** Desune un rol de un paquete: devuelve una versión ruidosa de la superposición de los ítems unidos a ese rol. */
export function unbind(acc: Int16Array, role: Int8Array): Float32Array {
  const out = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) out[i] = acc[i] * role[i]
  return out
}

/**
 * Puntuación de limpieza: cuánto del ítem `code` contiene el vector desunido.
 * Si el ítem se unió con peso w, la puntuación esperada es w; el resto aporta
 * ruido con media 0 y desviación sqrt(Σw² / DIM).
 */
export function cleanupScore(unbound: Float32Array, code: Int8Array): number {
  let sum = 0
  for (let i = 0; i < DIM; i++) sum += unbound[i] * code[i]
  return sum / DIM
}

/**
 * Cuantiza un vector normalizado a 8 bits por dimensión (4 veces menos memoria).
 * El coseno se conserva con error < 1 % porque la escala es por vector.
 */
export function quantize(vector: Float32Array): { q: Int8Array; scale: number } {
  let max = 0
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]))
  const scale = max > 1e-12 ? max / 127 : 1
  const q = new Int8Array(vector.length)
  for (let i = 0; i < vector.length; i++) q[i] = Math.round(vector[i] / scale)
  return { q, scale }
}

export function dotQ(a: Float32Array, q: Int8Array, scale: number): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * q[i]
  return sum * scale
}

export function superposeQ(acc: Float64Array, q: Int8Array, scale: number, weight: number): void {
  const factor = scale * weight
  for (let i = 0; i < acc.length; i++) acc[i] += q[i] * factor
}
