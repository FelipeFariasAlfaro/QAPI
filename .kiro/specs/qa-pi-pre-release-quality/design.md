# Diseño — Calidad pre-release de QAPI

## 1. Alcance

El cambio afecta el host de extensión (`agent`, `panel`, tipos y propuestas), el webview (`main.ts` y CSS), la documentación y el empaquetado. No cambia proveedores, formato de checkpoints ni aplicación atómica de hunks.

## 2. Arquitectura de la solución

```text
Mensaje del usuario
  → clasificación determinista de intención
  → selección de tools permitidas
  → modelo
  → defensa posterior de mutaciones
  → hidratación de propuestas + propósito
  → ChatTurn persistido
  → etiqueta vertical + explicación + diff + acciones
```

La seguridad no dependerá únicamente del prompt. Habrá dos barreras host-side: una antes de exponer herramientas mutantes y otra antes de aceptar llamadas/propuestas mutantes devueltas por el modelo.

## 3. Compuerta de intención mutante

### 3.1 Clasificación

Una función pura calculará `MutationAuthorization` usando la solicitud actual, el modo y el historial reciente:

- `allowed: false` para `Plan QA`, saludos, agradecimientos y conversación social breve;
- `allowed: true` para solicitudes con verbos explícitos de creación, modificación, corrección, eliminación, aplicación o implementación;
- confirmaciones breves como `sí`, `hazlo`, `aplica` o `procede` sólo serán válidas si el turno asistente inmediato contiene propuestas o un plan ejecutable;
- en casos ambiguos, prevalece `allowed: false` y se conservan tools de lectura.

La normalización será insensible a mayúsculas, espacios y puntuación terminal, con vocabulario español e inglés.

### 3.2 Aplicación

- `mutatingTools` se incluirá únicamente cuando `authorization.allowed` sea verdadero y el modo sea `chat`.
- Una llamada inesperada a `write_file`, `edit_file` o `run_command` será rechazada por el host si no existe autorización.
- Cada llamada MCP requiere aprobación modal individual; no se confía en el nombre declarado por el servidor para inferir que es de sólo lectura.
- Cada solicitud queda ligada a la URI raíz inicial y se descarta si el workspace cambia durante el procesamiento.
- El parser de fallback textual descartará bloques `FILE` cuando no exista autorización.
- La respuesta conversacional seguirá mostrándose; el bloqueo no escribirá ni propondrá archivos.

## 4. Explicación de propuestas

### 4.1 Contrato

`FileProposal` incorporará un campo opcional `purpose` para compatibilidad con historiales existentes. Las tools mutantes solicitarán una razón breve orientada al usuario. Al registrar una escritura/edición, el agente asociará ruta y propósito.

### 4.2 Fallback

Si falta la razón, QAPI generará una descripción neutral:

- archivo nuevo: `Crear <ruta> para implementar el cambio solicitado.`
- archivo existente: `Actualizar <ruta> como parte del cambio solicitado.`

La respuesta final con propuestas incluirá siempre una sección `Cambios propuestos` / `Proposed changes`, incluso si el modelo sólo devuelve texto genérico como “usando herramientas”. Cada tarjeta de archivo mostrará `purpose` antes del diff.

## 5. Layout del mensaje

Cada burbuja tendrá estructura vertical:

```html
<div class="bubble">
  <div class="message-mode"><span class="mode-badge">Chat</span></div>
  <div class="message-content">...</div>
  <div class="proposal-list">...</div>
</div>
```

El badge deja de ser un hermano inline del contenido. CSS usará columna, alineación por rol y ancho máximo existente; en móvil seguirá ocupando una línea propia.

## 6. Persistencia y compatibilidad

- `purpose` será opcional al leer historial antiguo.
- No se cambia el esquema de checkpoints.
- Una propuesta bloqueada por falta de intención no se persiste.
- La memoria automática no se usa para inferir autorización mutante: sólo el mensaje actual y el turno inmediato pueden autorizarla.

## 7. Documentación

- Crear `CHANGELOG.md` con formato Keep a Changelog y versión `1.0.0`.
- Añadir una sección `Autor y contacto` al README con nombre, correo y LinkedIn.
- Documentar brevemente la protección contra cambios accidentales y la explicación de propuestas.

## 8. Revisión y entrega

1. Diagnósticos estáticos sobre archivos modificados.
2. Revisión semántica del diff enfocada en seguridad de mutaciones, compatibilidad y UI.
3. Corrección de hallazgos altos/medios.
4. `npm run typecheck`.
5. `npm run build`.
6. `npx --yes @vscode/vsce package --allow-missing-repository`.
7. Verificación de existencia del VSIX y versión del manifiesto.

La publicación externa queda fuera de alcance y requiere aprobación explícita.
