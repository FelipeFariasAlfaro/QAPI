import * as vscode from 'vscode'
import { createHash, randomUUID } from 'crypto'
import { realpath, stat } from 'fs/promises'
import * as nodePath from 'path'
import { Checkpoint, CheckpointFile, DiffHunk, FileProposal, ProposalSelection } from './types'

const DIFF_CONTEXT = 3
const MAX_DIFF_DISTANCE = 512

type DiffOperation = { type: 'equal' | 'delete' | 'insert'; line: string }
type FileSnapshot = { path: string; uri: vscode.Uri; content: string | null }

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Adds the workspace state used to preview, verify and selectively apply proposals. */
export async function hydrateProposals(proposals: FileProposal[]): Promise<FileProposal[]> {
  const root = workspaceRoot()
  const paths = new Set<string>()
  const ids = new Set<string>()
  const hydrated: FileProposal[] = []

  for (const proposal of proposals) {
    const path = safeRelativePath(proposal.path)
    await assertRealPathInside(root, path)
    if (paths.has(path)) throw new Error(`Conflicto: hay más de una propuesta para ${path}`)
    paths.add(path)

    const id = proposal.id || randomUUID()
    if (ids.has(id)) throw new Error(`Conflicto: el id de propuesta ${id} está duplicado`)
    ids.add(id)

    const previous = await readOptional(vscode.Uri.joinPath(root, path))
    const hunks = buildDiffHunks(previous ?? '', proposal.content, path)
    // Text alone cannot express the difference between an absent file and an
    // existing empty one, so expose file creation as a selectable synthetic hunk.
    if (previous === null && proposal.content === '') hunks.push(emptyCreationHunk(path))
    hydrated.push({
      ...proposal,
      id,
      path,
      existed: previous !== null,
      previous,
      baseHash: hashText(previous ?? ''),
      hunks,
    })
  }

  return hydrated
}

/** Performs an unambiguous exact replacement without interpreting the input as a regexp. */
export function applyExactEdit(
  current: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): { ok: boolean; content: string; error?: string } {
  if (!oldText) {
    return { ok: false, content: current, error: 'El texto a reemplazar no puede estar vacío' }
  }

  let needle = oldText
  let replacement = newText
  let matches = countOccurrences(current, needle)

  // Models commonly emit LF snippets for a CRLF file. Adapt only when the exact
  // input was not found, so an explicitly mixed-EOL edit remains exact.
  if (matches === 0) {
    const eol = dominantEol(current)
    const adaptedNeedle = normalizeEol(oldText, eol)
    if (adaptedNeedle !== oldText) {
      const adaptedMatches = countOccurrences(current, adaptedNeedle)
      if (adaptedMatches > 0) {
        needle = adaptedNeedle
        replacement = normalizeEol(newText, eol)
        matches = adaptedMatches
      }
    }
  }

  if (matches === 0) {
    return { ok: false, content: current, error: 'El texto original no coincide con el contenido actual' }
  }
  if (!replaceAll && matches > 1) {
    return {
      ok: false,
      content: current,
      error: `Conflicto: el texto original aparece ${matches} veces; usa replaceAll para reemplazar todas`,
    }
  }

  const content = replaceAll
    ? current.split(needle).join(replacement)
    : replaceFirst(current, needle, replacement)
  return { ok: true, content }
}

