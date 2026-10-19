# Changelog

Todos los cambios relevantes de QAPI se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto sigue [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]
## [1.2.0] - 2026-10-19
### Añadido
- **Memoria holográfica nativa** (activa por defecto, Configuración > Memoria holográfica): fragmenta el proyecto en funciones, escenarios, pasos y secciones, recupera por resonancia vectorial combinada con BM25 y un glosario bilingüe de QA, informa en cada mensaje qué cambió desde el anterior (también entre sesiones), guarda asociaciones holográficas reversibles (escenario → paso, prueba → código, uso de símbolos), refuerza lo que el agente usa y conserva notas con fuente que se marcan obsoletas al cambiar. Local, privada y sin dependencias ni servicios externos.
- Herramientas `recall_memory`, `read_chunk` y `remember`, y `read_file` con `startLine`/`endLine` para leer sólo un rango.
- Chip "memoria holográfica" en "Contexto usado".
- Interruptor para activar o desactivar cada agente, también los integrados. Es una preferencia personal por proyecto que no modifica `.qapi/agents/`; el estado se conserva al renombrar un agente y el host rechaza ejecutar uno desactivado.
- Diez temas visuales nuevos: Nórdico, Drácula, Retro, Carmesí, Dorado, Negro puro y Esmeralda (oscuros), y Papel, Menta y Cielo (claros).
- Ayudas emergentes propias en toda la interfaz (al pasar el mouse o con el foco del teclado), con soporte de idioma y tema.
### Cambiado
- Con la memoria holográfica, el contexto de cada mensaje lleva referencias compactas y fragmentos en vez de extractos de archivos, y la referencia BDD completa sólo cuando se piden crear o modificar pruebas. En dos repositorios de prueba el contexto bajó de ~24.000 a ~9.000 caracteres por mensaje.
- Rediseño de Skills, Agentes, MCP y Configuración: menos texto fijo y negritas, márgenes en los formularios, modos de activación como píldoras y explicaciones en ayudas emergentes. Las acciones de las tarjetas pasan a iconos.
- Con servidores MCP activos, el agente usa sus tools en vez de improvisar comandos de shell equivalentes; si la petición o una skill menciona un servidor inactivo, pide activarlo.
- El switch "Autoaprobar MCP" sigue visible mientras la autoaprobación esté encendida, aunque no haya servidores activos.
### Corregido
- Activar servidores MCP seguidos o guardar el JSON MCP mientras se activaba uno podía perder la activación.
- Con algunos modelos (Gemini) la respuesta final podía ser sólo `[tools llamadas: …]`: el modelo copiaba el formato que QAPI usaba para registrar las llamadas. Ese registro ahora va en el mensaje de resultados y, si el modelo escribe una llamada como texto, se le pide una vez que la ejecute o responda.
- Una pregunta informativa podía terminar con "No hay nada que cambiar en el repositorio" en lugar de la respuesta: frases como "te voy a explicar" activaban el aviso interno para emitir cambios. Ahora el aviso sólo se activa con verbos de escritura y, si no produce cambios, se entrega la respuesta original.
- En el tema Claro, el texto de los bloques de código, la salida de comandos, el editor JSON y los comandos MCP era ilegible. Ahora usan su propio color de texto (`--qp-code-fg`).
- El botón de peligro y el hover del botón primario conservan contraste suficiente con texto blanco en todos los temas.
### Seguridad
- Los estados de sesión del navegador (`storageState` de Playwright, `auth_sessions/`) ya no se indexan ni se entregan con `read_file`.
## [1.1.4] - 2026-09-17

### Añadido

