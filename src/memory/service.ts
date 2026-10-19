// Servicio de la memoria holográfica dentro de la extensión: construye la
// memoria en segundo plano, la persiste por proyecto (workspaceState, privado:
// no se escribe en el repositorio) y la reinicia al cambiar de proyecto.
import * as vscode from 'vscode'
import type { ProjectIndex } from '../projectIndex'
import { HolographicMemory, MemoryNote, NoteHit } from './memory'

const KEY_STATE = 'qa-pi.holographicMemory'
const SAVE_DELAY_MS = 1500
/** Espera máxima a que termine la indexación inicial antes de construir. */
const INDEX_WAIT_MS = 15_000

export class MemoryService {
  private memory = new HolographicMemory()
  private building?: Promise<HolographicMemory>
  private built = false
  private saveTimer?: NodeJS.Timeout
  private generation = 0

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.memory.restore(this.ctx.workspaceState.get(KEY_STATE))
  }

  get isBuilt(): boolean { return this.built }

  /**
   * Memoria lista y sincronizada. La primera vez construye todo cediendo el
   * control entre lotes; después, cada llamada sólo procesa archivos cambiados.
   */
  async ready(index: ProjectIndex): Promise<HolographicMemory> {
    if (this.built) {
      if (!index.indexing) this.memory.sync(index)
      return this.memory
    }
    if (!this.building) {
      const generation = this.generation
      this.building = (async () => {
        const started = Date.now()
        // Construir sobre un índice a medias haría creer que faltan archivos.
        while (index.indexing && Date.now() - started < INDEX_WAIT_MS) await new Promise((resolve) => setTimeout(resolve, 200))
        await this.memory.syncAsync(index)
        if (generation === this.generation) this.built = true
        return this.memory
      })().finally(() => { this.building = undefined })
    }
    return this.building
  }

  /** Construcción anticipada al abrir el proyecto, para que el primer mensaje no espere. */
  warm(index: ProjectIndex): void {
    void this.ready(index).catch((error) => console.error('QAPI: no se pudo construir la memoria holográfica', error))
  }

  persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.ctx.workspaceState.update(KEY_STATE, this.memory.serialize())
    }, SAVE_DELAY_MS)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    await this.ctx.workspaceState.update(KEY_STATE, this.memory.serialize())
  }

  /** Nuevo proyecto principal: la memoria anterior no le pertenece. */
  async reset(): Promise<void> {
    this.generation++
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.memory = new HolographicMemory()
    this.built = false
    this.building = undefined
    await this.ctx.workspaceState.update(KEY_STATE, undefined)
  }

  /** Reconstruye desde cero conservando notas, refuerzos y estado visto. */
  async rebuild(index: ProjectIndex): Promise<HolographicMemory> {
    const state = this.memory.serialize()
    this.generation++
    this.memory = new HolographicMemory()
    this.memory.restore(state)
    this.built = false
    this.building = undefined
    return this.ready(index)
  }

  stats() {
    return { ...this.memory.stats(), built: this.built }
  }

  notes(): NoteHit[] {
    return this.memory.listNotes()
  }

  addNote(text: string, sources: string[]): MemoryNote {
    const note = this.memory.learn(text, sources, 'user')
    this.persistSoon()
    return note
  }

  forgetNote(id: string): boolean {
    const removed = this.memory.forget(id)
    if (removed) this.persistSoon()
    return removed
  }
}
