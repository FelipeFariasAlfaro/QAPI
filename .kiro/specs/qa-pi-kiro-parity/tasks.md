# Tareas — Paridad agéntica con Kiro

- [x] 1. Steering con alcance
  - [x] 1.1 Crear `src/steering.ts` con descubrimiento y front-matter
  - [x] 1.2 Resolver `#[[file:…]]` con límites y redacción
  - [x] 1.3 Inyectar en el prompt y publicar como contexto usado

- [x] 2. Bucle de verificación
  - [x] 2.1 Añadir ajuste `verification` con migración de `autoValidate`
  - [x] 2.2 Crear `src/verification.ts` con ciclo acotado y antiestancamiento
  - [x] 2.3 Integrar en el flujo de aplicación y mostrar cada intento

- [x] 3. Specs ejecutables
  - [x] 3.1 Crear `src/specs.ts` con lectura/escritura y estado de tareas
  - [x] 3.2 Añadir tools `create_spec_document` y `update_task_status`
  - [x] 3.3 Añadir fases con aprobación y vista de specs en el panel

- [x] 4. Sub-agentes
  - [x] 4.1 Crear `src/subAgent.ts` con presets investigate y review
  - [x] 4.2 Exponer `investigate_codebase` al agente principal
  - [x] 4.3 Adjuntar revisión automática a los turnos con propuestas

- [x] 5. Contexto explícito y compactación
  - [x] 5.1 Crear `src/contextRefs.ts` y resolver referencias
  - [x] 5.2 Añadir autocompletado `#` en el compositor
  - [x] 5.3 Sustituir el resumen destructivo por compactación parcial

- [x] 6. Hooks y streaming
  - [x] 6.1 Crear `src/hooks.ts` con carga, filtro y antirrebote
  - [x] 6.2 Registrar disparadores en la activación
  - [x] 6.3 Añadir `chatStream` por proveedor con fallback

- [ ] 7. Entrega
  - [ ] 7.1 Revisión semántica y corrección de hallazgos
  - [ ] 7.2 `npm run typecheck` y `npm run build`
  - [ ] 7.3 Actualizar README y CHANGELOG
  - [ ] 7.4 Regenerar y verificar el VSIX