/** Builds standard line hunks, splitting changes separated by a stable context anchor. */
export function buildDiffHunks(oldText: string, newText: string, path: string): DiffHunk[] {
  if (oldText === newText) return []

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const operations = diffLines(oldLines, newLines)
  const changes: Array<{ start: number; end: number }> = []

  for (let index = 0; index < operations.length;) {
    if (operations[index].type === 'equal') {
      index++
      continue
    }
    const start = index
    while (index < operations.length && operations[index].type !== 'equal') index++
    changes.push({ start, end: index })
  }

  const groups: Array<{ start: number; end: number }> = []
  for (const change of changes) {
    const start = Math.max(0, change.start - DIFF_CONTEXT)
    const end = Math.min(operations.length, change.end + DIFF_CONTEXT)
    const last = groups[groups.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else groups.push({ start, end })
  }

  const positions: Array<{ old: number; next: number }> = new Array(operations.length + 1)
  let oldPosition = 0
  let newPosition = 0
  positions[0] = { old: 0, next: 0 }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]
    if (operation.type !== 'insert') oldPosition++
    if (operation.type !== 'delete') newPosition++
    positions[index + 1] = { old: oldPosition, next: newPosition }
  }

  return groups.map((group) => {
    const oldStart = positions[group.start].old + 1
    const newStart = positions[group.start].next + 1
    const oldHunkLines: string[] = []
    const newHunkLines: string[] = []
    for (const operation of operations.slice(group.start, group.end)) {
      if (operation.type !== 'insert') oldHunkLines.push(operation.line)
      if (operation.type !== 'delete') newHunkLines.push(operation.line)
    }
    const oldCount = oldHunkLines.length
    const newCount = newHunkLines.length
    const coordinates = `-${oldStart},${oldCount} +${newStart},${newCount}`
    const id = `hunk-${hashText(`${path}\0${coordinates}\0${oldHunkLines.join('\n')}\0${newHunkLines.join('\n')}`).slice(0, 20)}`
    return {
      id,
      label: `@@ ${coordinates} @@ ${path}`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      oldLines: oldHunkLines,
      newLines: newHunkLines,
    }
  })
}

function emptyCreationHunk(path: string): DiffHunk {
  const id = `hunk-${hashText(`${path}\0create-empty`).slice(0, 20)}`
  return {
    id,
    label: `@@ -1,0 +1,0 @@ ${path} (crear archivo vacío)`,
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: 0,
    oldLines: [],
    newLines: [],
  }
}

/** Reconstructs a file from its base and any selected, non-overlapping hunks. */
export function reconstructFromHunks(base: string, hunks: DiffHunk[], selectedIds: string[]): string {
  if (selectedIds.length === 0) return base
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('Conflicto: hay ids de hunk seleccionados más de una vez')
  }

  const available = new Set(hunks.map((hunk) => hunk.id))
  for (const id of selectedIds) {
    if (!available.has(id)) throw new Error(`Conflicto: hunk desconocido ${id}`)
  }
  const selected = new Set(selectedIds)
  const applicable = hunks
    .filter((hunk) => selected.has(hunk.id))
    .sort((a, b) => b.oldStart - a.oldStart)
  const lines = splitLines(base)
  let nextStart = Number.POSITIVE_INFINITY

  for (const hunk of applicable) {
    if (!Number.isInteger(hunk.oldStart) || hunk.oldStart < 1 || hunk.oldCount < 0) {
      throw new Error(`Conflicto: coordenadas inválidas en ${hunk.id}`)
    }
    const start = hunk.oldStart - 1
    const end = start + hunk.oldCount
    if (end > nextStart) throw new Error(`Conflicto: los hunks seleccionados se superponen en ${hunk.id}`)
    if (start > lines.length || end > lines.length) {
      throw new Error(`Conflicto: ${hunk.id} está fuera del contenido base`)
    }
    const actual = lines.slice(start, end)
    if (!sameLines(actual, hunk.oldLines)) {
      throw new Error(`Conflicto: el contenido base no coincide con ${hunk.id}`)
    }
    lines.splice(start, hunk.oldCount, ...hunk.newLines)
    nextStart = start
  }

  return lines.join(dominantEol(base))
}

