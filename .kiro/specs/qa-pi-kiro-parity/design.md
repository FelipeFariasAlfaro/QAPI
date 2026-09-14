# Diseño — Paridad agéntica con Kiro

## 1. Arquitectura objetivo

```text
Solicitud
  → contexto explícito (#) + steering aplicable + memoria automática
  → agente (tools de lectura / mutación autorizada)
  → sub-agente de investigación (contexto aislado)
  → propuestas + revisión delegada
  → aplicación aprobada
  → bucle de verificación (build/test → errores → corrección)
  → turno cerrado
```

Nuevos módulos:

| Archivo | Responsabilidad |
| --- | --- |
| `src/steering.ts` | Descubrir, parsear y seleccionar steering por inclusión |
| `src/specs.ts` | Crear, leer y actualizar specs y estado de tareas |
| `src/subAgent.ts` | Ejecutar investigación y revisión en contexto aislado |
| `src/verification.ts` | Ciclo verificar → diagnosticar → corregir |
| `src/hooks.ts` | Cargar y disparar hooks por evento |
| `src/contextRefs.ts` | Resolver referencias `#` a contenido real |

Todo el estado en disco vive bajo `.qapi/` para ser versionable por el equipo.

## 2. Steering

### 2.1 Formato

```markdown
---
inclusion: fileMatch
fileMatchPattern: "**/*.feature"
---
Usa Gherkin en español y reutiliza los steps existentes.

#[[file:docs/convenciones.md]]
```

### 2.2 Selección

- `always`: siempre.
- `fileMatch`: si el archivo activo, la selección, los visibles o los cambios de Git coinciden con el patrón.
- `manual`: sólo si el usuario lo referenció con `#steering:<nombre>`.

Presupuesto total 12.000 caracteres, prioridad `always` > `fileMatch` > `manual`, recorte por archivo y redacción de secretos antes de inyectar. Las referencias `#[[file:…]]` se resuelven una vez, sin recursión, con límite por archivo.

## 3. Specs ejecutables

### 3.1 Estructura

```text
.qapi/specs/<slug>/
  requirements.md
  design.md
  tasks.md
```

`tasks.md` es la fuente de verdad. El estado se deriva de las casillas Markdown:

```markdown
- [ ] 1. Tarea pendiente
- [-] 2. Tarea en curso
- [x] 3. Tarea completada
```

### 3.2 Flujo

`draft-requirements` → `draft-design` → `draft-tasks` → `execute`. Cada transición requiere aprobación explícita del usuario en el panel. La ejecución de una tarea abre un turno acotado a esa tarea, y al completarse reescribe la casilla en disco.

Nuevas tools del agente en modo spec: `create_spec_document` y `update_task_status`. Ambas son mutaciones y respetan la autorización vigente.

## 4. Sub-agentes

Un sub-agente es una llamada `chat`/`chatWithTools` independiente con:

- historial propio vacío;
- sólo `READ_TOOLS`;
- presupuesto de pasos reducido (5);
- salida obligada a un resumen corto con rutas y hallazgos.

Dos presets:

- **investigate**: mapear archivos relevantes y responder qué existe y dónde.
- **review**: recibir el diff propuesto y devolver riesgos concretos con severidad.

El agente principal expone la tool `investigate_codebase`. La revisión se dispara automáticamente antes de cerrar un turno con propuestas, es best-effort y sus hallazgos se adjuntan al turno.

## 5. Bucle de verificación

```text
aplicar → detectar comando → ejecutar
  ├─ éxito → cerrar
  └─ fallo → enviar salida al modelo → preparar corrección
        ├─ hay corrección → aplicar → reintentar (máx. 3)
        └─ sin corrección o sin progreso → detener e informar
```

Reglas: sólo en workspace confiable; una ejecución concurrente como hoy; se detiene si dos intentos producen la misma salida de error; cada intento se registra como `ExecutionRun` en el turno. Las correcciones del ciclo se aplican con el mismo camino atómico y quedan cubiertas por un checkpoint.

Se sustituye el ajuste booleano `autoValidate` por `verification: 'off' | 'validate' | 'autofix'`, migrando el valor previo.

## 6. Contexto explícito

El compositor detecta `#` y ofrece `#file:<ruta>`, `#folder:<ruta>`, `#problems`, `#gitDiff` y `#steering:<nombre>`. El host resuelve cada referencia con los límites del índice y la redacción existente; las no resolubles se informan como aviso y el envío continúa.

## 7. Compactación

Reemplaza el colapso a un turno único: se resumen los turnos antiguos y se conservan íntegros los últimos seis, más cualquier turno con propuestas aplicadas o checkpoint. El resumen se marca `summary: true` y el resto del historial permanece navegable.

## 8. Hooks

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "Validar features al guardar",
      "trigger": "PostFileSave",
      "matcher": "\\.feature$",
      "action": { "type": "agent", "prompt": "Revisa este .feature" }
    }
  ]
}
```

Triggers: `PostFileSave`, `PostFileCreate`, `PostFileDelete`. Acciones: `agent` (envía un prompt) y `command` (propone o ejecuta un comando declarado, sujeto a confianza del workspace). Se descartan si el agente está ocupado y llevan antirrebote por archivo.

## 9. Streaming

Se añade `chatStream` con soporte SSE para OpenAI, Claude y Gemini, y NDJSON para Ollama. Sólo se usa en la respuesta final sin tool calls; el turno se cierra reemplazando el texto acumulado. Cualquier error revierte a la ruta no-streaming.

## 10. Riesgos

- Ciclos de corrección infinitos: acotados por intentos y detección de estancamiento.
- Coste de tokens: sub-agentes con presupuesto reducido y salida resumida.
- Superficie de ejecución: hooks opt-in, workspace confiable y aprobación de comandos.
- Contexto desplazado: presupuestos explícitos por sección.
