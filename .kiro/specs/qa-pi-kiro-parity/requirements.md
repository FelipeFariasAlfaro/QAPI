# Requisitos — Paridad agéntica con Kiro

## Objetivo

Elevar QAPI de un asistente que propone cambios a un agente que completa trabajo verificado, con contexto gobernable por el equipo y automatización por eventos.

## R1. Bucle de ejecución con verificación

**Historia:** Como usuario, quiero que QAPI verifique su propio trabajo y corrija los errores que introdujo antes de darme el resultado.

### Criterios de aceptación

1. Tras aplicar cambios, QAPI debe ejecutar la verificación declarada por el proyecto (build, typecheck o pruebas) cuando el workspace es confiable.
2. Si la verificación falla, QAPI debe leer la salida, preparar una corrección y volver a verificar.
3. El ciclo debe estar acotado por un número máximo de intentos y detenerse ante falta de progreso.
4. Cada intento debe quedar visible en la conversación con su comando, estado y salida.
5. El usuario debe poder desactivar el ciclo automático; con el ciclo desactivado el comportamiento actual se conserva.
6. Ningún comando debe ejecutarse en un workspace no confiable.

## R2. Specs ejecutables

**Historia:** Como usuario, quiero convertir una solicitud compleja en requisitos, diseño y tareas persistentes, y ejecutarlas una por una.

### Criterios de aceptación

1. QAPI debe poder crear un spec con `requirements.md`, `design.md` y `tasks.md` bajo `.qapi/specs/<nombre>/`.
2. El flujo debe avanzar por fases con aprobación explícita: requisitos → diseño → tareas → ejecución.
3. Las tareas deben tener estado persistente: pendiente, en curso, completada.
4. El usuario debe poder ejecutar una tarea concreta y QAPI debe trabajar sólo en su alcance.
5. Completar una tarea debe actualizar `tasks.md` en disco y el estado visible.
6. La lista de specs y el progreso deben visualizarse en el panel.

## R3. Steering con alcance

**Historia:** Como equipo, quiero definir reglas y convenciones en archivos versionables que se apliquen sólo cuando corresponden.

### Criterios de aceptación

1. QAPI debe leer archivos de `.qapi/steering/*.md`.
2. Debe admitir front-matter con `inclusion: always | fileMatch | manual` y `fileMatchPattern`.
3. `always` se inyecta siempre; `fileMatch` sólo cuando el contexto incluye un archivo que coincide; `manual` sólo cuando el usuario lo referencia.
4. Debe admitir referencias a otros archivos mediante `#[[file:<ruta>]]`, resolviéndolas contra el workspace.
5. El presupuesto de steering debe estar acotado y no debe desplazar el contexto esencial.
6. Las fuentes de steering aplicadas deben mostrarse como contexto usado.

## R4. Delegación a sub-agentes

**Historia:** Como usuario, quiero que la investigación amplia y la revisión de cambios no contaminen ni agoten la conversación principal.

### Criterios de aceptación

1. QAPI debe poder delegar investigación de código a un sub-agente con su propio contexto.
2. QAPI debe poder delegar la revisión de los cambios preparados antes de presentarlos.
3. El sub-agente sólo debe disponer de herramientas de lectura.
4. El resultado devuelto debe ser un resumen acotado, no el contenido completo leído.
5. Los hallazgos de la revisión deben mostrarse junto a las propuestas.
6. La delegación debe ser opcional y no debe bloquear la respuesta si falla.

## R5. Contexto explícito

**Historia:** Como usuario, quiero dirigir qué contexto recibe el agente.

### Criterios de aceptación

1. El compositor debe permitir insertar referencias con `#`.
2. Debe ofrecer al menos archivo, carpeta, Problems y Git diff.
3. Las referencias elegidas deben resolverse a contenido real antes de enviar.
4. Las referencias no resolubles deben avisarse sin cancelar el envío.

## R6. Compactación no destructiva

**Historia:** Como usuario, quiero que al llenarse el contexto no se pierda lo ya decidido.

### Criterios de aceptación

1. Al alcanzar el umbral, QAPI debe resumir los turnos antiguos y conservar los más recientes íntegros.
2. El resumen debe preservar objetivos, decisiones, archivos tocados y pendientes.
3. Los turnos con propuestas aplicadas y checkpoints deben seguir siendo utilizables tras compactar.
4. La compactación debe reflejarse en el contador de contexto.

## R7. Hooks por evento

**Historia:** Como equipo, quiero automatizar acciones de QA ante eventos del editor.

### Criterios de aceptación

1. QAPI debe leer definiciones de hooks desde `.qapi/hooks/*.json`.
2. Debe admitir al menos guardar archivo, crear archivo y eliminar archivo, con filtro por patrón.
3. Un hook debe poder ejecutar un prompt del agente o un comando declarado.
4. Los hooks deben estar desactivados salvo declaración explícita y requerir workspace confiable.
5. Cada ejecución debe ser visible y no debe interrumpir la conversación en curso.

## R8. Streaming de respuestas

**Historia:** Como usuario, quiero ver la respuesta mientras se genera.

### Criterios de aceptación

1. La respuesta final de texto debe emitirse incrementalmente cuando el proveedor lo soporta.
2. Si el streaming falla, debe recurrirse a la respuesta completa sin perder el turno.
3. El texto en streaming no debe duplicarse al cerrar el turno.

## R9. Compatibilidad y seguridad

### Criterios de aceptación

1. El historial, los checkpoints y la configuración existentes deben seguir funcionando.
2. Toda mutación de archivos y ejecución de comandos sigue exigiendo aprobación o autorización explícita según las reglas ya vigentes.
3. Ningún secreto debe persistirse en el estado del webview ni enviarse a archivos de log.
4. `npm run typecheck` y `npm run build` deben terminar en 0 y el VSIX debe regenerarse.