- **Skills:** nueva pestaña para crear visualmente instrucciones reutilizables que el agente aplica de forma automática, ante eventos (resultado de prueba, preparar archivos), por tipo de archivo, siempre o con `#skill:nombre`. Se pueden limitar a ciertos frameworks o lenguajes e incluyen plantillas (análisis de fallos, localizadores XPath, casos límite, reporte de bug). Se guardan en `.qapi/skills/`.
- **Pestaña MCP:** formulario para añadir y editar servidores, plantillas (Filesystem, Playwright, Git, Fetch), botón **Probar conexión** que lista las tools y edición JSON opcional.
- Switch **Autoaprobar MCP** en el chat y opción **Permitir siempre** en el diálogo de aprobación.
- **Selector de modelo** en el compositor para cambiar de modelo sin ir a Configuración.
- Botón **Detener** para cancelar una respuesta o un comando en curso.
- Verificación de archivos creados: QAPI detecta cuando la respuesta menciona archivos que no se prepararon ni existen, pide corregirlo y lo advierte; al aplicar, relee cada archivo desde el disco y confirma su contenido.
- Comando de verificación definido por el usuario, con los marcadores `{tests}`, `{files}` y `{tests,}`, y el nuevo modo **Proponer el comando**.

### Cambiado

- La verificación tras aplicar cambios ya no detecta ni ejecuta comandos por su cuenta: sólo corre el comando que defina el usuario, y con `{tests}` se limita a las pruebas que cambiaron.
- El compositor adopta un diseño de cuadro único con el modelo, el switch MCP y el botón de envío en una barra inferior. Se retiró el selector Agente/Plan QA.
- Los servidores MCP se reutilizan entre mensajes y se apagan tras 10 minutos sin uso, en lugar de iniciarse en cada mensaje.
- La búsqueda de código es literal por defecto; para una expresión regular se usa la forma `/patrón/`.
- El índice se actualiza de forma incremental al guardar, incluye manifiestos (`requirements.txt`, `pom.xml`, `behave.ini`, etc.) y excluye carpetas de reportes (Allure, Playwright, `test-results`).
- Mejor extracción de steps: comillas internas, expresiones regulares en JS, `parsers.parse` de pytest-bdd y Cucumber-JVM.
- Límites de contexto actualizados por modelo; los modelos pequeños ya no resumen la conversación en cada turno y Ollama recibe `num_ctx`.
- El streaming actualiza sólo el texto nuevo: se puede escribir y desplazarse mientras llega la respuesta.

### Corregido

- El agente a veces leía archivos pero no los creaba: ahora detecta respuestas cortadas por el límite de salida, narraciones sin ejecución y el agotamiento de pasos, y conserva las herramientas de escritura hasta el final.
- La redacción de secretos podía corromper archivos con credenciales de prueba; ahora es reversible.
- El mensaje del usuario se enviaba duplicado al modelo y algunos historiales rompían la alternancia de roles exigida por Claude y Gemini.
- Las peticiones sin respuesta del proveedor dejaban QAPI bloqueado; ahora tienen timeout y se pueden cancelar.
- El timeout de comandos no terminaba los procesos hijos; la salida guardada ahora conserva el final, donde va el resumen de fallos.
- Aplicar cambios mientras el agente respondía, o pulsar Nueva durante una respuesta, podía perder estado o revivir la conversación borrada.
- Los globs con `**` de steering no coincidían nunca.
- La corrección automática nunca aplicaba sus cambios.
- Los esquemas MCP con `anyOf`, `oneOf` o tipos múltiples se convertían en texto.
- Se conserva el borrador de la API key al cambiar el tema o la fuente.

### Seguridad

- La API key ya no se envía a la interfaz y la de Gemini viaja en un header.
- No se leen ni envían archivos `.env*`, `credentials*`, `secrets*`, claves privadas ni el contenido de `.git`, y se bloquea la escritura en `.git` y mediante symlinks colgantes.
- La corrección automática sólo puede editar los archivos citados en el error, nunca manifiestos, scripts ni carpetas de configuración.
- Se bloquean más formas de comandos destructivos (`curl … | sh`, `$(…)`, `bash -c`, `git push +rama`, `find -delete`).
- Las skills sólo se cargan en workspaces confiables.

