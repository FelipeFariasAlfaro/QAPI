# Design — QA-PI Agentic Upgrade

## Arquitectura

```text
Webview (main.ts)
  ├─ modos Chat / Plan QA
  ├─ diff seleccionable y comandos aprobables
  ├─ resultados, checkpoints, memoria y trazabilidad
  └─ mensajes tipados
         │
QaPiViewProvider (panel.ts)
  ├─ IdeContextService / ArtifactService
  ├─ ChangeService / CheckpointStore
  ├─ ExecutionService / ValidationService
  ├─ TraceabilityService
  └─ Agent + MCP runtime
         │
Providers: Gemini | Claude | OpenAI | Ollama
```

## Componentes

### `ideContext.ts`
Captura selection/editor, documentos visibles, diagnósticos, metadatos de terminales y Git diff/status mediante `execFile` sin shell. Descubre artefactos recientes y calcula impacto básico por rutas/nombres. Cada sección se trunca de forma independiente.

### `execution.ts`
Deriva comandos seguros desde `ProjectProfile.testCommands` y manifests. Ejecuta con `exec(command, {cwd, timeout})` sólo después de aprobación, bloqueando patrones destructivos. Normaliza `ExecutionRun` para UI y feedback del agente.

### `changes.ts`
Hidrata propuestas con base actual y hash SHA-256, aplica reemplazos exactos de `edit_file`, genera hunks de diff por anclas de líneas y reconstruye contenidos a partir de hunks seleccionados. Antes de escribir verifica `baseHash`; crea `Checkpoint` persistente y aplica el lote. Undo verifica `afterHash` antes de restaurar.

### `mcpRuntime.ts`
Cliente MCP stdio efímero por consulta. Inicia únicamente servidores habilitados usando `spawn(..., shell:false)`, realiza `initialize`, `notifications/initialized`, `tools/list` y `tools/call`, implementa IDs, pending requests, parser JSONL, timeout, truncado y cierre escalado. Alias: `mcp_<server>_<tool>_<hash>`.

### `traceability.ts`
Analiza features/tags/escenarios, step definitions y tests indexados. Relaciona por step pattern, basename, imports y tags. Devuelve evidencia inferida y huecos, nunca porcentaje de cobertura runtime.

### `agent.ts`
Unifica tools locales, edición exacta, comandos propuestos, insights y tools MCP. `AgentMode=plan` excluye herramientas mutantes. El bucle acumula archivos/comandos, devuelve resultados de lectura/MCP y mantiene una única aprobación.

### `store.ts`
Settings globales; memoria y checkpoints en `workspaceState`. Se conservan últimos 20 checkpoints y se separan del historial. La memoria se limita a 12 KiB.

## Contratos principales

```ts
type AgentMode = 'chat' | 'plan'
interface IdeContextSnapshot { activeFile?; selection?; visibleFiles; diagnostics; gitDiff; gitStatus; terminals }
interface FileProposal { id; path; content; previous?; baseHash?; hunks? }
interface DiffHunk { id; oldLines; newLines; selected? }
interface CommandProposal { id; command; reason; timeoutMs }
interface ExecutionRun { id; command; status; exitCode?; output; durationMs }
interface Checkpoint { id; label; createdAt; files; undone? }
interface TraceabilitySummary { requirements; scenarios; steps; tests; links; gaps }
```

## Flujos

### Consulta normal
1. Panel captura `IdeContextSnapshot` y carga memoria.
2. Agent construye prompt + índice + contexto IDE.
3. Runtime MCP descubre tools habilitadas.
4. Modelo investiga y acumula `write_file`, `edit_file` y comandos.
5. Host hidrata propuestas con base/hash/hunks.
6. UI muestra un lote para selección y aprobación.

### Aplicación y validación
1. UI reconstruye propuestas según hunks seleccionados.
2. Host normaliza rutas y verifica hash base.
3. Crea checkpoint y escribe lote.
4. Reindexa y, si está habilitado, ejecuta validación segura detectada.
5. Resultado queda visible; un fallo puede enviarse al agente.

### Plan QA
1. UI envía `mode=plan`.
2. Agent sólo recibe tools de lectura/insights/MCP.
3. Devuelve plan estructurado sin cambios.
4. “Ejecutar plan” reenvía el plan en modo chat.

### MCP
1. Parsear config + filtrar enabled.
2. Start/initialize/list por servidor, tolerando fallos parciales.
3. Registrar aliases únicos como ToolDef.
4. Call con timeout; resultado delimitado como no confiable.
5. `finally` cierra todos los procesos.

## Seguridad
- Rutas: sólo relativas, sin `..`, NUL, URI, drive ni escape del workspace.
- Comandos: aprobación explícita; bloqueo de `rm -rf`, `sudo`, format, shutdown, force-push y forks destructivos; timeout y salida acotada.
- MCP: habilitación explícita equivale a confianza; `shell:false`; no registrar env; outputs no confiables.
- Conflictos: hash base/after evita sobrescribir cambios externos o deshacer trabajo posterior.
- Webview: render de código con `textContent`; host vuelve a validar toda entrada.

## Diff
Se usa diff lineal por anclas únicas con contexto. Para archivos sin base se crea un hunk de alta; archivos grandes degradan a un bloque completo. Invariantes: seleccionar todos produce target; ninguno conserva base.

## Persistencia y migración
Todos los campos nuevos tienen defaults. Historial viejo continúa siendo válido. Checkpoints se guardan fuera del historial y sobreviven a `clearChat`. Se retienen 20.

## Limitaciones declaradas
- VS Code no expone scrollback de terminales externos; sólo nombres/cwd y output de procesos lanzados por QA-PI.
- Screenshots/traces binarios se exponen como metadatos si el proveedor activo no tiene canal multimodal.
- La trazabilidad es inferida estáticamente, no reemplaza cobertura instrumentada.
- Diff por hunk prioriza seguridad y puede degradar a archivo completo en casos complejos.