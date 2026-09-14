# Requirements — QA-PI Agentic Upgrade

## Objetivo
Evolucionar QA-PI desde un chat contextual con propuestas de archivos a un asistente agentic de QA que planifica, investiga, edita, ejecuta, valida y mantiene trazabilidad respetando las convenciones reales del workspace.

## R1. Validación automática con feedback de IA
**Historia:** Como usuario quiero validar los cambios aplicados con los comandos reales del proyecto para detectar regresiones inmediatamente.

**Criterios de aceptación**
1. Cuando se apliquen cambios y la validación automática esté habilitada, QA-PI debe ejecutar un comando detectado y seguro de typecheck, lint o tests.
2. Debe mostrar comando, estado, código de salida, duración y salida acotada.
3. Si falla, debe permitir enviar el resultado al agente para diagnóstico y propuesta de corrección.
4. La validación automática debe poder deshabilitarse y nunca ejecutar un comando arbitrario sin aprobación.

## R2. Diff y aprobación selectiva
**Historia:** Como usuario quiero revisar el cambio real y elegir archivos o bloques antes de escribirlos.

**Criterios de aceptación**
1. Cada modificación debe mostrarse como líneas agregadas/eliminadas con contexto; las altas muestran el contenido nuevo.
2. Debe existir selección global, por archivo y por bloque.
3. Aplicar seleccionados sólo debe enviar al host los contenidos reconstruidos de los bloques elegidos.
4. El host debe rechazar rutas fuera del workspace y cambios cuya base haya cambiado.

## R3. Modo Plan QA
**Historia:** Como usuario quiero analizar y acordar un plan antes de modificar código.

**Criterios de aceptación**
1. El compositor debe ofrecer modos Chat y Plan QA.
2. En Plan QA el agente sólo puede investigar y debe devolver alcance, riesgos, criterios, archivos probables y validación.
3. Un plan puede convertirse en ejecución mediante una acción explícita.
4. El modo debe quedar visible en el turno.

## R4. Contexto dinámico del IDE
**Historia:** Como usuario quiero que QA-PI comprenda el estado actual del editor y del repositorio.

**Criterios de aceptación**
1. El agente debe recibir archivo y selección activos, editores visibles, Problems, Git status/diff y terminales abiertos.
2. Cada fuente debe tener límites para no desbordar contexto.
3. La captura no debe incluir secretos deliberadamente ni afirmar que puede leer el scrollback de terminales externos.
4. La UI debe indicar qué fuentes se incluyeron.

## R5. Diagnóstico de artefactos de prueba
**Historia:** Como QA quiero localizar reportes y logs recientes y pedir un diagnóstico de fallos.

**Criterios de aceptación**
1. QA-PI debe descubrir reportes XML/JSON/HTML, logs, screenshots y traces en carpetas habituales.
2. Debe poder leer texto acotado y exponer metadatos para binarios.
3. Debe ofrecer una acción para diagnosticar el artefacto más reciente.
4. Debe reconocer fallos comunes de JUnit/Playwright/Cypress/Behave sin depender de un formato único.

## R6. Pruebas basadas en cambios
**Historia:** Como desarrollador quiero ejecutar o generar sólo pruebas relacionadas con mi Git diff.

**Criterios de aceptación**
1. QA-PI debe resumir rutas cambiadas y relacionarlas con tests por nombre, carpeta, imports o convenciones.
2. Debe proponer archivos de prueba impactados y comandos específicos cuando sea posible.
3. Si no hay evidencia suficiente, debe recomendar la suite detectada y declarar el fallback.
4. La UI debe ofrecer una acción rápida “Pruebas impactadas”.

## R7. Ejecución inteligente desde el chat
**Historia:** Como usuario quiero aprobar y ejecutar comandos de prueba sugeridos por el agente.

**Criterios de aceptación**
1. El agente debe poder proponer comandos con motivo y timeout, sin ejecutarlos automáticamente.
2. La UI debe mostrar y solicitar aprobación por comando.
3. El host debe ejecutar en la raíz del workspace, capturar salida/código/duración y aplicar timeout.
4. Debe bloquear comandos destructivos evidentes y limitar tamaño de salida.

## R8. Ediciones por parche
**Historia:** Como usuario quiero que QA-PI cambie sólo el bloque necesario para preservar el archivo.

**Criterios de aceptación**
1. El agente debe disponer de `edit_file` con reemplazo exacto sobre un archivo leído.
2. Coincidencias inexistentes o ambiguas deben generar un resultado de error sin escribir.
3. Varias ediciones sobre una ruta deben acumularse en orden en memoria.
4. `write_file` se conserva para archivos nuevos o reemplazos completos deliberados.

## R9. Checkpoints y undo por tarea
**Historia:** Como usuario quiero revertir de forma segura una operación completa incluso después de otros turnos.

**Criterios de aceptación**
1. Cada aplicación debe crear un checkpoint con identificador, fecha y snapshots anterior/posterior.
2. La UI debe listar checkpoints recientes y permitir deshacer el último o uno seleccionado.
3. El undo debe restaurar todos los archivos del checkpoint y detectar conflictos posteriores.
4. Limpiar el chat no debe borrar checkpoints.

## R10. MCP agentic
**Historia:** Como usuario quiero que el agente use tools de los servidores MCP que habilité.

**Criterios de aceptación**
1. Sólo servidores válidos y habilitados deben iniciarse durante una consulta.
2. QA-PI debe realizar initialize, tools/list y tools/call por stdio JSON-RPC con timeout.
3. Los nombres deben estar namespaced, los resultados acotados y tratados como datos no confiables.
4. Los procesos deben cerrarse siempre; un servidor caído no debe inutilizar las tools locales.

## R11. Memoria editable de convenciones
**Historia:** Como equipo quiero persistir reglas del proyecto independientes del historial del chat.

**Criterios de aceptación**
1. Settings debe incluir una memoria por workspace editable y persistente.
2. La memoria debe inyectarse explícitamente al prompt antes del contexto recuperado.
3. Debe poder limpiarse sin borrar chat ni configuración global.
4. El agente debe tratarla como convención del usuario y no como contenido recuperado accidental.

## R12. Cobertura y trazabilidad
**Historia:** Como QA quiero ver relaciones entre requisitos, escenarios, steps, tests y código.

**Criterios de aceptación**
1. QA-PI debe extraer IDs/tags de requisitos, escenarios Gherkin, step definitions y archivos de código/prueba relacionados.
2. Debe producir un resumen con totales, enlaces conocidos y huecos.
3. Debe exponer el resumen como contexto/tool para el agente y una vista en la UI.
4. No debe presentar la trazabilidad estática como cobertura runtime real; debe identificarla como evidencia inferida.

## Requisitos no funcionales
- Compatible con VS Code 1.85+, Node 18 y los cuatro proveedores existentes.
- Sin ejecución silenciosa de comandos arbitrarios ni escritura fuera del workspace.
- Límites de 64 KiB por resultado de tool, 120 s por comando y 10 rondas agentic.
- Degradación segura: si Git, MCP, reportes o comandos no están disponibles, el chat continúa.
- Persistencia backward-compatible con settings e historial existentes.