# Tareas — Calidad pre-release de QAPI

- [x] 1. Añadir clasificación determinista de intención mutante
  - [x] 1.1 Detectar saludos y conversación social breve en español e inglés
  - [x] 1.2 Detectar solicitudes explícitas de cambio
  - [x] 1.3 Autorizar confirmaciones breves sólo con propuesta o plan previo
  - [x] 1.4 Aplicar barreras antes y después de las llamadas del modelo

- [x] 2. Explicar qué cambia y por qué
  - [x] 2.1 Extender `FileProposal` con propósito compatible
  - [x] 2.2 Solicitar y capturar la razón en tools de escritura/edición
  - [x] 2.3 Generar fallback host-side cuando falte explicación
  - [x] 2.4 Mostrar propósito junto al archivo y antes de las acciones

- [x] 3. Corregir jerarquía visual de mensajes
  - [x] 3.1 Renderizar `Chat` / `Plan QA` en fila propia
  - [x] 3.2 Ajustar CSS desktop y responsive
  - [x] 3.3 Comprobar usuario y asistente sin solapamientos

- [x] 4. Completar documentación de release
  - [x] 4.1 Crear `CHANGELOG.md` para 1.0.0
  - [x] 4.2 Añadir autor, correo y LinkedIn al README
  - [x] 4.3 Documentar explicaciones y protección contra mutaciones accidentales

- [x] 5. Ejecutar revisión pre-release
  - [x] 5.1 Revisar agente, propuestas, persistencia, índice y webview
  - [x] 5.2 Corregir hallazgos altos y medios
  - [x] 5.3 Ejecutar diagnósticos, typecheck y build
  - [x] 5.4 Regenerar y verificar `qa-pi-1.0.0.vsix`
