# Requisitos — Calidad pre-release de QAPI

## Objetivo

Preparar QAPI para publicación con una experiencia segura y comprensible: toda propuesta debe explicar qué cambia y por qué, las etiquetas de modo deben tener una jerarquía visual correcta, los mensajes sociales no deben mutar archivos y la entrega debe incluir documentación, revisión técnica y un VSIX validado.

## R1. Explicación de cambios propuestos

**Historia:** Como usuario, quiero entender el propósito de una propuesta antes de aceptarla o rechazarla.

### Criterios de aceptación

1. Cuando una respuesta contenga propuestas de archivos, debe mostrar un resumen visible del objetivo de los cambios.
2. Cada archivo propuesto debe mostrar una explicación breve de qué se cambia y para qué sirve.
3. La explicación debe aparecer antes de las acciones para aplicar o descartar cambios.
4. Si el proveedor no entrega una explicación útil, QAPI debe generar una descripción segura a partir del tipo de operación y la ruta, sin ocultar la propuesta.
5. El historial anterior sin estos campos debe seguir renderizándose sin errores.

## R2. Jerarquía visual de las etiquetas de modo

**Historia:** Como usuario, quiero identificar el modo del turno sin que su etiqueta invada el contenido del mensaje.

### Criterios de aceptación

1. Las etiquetas `Chat` y `Plan QA` deben aparecer en una fila propia sobre el texto del mensaje.
2. La regla debe aplicarse tanto a mensajes del usuario como del asistente.
3. El contenido del mensaje debe comenzar debajo de la etiqueta, alineado dentro de la burbuja.
4. El layout debe conservarse en anchos reducidos y no producir solapamientos ni desbordamiento horizontal.

## R3. Protección contra cambios no solicitados

**Historia:** Como usuario, quiero que saludos o conversación casual reciban una respuesta conversacional y nunca modifiquen el proyecto.

### Criterios de aceptación

1. Entradas sociales triviales como `hi`, `hello`, `hola`, `gracias` o equivalentes no deben recibir herramientas mutantes.
2. QAPI sólo debe exponer `write_file`, `edit_file` y ejecución de comandos cuando exista intención de cambio explícita en la solicitud actual o una confirmación inequívoca de una propuesta previa.
3. La confirmación contextual (`hazlo`, `aplica`, `procede`, `sí`) sólo debe habilitar mutaciones si existe una propuesta o plan pendiente en el historial inmediato.
4. Aunque el modelo emita una llamada mutante o bloques de archivo sin autorización, QAPI debe bloquearla y no producir propuestas.
5. Las herramientas de lectura deben seguir disponibles para preguntas técnicas que requieran investigar el workspace.
6. El modo `Plan QA` debe continuar siendo no mutante.

## R4. Calidad pre-release

**Historia:** Como mantenedor, quiero liberar una extensión revisada y reproducible.

### Criterios de aceptación

1. Se debe revisar el flujo agente → propuestas → aplicación, la persistencia, el índice y la UI en busca de errores concretos.
2. Todo hallazgo de severidad alta o media introducido o expuesto por estos cambios debe corregirse antes del empaquetado.
3. `npm run typecheck` y `npm run build` deben finalizar con código 0.
4. El VSIX debe regenerarse y contener la versión declarada en `package.json`.
5. No se debe publicar al Marketplace ni subir código sin aprobación explícita del usuario.

## R5. Changelog

**Historia:** Como usuario, quiero conocer los cambios relevantes de cada versión.

### Criterios de aceptación

1. Debe existir `CHANGELOG.md` en la raíz.
2. Debe seguir un formato legible basado en Keep a Changelog, con sección de versión y categorías claras.
3. La versión actual debe documentar las capacidades principales y correcciones incluidas en la entrega.

## R6. Datos del autor

**Historia:** Como autor, quiero que el README muestre mis datos de contacto oficiales.

### Criterios de aceptación

1. El README debe incluir `Felipe Farias Alfaro`.
2. Debe incluir el correo enlazado `felipe.farias@centyc.cl`.
3. Debe incluir LinkedIn enlazado a `https://www.linkedin.com/in/felipefariasalfaro/`.
4. Los datos deben aparecer en una sección visible y profesional, sin alterar la documentación técnica existente.