/** Applies selected proposal hunks atomically and returns an in-memory checkpoint. */
export async function applyProposalSelections(
  proposals: FileProposal[],
  selections: ProposalSelection[],
  label: string,
  persistCheckpoint?: (checkpoint: Checkpoint) => Promise<void>,
): Promise<{ applied: FileProposal[]; checkpoint: Checkpoint }> {
  const root = workspaceRoot()
  const proposalById = new Map<string, FileProposal>()
  const proposalPaths = new Set<string>()

  for (const proposal of proposals) {
    if (!proposal.id) throw new Error(`Conflicto: la propuesta para ${proposal.path} no tiene id`)
    if (proposalById.has(proposal.id)) throw new Error(`Conflicto: propuesta duplicada ${proposal.id}`)
    const path = safeRelativePath(proposal.path)
    await assertRealPathInside(root, path)
    if (proposalPaths.has(path)) throw new Error(`Conflicto: hay más de una propuesta para ${path}`)
    proposalPaths.add(path)
    proposalById.set(proposal.id, { ...proposal, path })
  }

  const selectedIds = new Set<string>()
  const prepared: Array<{
    proposal: FileProposal
    path: string
    uri: vscode.Uri
    before: string | null
    after: string
  }> = []

  for (const selection of selections) {
    if (selectedIds.has(selection.proposalId)) {
      throw new Error(`Conflicto: selección duplicada para ${selection.proposalId}`)
    }
    selectedIds.add(selection.proposalId)
    const proposal = proposalById.get(selection.proposalId)
    if (!proposal) throw new Error(`Conflicto: propuesta desconocida ${selection.proposalId}`)
    if (selection.hunkIds.length === 0) continue
    if (new Set(selection.hunkIds).size !== selection.hunkIds.length) {
      throw new Error(`Conflicto: hay hunks repetidos en ${proposal.path}`)
    }

    const hunks = proposal.hunks ?? buildDiffHunks(proposal.previous ?? '', proposal.content, proposal.path)
    const available = new Set(hunks.map((hunk) => hunk.id))
    if (available.size !== hunks.length) {
      throw new Error(`Conflicto: hay ids de hunk duplicados en ${proposal.path}`)
    }
    for (const hunkId of selection.hunkIds) {
      if (!available.has(hunkId)) throw new Error(`Conflicto: hunk desconocido ${hunkId} en ${proposal.path}`)
    }

    const uri = vscode.Uri.joinPath(root, proposal.path)
    const before = await readOptional(uri)
    verifyProposalBase(proposal, before)
    const allSelected = hunks.length > 0 && hunks.every((hunk) => selection.hunkIds.includes(hunk.id))
    const after = allSelected
      ? preserveBaseEol(proposal.content, before)
      : reconstructFromHunks(before ?? '', hunks, selection.hunkIds)
    prepared.push({ proposal: { ...proposal, hunks }, path: proposal.path, uri, before, after })
  }

  let checkpoint: Checkpoint = {
    id: randomUUID(), label, createdAt: Date.now(), pending: true,
    files: prepared.map((item) => ({
      path: item.path,
      before: item.before,
      after: item.after,
      beforeHash: hashText(item.before ?? ''),
      afterHash: hashText(item.after),
    })),
  }
  await persistCheckpoint?.(checkpoint)

  const touched: FileSnapshot[] = []
  try {
    for (const item of prepared) {
      // Recheck immediately before writing to close the preflight/write race window.
      const latest = await readOptional(item.uri)
      if (!sameSnapshot(latest, item.before)) {
        throw new Error(`Conflicto: ${item.path} cambió mientras se aplicaban las propuestas`)
      }
      touched.push({ path: item.path, uri: item.uri, content: item.before })
      await writeSnapshot(root, item.path, item.uri, item.after)
    }
  } catch (error) {
    const rollbackErrors = await rollbackSnapshots(root, touched)
    const reason = errorMessage(error)
    const suffix = rollbackErrors.length ? `; rollback incompleto: ${rollbackErrors.join('; ')}` : ''
    throw new Error(`${reason}${suffix}`)
  }

  const finalStates = await Promise.all(prepared.map((item) => readOptional(item.uri)))
  checkpoint = {
    ...checkpoint,
    pending: false,
    files: prepared.map((item, index) => {
      const final = finalStates[index]
      return {
        path: item.path,
        before: item.before,
        after: final,
        beforeHash: hashText(item.before ?? ''),
        afterHash: hashText(final ?? ''),
      }
    }),
  }
  try {
    await persistCheckpoint?.(checkpoint)
  } catch (error) {
    const rollbackErrors = await rollbackSnapshots(root, touched)
    const suffix = rollbackErrors.length ? `; rollback incompleto: ${rollbackErrors.join('; ')}` : ''
    throw new Error(`No se pudo confirmar el checkpoint: ${errorMessage(error)}${suffix}`)
  }
  const applied = prepared.map((item, index) => {
    const content = finalStates[index] ?? ''
    const hunks = buildDiffHunks(item.before ?? '', content, item.path)
    // Preserve the selectable representation of creating an empty file in the
    // historical turn; text diffing alone cannot represent that transition.
    if (item.before === null && content === '') hunks.push(emptyCreationHunk(item.path))
    return {
      ...item.proposal,
      content,
      existed: item.before !== null,
      previous: item.before,
      baseHash: hashText(item.before ?? ''),
      hunks,
    }
  })
  return { applied, checkpoint }
}