## [1.0.1] - 2026-09-17

### Añadido

- Botones **-a/+A** en el encabezado del Agente para reducir o aumentar el tamaño de fuente con un clic, junto a la acción Nueva.
- Seis temas visuales opcionales además de Oscuro y Claro: Medianoche, Océano, Bosque, Atardecer, Monocromo y Solarizado, seleccionables en Configuración > Apariencia.
- Nuevo modo de entrada de **texto libre** para agentes personalizados: permite pegar un requisito, historia o documento, o adjuntar un archivo, sin depender de archivos del proyecto.

### Cambiado

- El fondo de los bloques de código, diffs, salidas de comandos y editor JSON de MCP ahora es casi negro para mejorar el contraste y la legibilidad.
- El tamaño de fuente mínimo del webview bajó de 11 px a 9 px, y los botones del encabezado quedan sincronizados con el control deslizante de Apariencia.
- Se rediseñó el conjunto de agentes integrados: el generador de casos de prueba ahora produce archivos `.feature` en Gherkin a partir de texto libre, y se depuró el catálogo de agentes de ejemplo.

## [1.0.0] - 2026-09-10

### Añadido

- Agente de IA especializado en QA con modos Agente y Plan QA.
- Soporte para Gemini, Claude, OpenAI y Ollama.
- Contexto del editor, Problems, Git, perfil del proyecto y recuperación léxica local.
- Propuestas revisables con diff por archivo y hunk, aplicación selectiva y checkpoints seguros.
- Propuestas controladas de comandos de test, lint y build.
- Integración MCP por `stdio`, memoria editable y memoria automática validada por hashes.
- Análisis de impacto de pruebas, artefactos recientes y trazabilidad estática.
- Configuración bilingüe, temas y almacenamiento seguro de API keys mediante SecretStorage.
- Explicación visible del propósito de cada archivo propuesto.

### Cambiado

- Las etiquetas Usuario, Agente y Plan QA ahora aparecen sobre el contenido de cada mensaje.
- La memoria de investigación reutiliza resultados vigentes y evita exploraciones repetidas.
- Las propuestas muestran qué se cambiará y por qué antes de las acciones de aprobación.

### Corregido

- Se impide que saludos como `hi!` o conversación social activen herramientas o propuestas de archivos.
- Se añadieron barreras host-side antes y después de las llamadas del modelo para bloquear mutaciones no autorizadas.
- Se corrigieron invalidaciones concurrentes y ventanas de caché obsoleta durante el reindexado.
- Se reforzó la canonicalización de rutas y la redacción de credenciales, tokens, claves privadas y JWT.
- Se corrigió la contracción de acordeones de Configuración al abrir varias secciones.
- Se corrigió el panel QAPI vacío tras reinstalar o actualizar la extensión mientras estaba anclado a la barra lateral secundaria.
- El contador de tokens ahora mide sólo la conversación actual y vuelve a cero al crear una nueva, sin eliminar la reserva interna de seguridad.
- Se reemplazó la etiqueta "Chat" por "Agente" en la interfaz y la documentación para reflejar que QAPI ejecuta acciones (lee, escribe, ejecuta comandos y se autocorrige), no sólo conversa.

### Seguridad

- Los cambios de archivos y comandos requieren intención explícita o confirmación inequívoca de una propuesta o plan inmediato.
- Cada llamada MCP requiere aprobación modal individual antes de ejecutar una tool externa.
- Plan QA permanece no mutante y los mensajes sociales se procesan sin historial, contexto del workspace, MCP ni herramientas.

[Unreleased]: https://github.com/FelipeFariasAlfaro/QAPI/compare/v1.1.4...HEAD
[1.1.4]: https://github.com/FelipeFariasAlfaro/QAPI/compare/v1.0.1...v1.1.4
[1.0.1]: https://github.com/FelipeFariasAlfaro/QAPI/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/FelipeFariasAlfaro/QAPI/releases/tag/v1.0.0