/** Reconciles a checkpoint left pending by an interrupted application. */
export async function reconcileCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  if (!checkpoint.pending) return checkpoint
  const root = workspaceRoot()
  const states: Array<'before' | 'after' | 'other'> = []
  const snapshots: FileSnapshot[] = []
  for (const file of checkpoint.files) {
    const path = safeRelativePath(file.path)
    await assertRealPathInside(root, path)
    const uri = vscode.Uri.joinPath(root, path)
    const current = await readOptional(uri)
    const hash = hashText(current ?? '')
    const exists = current !== null
    const isBefore = hash === file.beforeHash && exists === (file.before !== null)
    const isAfter = hash === file.afterHash && exists === (file.after !== null)
    states.push(isBefore ? 'before' : isAfter ? 'after' : 'other')
    snapshots.push({ path, uri, content: current })
  }
  if (states.every((state) => state === 'after')) return { ...checkpoint, pending: false }
  if (states.every((state) => state === 'before')) return { ...checkpoint, pending: false, undone: true }
  if (states.some((state) => state === 'other')) {
    return { ...checkpoint, conflict: 'Checkpoint interrumpido: hay archivos con cambios externos; no se restauró automáticamente.' }
  }
  try {
    for (let index = 0; index < checkpoint.files.length; index++) {
      await writeSnapshot(root, snapshots[index].path, snapshots[index].uri, checkpoint.files[index].before)
    }
    return { ...checkpoint, pending: false, undone: true, conflict: undefined }
  } catch (error) {
    return { ...checkpoint, conflict: `No se pudo recuperar el checkpoint interrumpido: ${errorMessage(error)}` }
  }
}

/** Restores a checkpoint only if every file still matches its recorded after-state. */
export async function undoCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  if (checkpoint.undone) return checkpoint
  const root = workspaceRoot()
  const paths = new Set<string>()
  const snapshots: FileSnapshot[] = []

  try {
    for (const file of checkpoint.files) {
      const path = safeRelativePath(file.path)
      await assertRealPathInside(root, path)
      if (paths.has(path)) throw new Error(`Conflicto: archivo duplicado ${path}`)
      paths.add(path)
      const uri = vscode.Uri.joinPath(root, path)
      const current = await readOptional(uri)
      const expectedExists = file.after !== null
      if ((current !== null) !== expectedExists || hashText(current ?? '') !== file.afterHash) {
        throw new Error(`Conflicto: ${path} cambió después del checkpoint`)
      }
      snapshots.push({ path, uri, content: current })
    }
  } catch (error) {
    return { ...checkpoint, undone: false, conflict: errorMessage(error) }
  }

  const restored: FileSnapshot[] = []
  try {
    for (let index = 0; index < checkpoint.files.length; index++) {
      const file = checkpoint.files[index]
      const snapshot = snapshots[index]
      const latest = await readOptional(snapshot.uri)
      if (!sameSnapshot(latest, snapshot.content)) {
        throw new Error(`Conflicto: ${snapshot.path} cambió mientras se deshacía el checkpoint`)
      }
      restored.push(snapshot)
      await writeSnapshot(root, snapshot.path, snapshot.uri, file.before)
    }
  } catch (error) {
    const rollbackErrors = await rollbackSnapshots(root, restored)
    const suffix = rollbackErrors.length ? `; rollback incompleto: ${rollbackErrors.join('; ')}` : ''
    return { ...checkpoint, undone: false, conflict: `${errorMessage(error)}${suffix}` }
  }

  return { ...checkpoint, undone: true, conflict: undefined }
}

function workspaceRoot(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) throw new Error('No hay carpeta de proyecto abierta')
  return root
}

function safeRelativePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) ||
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    throw new Error(`Ruta insegura o absoluta: ${input}`)
  }
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) {
    throw new Error(`Ruta insegura: ${input}`)
  }
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/')
  if (!normalized) throw new Error(`Ruta insegura: ${input}`)
  return normalized
}

async function assertRealPathInside(root: vscode.Uri, relative: string): Promise<void> {
  if (root.scheme !== 'file') return
  const rootReal = await realpath(root.fsPath)
  const target = nodePath.resolve(root.fsPath, relative)
  let probe = target
  while (probe !== root.fsPath) {
    try {
      await stat(probe)
      break
    } catch {
      const parent = nodePath.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  const probeReal = await realpath(probe)
  const rel = nodePath.relative(rootReal, probeReal)
  if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
    throw new Error(`Ruta fuera del workspace mediante symlink: ${relative}`)
  }
}

async function readOptional(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open && !open.isClosed) return open.getText()
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(bytes).toString('utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: string; name?: string; message?: string } | undefined
  return value?.code === 'FileNotFound' || value?.code === 'ENOENT' ||
    value?.name === 'FileNotFound' || /(?:not found|does not exist|enoent)/i.test(value?.message ?? '')
}

async function writeSnapshot(
  root: vscode.Uri,
  path: string,
  uri: vscode.Uri,
  content: string | null,
): Promise<void> {
  if (content === null) {
    try {
      await vscode.workspace.fs.delete(uri)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    return
  }
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (openDocument && !openDocument.isClosed) {
    const edit = new vscode.WorkspaceEdit()
    const end = openDocument.lineAt(Math.max(0, openDocument.lineCount - 1)).rangeIncludingLineBreak.end
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content)
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(`No se pudo actualizar el editor abierto: ${path}`)
    if (!await openDocument.save()) throw new Error(`No se pudo guardar el editor abierto: ${path}`)
    return
  }
  const parentSegments = path.split('/').slice(0, -1)
  if (parentSegments.length) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...parentSegments))
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'))
}

async function rollbackSnapshots(root: vscode.Uri, snapshots: FileSnapshot[]): Promise<string[]> {
  const errors: string[] = []
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await writeSnapshot(root, snapshot.path, snapshot.uri, snapshot.content)
    } catch (error) {
      errors.push(`${snapshot.path}: ${errorMessage(error)}`)
    }
  }
  return errors
}

function verifyProposalBase(proposal: FileProposal, current: string | null): void {
  if (!proposal.baseHash) throw new Error(`Conflicto: ${proposal.path} no tiene baseHash`)
  if ((current !== null) !== proposal.existed) {
    throw new Error(`Conflicto: cambió la existencia de ${proposal.path}`)
  }
  if (hashText(current ?? '') !== proposal.baseHash) {
    throw new Error(`Conflicto: ${proposal.path} cambió desde que se creó la propuesta`)
  }
}

function sameSnapshot(left: string | null, right: string | null): boolean {
  return (left === null) === (right === null) && hashText(left ?? '') === hashText(right ?? '')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let offset = 0
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset)
    if (index < 0) break
    count++
    offset = index + needle.length
  }
  return count
}

function replaceFirst(content: string, needle: string, replacement: string): string {
  const index = content.indexOf(needle)
  return content.slice(0, index) + replacement + content.slice(index + needle.length)
}

function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/(?<!\r)\n/g) || []).length
  return crlf > lf ? '\r\n' : '\n'
}

function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, eol)
}

function preserveBaseEol(content: string, base: string | null): string {
  if (base === null || !/[\r\n]/.test(base)) return content
  return normalizeEol(content, dominantEol(base))
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r\n|\n/)
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

/** Myers line diff; memory grows with edit distance rather than file area. */
function diffLines(oldLines: string[], newLines: string[]): DiffOperation[] {
  const oldLength = oldLines.length
  const newLength = newLines.length
  const maximum = oldLength + newLength
  const trace: Array<Map<number, number>> = []
  let frontier = new Map<number, number>([[1, 0]])

  for (let distance = 0; distance <= maximum; distance++) {
    if (distance >= MAX_DIFF_DISTANCE && maximum > MAX_DIFF_DISTANCE) {
      return fallbackDiff(oldLines, newLines)
    }
    trace.push(new Map(frontier))
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY
      let oldIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? down
        : right + 1
      if (!Number.isFinite(oldIndex)) oldIndex = 0
      let newIndex = oldIndex - diagonal
      while (oldIndex < oldLength && newIndex < newLength && oldLines[oldIndex] === newLines[newIndex]) {
        oldIndex++
        newIndex++
      }
      frontier.set(diagonal, oldIndex)
      if (oldIndex >= oldLength && newIndex >= newLength) {
        return backtrackDiff(trace, oldLines, newLines, distance)
      }
    }
  }
  return []
}

function fallbackDiff(oldLines: string[], newLines: string[]): DiffOperation[] {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  return [
    ...oldLines.slice(0, prefix).map((line): DiffOperation => ({ type: 'equal', line })),
    ...oldLines.slice(prefix, oldEnd).map((line): DiffOperation => ({ type: 'delete', line })),
    ...newLines.slice(prefix, newEnd).map((line): DiffOperation => ({ type: 'insert', line })),
    ...oldLines.slice(oldEnd).map((line): DiffOperation => ({ type: 'equal', line })),
  ]
}

function backtrackDiff(
  trace: Array<Map<number, number>>,
  oldLines: string[],
  newLines: string[],
  finalDistance: number,
): DiffOperation[] {
  const reversed: DiffOperation[] = []
  let oldIndex = oldLines.length
  let newIndex = newLines.length

  for (let distance = finalDistance; distance > 0; distance--) {
    const frontier = trace[distance]
    const diagonal = oldIndex - newIndex
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1
    const previousOld = frontier.get(previousDiagonal) ?? 0
    const previousNew = previousOld - previousDiagonal

    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ type: 'equal', line: oldLines[oldIndex - 1] })
      oldIndex--
      newIndex--
    }
    if (oldIndex === previousOld) {
      reversed.push({ type: 'insert', line: newLines[newIndex - 1] })
      newIndex--
    } else {
      reversed.push({ type: 'delete', line: oldLines[oldIndex - 1] })
      oldIndex--
    }
  }

  while (oldIndex > 0 && newIndex > 0) {
    reversed.push({ type: 'equal', line: oldLines[oldIndex - 1] })
    oldIndex--
    newIndex--
  }
  while (oldIndex > 0) reversed.push({ type: 'delete', line: oldLines[--oldIndex] })
  while (newIndex > 0) reversed.push({ type: 'insert', line: newLines[--newIndex] })
  return reversed.reverse()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
