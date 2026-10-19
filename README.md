# QAPI - Agente de inteligencia artificial

QAPI es un agente de inteligencia artificial dentro de VS Code, especializado en QA, testing y automatización. Analiza el workspace abierto, investiga con herramientas propias y prepara cambios de código, pruebas y comandos para que tú los revises y apruebes.

- Versión actual: `1.2.0`
- VS Code: `1.85.0` o superior
- Licencia: [MIT](LICENSE)
- Historial de cambios: [CHANGELOG.md](CHANGELOG.md)
- Repositorio oficial: [github.com/FelipeFariasAlfaro/QAPI](https://github.com/FelipeFariasAlfaro/QAPI)

## Características principales

- **Agente QA con contexto real del proyecto:** archivo activo, selección, editores visibles, Problems, Git status y Git diff, mapa del repositorio y búsqueda local.
- **Detección del stack:** lenguajes, frameworks de prueba (Behave, pytest, Playwright, Cypress, Jest, JUnit y otros), manifiestos y convenciones Gherkin, incluidos los steps existentes para reutilizarlos.
- **Cambios revisables:** cada archivo propuesto explica qué cambia y por qué, con diff por archivo y por hunk, aplicación selectiva, checkpoints y deshacer seguro.
- **Verificación de lo creado:** QAPI comprueba que los archivos que el agente dice haber creado existan, y al aplicar relee cada archivo desde el disco para confirmar su contenido.
- **Skills:** instrucciones reutilizables que el agente aplica de forma automática, ante eventos (resultado de prueba, preparar un archivo), por tipo de archivo o a pedido. Se crean visualmente, sin editar Markdown.
- **MCP:** pestaña para añadir, probar y activar servidores MCP por `stdio`, con plantillas (Playwright, Filesystem, Git, Fetch) y aprobación por llamada o autoaprobación.
- **Verificación definida por ti:** tú eliges el comando y su alcance (por ejemplo `behave {tests}` para correr sólo las pruebas que cambiaron). QAPI nunca elige ni ejecuta una suite por su cuenta.
- **Comandos con aprobación:** el agente propone comandos de test, lint o build y sólo se ejecutan cuando los apruebas. Puedes detenerlos en cualquier momento.
- **Selector de modelo en el chat** y botón **Detener** para cancelar una respuesta en curso.
- **Agentes personalizados** con instrucción fija, entrada por archivos o texto libre y salida al chat o a un archivo.
- Diagnóstico de reportes, logs y traces; análisis de pruebas impactadas por el Git diff; trazabilidad estática entre requisitos, escenarios, steps y pruebas.
- **Memoria holográfica nativa:** el agente conoce el estado del proyecto en cada mensaje (qué funciones, escenarios o archivos cambiaron) y recibe fragmentos pequeños en lugar de archivos completos, con menos tokens por mensaje.
- Memoria editable por proyecto y memoria automática de investigación validada por hash.
- Proveedores Gemini, Claude, OpenAI y Ollama local.
- Privacidad: sin telemetría, API keys en `SecretStorage` y redacción de secretos antes de enviar contexto al modelo.
- Interfaz en español o inglés, 18 temas visuales y tamaño de fuente ajustable.

## Instalación

QAPI está disponible en los dos catálogos oficiales del ecosistema VS Code:

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=centyc.qa-pi)
- [Open VSX Registry](https://open-vsx.org/extension/centyc/qa-pi)

Busca **QAPI - Agente de inteligencia artificial** en la vista **Extensions** de tu editor y selecciona **Install**.

### Primer inicio

1. Selecciona **Español** o **English**. Esta preferencia define la interfaz y las respuestas futuras del agente.
2. Abre **Configuración > Proveedor de IA**.
3. Selecciona un proveedor.
4. Ingresa la API key cuando corresponda, o la URL local de Ollama.
5. Pulsa **Validar**, selecciona un modelo y guarda la configuración.
6. Regresa a **Agente QAPI** y escribe tu primera solicitud.

El idioma puede cambiarse después desde **Configuración > Idioma**. Las conversaciones anteriores conservan su texto original; el nuevo idioma se aplica a la interfaz y a las respuestas futuras.

## Guía de la interfaz

QAPI se organiza en seis pestañas: **Agente QAPI**, **Agentes**, **Skills**, **MCP**, **Configuración** y **Sobre Centyc**.

### Agente QAPI

Es el área principal de trabajo. Muestra el proyecto activo, el estado del índice, el uso estimado de la ventana de contexto, el historial y el compositor.

#### Compositor

- Escribe tu solicitud y usa `#` para añadir contexto explícito: `#file:ruta`, `#folder:ruta`, `#problems`, `#gitDiff` o `#skill:nombre`.
- **Selector de modelo:** cambia el modelo para los próximos mensajes sin ir a Configuración.
- **Autoaprobar MCP:** aparece cuando hay servidores MCP activos. Encendido, las tools MCP se ejecutan sin pedir confirmación en cada llamada.
- **Enviar / Detener:** mientras QAPI trabaja, el botón cambia a **Detener** y cancela la respuesta o el comando en curso.
- Botones **-a/+A** en el encabezado para ajustar el tamaño de fuente, y **Nueva** para empezar una conversación limpia.

Puedes seguir escribiendo y desplazarte por el historial mientras llega una respuesta.

#### Contexto utilizado

Cada respuesta indica qué fuentes usó: archivo activo, selección, archivos visibles, Problems, Git, metadatos de terminales, memoria automática y skills aplicadas. VS Code no permite leer el historial de terminales ajenas; QAPI sólo usa sus metadatos y la salida de procesos iniciados por la propia extensión.

#### Propuestas de cambios

Cuando el agente necesita modificar el proyecto:

1. Lee e investiga los archivos relevantes.
2. Prepara una edición exacta o el contenido completo de un archivo.
3. Explica el objetivo general y, para cada archivo, qué cambia y por qué.
4. Presenta un diff dividido en hunks.
5. Permite seleccionar todos los cambios, archivos completos o hunks individuales.
6. Aplica únicamente lo aprobado y crea un checkpoint para restaurar de forma segura.
7. Relee cada archivo aplicado desde el disco y confirma en el turno que quedó con el contenido esperado.

Si la respuesta del agente menciona haber creado archivos que no preparó y que no existen en el proyecto, QAPI le pide que los prepare. Si siguen faltando, la respuesta lo advierte claramente.

Las herramientas de escritura sólo se habilitan cuando la solicitud expresa intención de cambio o confirma una propuesta inmediata. Saludos como `hola` se responden sin herramientas ni contexto del workspace. QAPI comprueba que los archivos no hayan cambiado desde que se preparó la propuesta y nunca sobrescribe conflictos de forma silenciosa. Nunca escribe en `.git`.

#### Comandos y ejecuciones

El agente puede proponer comandos de test, lint o build, pero no los ejecuta solo. Cada propuesta muestra el comando y su motivo, y tú decides si lo ejecutas. La salida, duración, estado y código de salida quedan en la conversación. Las ejecuciones fallidas ofrecen **Diagnosticar con IA**.

Los comandos tienen un tiempo máximo; al alcanzarlo o al pulsar **Detener**, QAPI termina el proceso y todos sus procesos hijos. Se bloquean operaciones evidentemente destructivas (por ejemplo `rm -rf`, `git push --force`, `curl … | sh`) y directorios de trabajo fuera del workspace.

### Agentes

Presets con una instrucción fija para tareas repetibles. Cada agente toma como entrada archivos del proyecto (filtrados por un glob) o texto libre y un archivo adjunto, y entrega el resultado en el chat o en un archivo. Incluye agentes para documentación de negocio y generación de casos de prueba en Gherkin. Se guardan en `.qapi/agents/` para compartirlos con el equipo.

Cada agente, incluidos los integrados, tiene un interruptor para activarlo o desactivarlo. Un agente desactivado sigue visible pero atenuado y no se puede ejecutar. Es una preferencia personal por proyecto: no se escribe en el archivo del agente, así que no genera cambios en Git ni afecta a tu equipo.

### Skills

Instrucciones reutilizables que el agente aplica cuando corresponde: cómo analizar fallos, cómo escribir localizadores, convenciones del equipo. Se crean y editan desde un formulario visual y se guardan en `.qapi/skills/*.md`, versionables con el proyecto.

Cada skill define **cuándo se usa**:

| Modo | Cuándo se aplica |
| --- | --- |
| Automática | El agente lee la descripción y la carga sólo si la tarea la necesita |
| Ante un evento | **Resultado de prueba** o **Al preparar archivos** (con un patrón opcional) |
| Por tipo de archivo | Cuando trabajas con archivos que coinciden con un patrón, por ejemplo `**/*.feature` |
| Siempre | En todos los mensajes |
| Manual | Sólo cuando la nombras con `#skill:nombre` |

También puedes limitar una skill a proyectos con ciertos frameworks o lenguajes (por ejemplo, sólo Behave). Hay plantillas listas: análisis de fallos, localizadores con XPath, casos límite y negativos, y reporte de bug.

Con el evento **Resultado de prueba**, cuando un comando que ejecutaste falla, QAPI abre un análisis automático con esa skill. Una skill es una instrucción para el modelo, no una regla obligatoria: normalmente la sigue, pero puede desviarse. Sólo se cargan en workspaces confiables.

### MCP

Conecta herramientas externas al agente mediante servidores MCP por `stdio`.

- Añade o edita servidores con un formulario (nombre, comando, argumentos y variables de entorno) o edita el JSON directamente.
- Parte de plantillas: Filesystem, Playwright, Git y Fetch.
- **Probar conexión** inicia el servidor, lista sus tools y lo cierra, para comprobar que funciona antes de usarlo.
- Activa cada servidor con su interruptor. Los servidores activos se reutilizan entre mensajes y se apagan tras 10 minutos sin uso.

Cada llamada a una tool MCP pide aprobación (**Permitir una vez** o **Permitir siempre**), salvo que actives **Autoaprobar MCP** en el chat. Activa sólo servidores de confianza: se ejecutan con tus permisos. Las plantillas usan la última versión del paquete; puedes fijar una versión en los argumentos (`paquete@1.2.3`). Las variables de entorno se guardan sin cifrar en la configuración de VS Code.

Ejemplo de configuración:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    },
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "."]
    }
  }
}
```

### Configuración

Todas las secciones son acordeones. Haz clic en el encabezado para abrir la que necesites.

#### Idioma

Cambia entre español e inglés. Actualiza la interfaz, los mensajes automáticos y las respuestas futuras del agente. No reescribe el historial existente.

#### Proveedor de IA

Configura Gemini, Claude, OpenAI u Ollama: valida credenciales, obtiene los modelos disponibles, guarda el modelo elegido y registra su límite de contexto cuando el proveedor lo informa. La API key guardada nunca se muestra; deja el campo vacío para conservarla.

#### Comportamiento: verificación tras aplicar cambios

Elige qué hacer después de aplicar cambios:

- **No verificar** (predeterminado).
- **Proponer el comando:** deja el comando listo con su botón Ejecutar.
- **Ejecutar el comando después de aplicar.**
- **Ejecutar y corregir automáticamente:** reintenta hasta 3 veces y sólo edita los archivos citados en el error, nunca manifiestos, scripts ni carpetas de configuración.

El **comando de verificación** lo defines tú y admite marcadores:

| Marcador | Se reemplaza por |
| --- | --- |
| `{tests}` | Los archivos de prueba que cambiaron. Si no cambió ninguno, no se ejecuta nada |
| `{files}` | Todos los archivos cambiados |
| `{tests,}` | Los archivos de prueba unidos con comas (por ejemplo para `cypress run --spec`) |

Ejemplos: `behave {tests}`, `pytest {tests}`, `npx playwright test {tests}`. Sin marcadores, el comando se ejecuta tal cual; evita suites completas en proyectos grandes. **Sugerir para este proyecto** propone una plantilla según el framework detectado, que sólo se usa si la guardas. La verificación sólo funciona en workspaces confiables.

#### Memoria holográfica

Activa por defecto. QAPI divide el proyecto en fragmentos con significado propio (funciones, clases, métodos, escenarios Gherkin, definiciones de pasos y secciones Markdown) y mantiene una memoria distribuida local, sin modelos ni servicios externos:

- **Recuperación por resonancia:** cada fragmento tiene un vector de contenido; la consulta se compara con todos y el resultado se combina con el BM25 del índice. Un glosario bilingüe de QA hace que "inicio de sesión" encuentre `login` o "captura de pantalla" encuentre `screenshot`.
- **Estado del proyecto:** en cada mensaje sincroniza sólo los archivos cuyo hash cambió y le dice al agente qué funciones, escenarios o archivos se añadieron, modificaron o borraron desde el mensaje anterior, incluso entre sesiones.
- **Asociaciones holográficas:** cada fragmento guarda en un único vector sus relaciones (escenario → definición del paso, prueba → código, uso de símbolos importados). Se recuperan desuniendo y limpiando con un umbral de ruido; las actualizaciones son exactas y reversibles.
- **Plasticidad:** los fragmentos que el agente lee se refuerzan y quedan asociados entre sí; el refuerzo decae con el tiempo.
- **Notas aprendidas:** con la herramienta `remember` el agente guarda notas breves con los archivos que las respaldan. Si esos archivos cambian, la nota se marca como posiblemente obsoleta. Se ven y se borran en esta sección.

En lugar de extractos de archivo, el contexto lleva referencias de una línea (`[id] ruta:líneas · firma`) y el contenido de los fragmentos más relevantes. El agente lee más con `read_chunk(id)` o `read_file` con `startLine`/`endLine`. En preguntas que no escriben pruebas, la referencia BDD se reduce a las convenciones y a los pasos más relacionados; al pedir crear o modificar pruebas se incluye completa.

La memoria vive en el almacenamiento privado del proyecto en VS Code: no escribe en el repositorio ni en `.qapi/`. Excluye `.env`, credenciales, claves y estados de sesión del navegador (`storageState`, `auth_sessions/`). Al apagarla, QAPI vuelve al contexto clásico.

#### Memoria del proyecto

Guarda convenciones, objetivos, decisiones y reglas del workspace, que se añaden al contexto de conversaciones futuras (hasta 12.000 caracteres).

QAPI mantiene además una **memoria automática de investigación**: conserva de forma local y acotada los archivos leídos y las búsquedas realizadas, y los reutiliza sólo si su hash sigue coincidiendo con el índice actual. Puedes borrarla desde la Command Palette con **QAPI: Limpiar memoria automática**.

#### Checkpoints recientes

Lista las restauraciones disponibles para cambios aplicados por QAPI. Cada checkpoint conserva el estado anterior y posterior de los archivos con hashes para detectar modificaciones externas. Deshacer se bloquea si podría sobrescribir cambios posteriores.

#### Trazabilidad estática inferida

Relaciona IDs o tags de requisito (por ejemplo `@ABC-123` o `REQ-12`), escenarios Gherkin, steps, definiciones de steps y archivos de prueba, e informa los huecos detectados. Es evidencia estática: no sustituye la ejecución de pruebas ni la cobertura runtime.

#### Apariencia

18 temas visuales (Oscuro, Claro, Medianoche, Océano, Bosque, Atardecer, Monocromo, Solarizado, Nórdico, Drácula, Retro, Carmesí, Dorado, Negro puro, Esmeralda, Papel, Menta y Cielo) y tamaño de fuente entre 9 px y 18 px. Los bloques de código usan un fondo casi negro en todos los temas.

### Sobre Centyc

Información y acceso al Centro Latinoamericano de Testing y Calidad de Software, junto con el aviso de privacidad, la licencia MIT y el enlace al repositorio oficial.

## Proveedores compatibles

| Proveedor | Autenticación | Configuración adicional |
| --- | --- | --- |
| Gemini | API key | Lista modelos y su límite de contexto mediante la API de Google |
| Claude | API key | Lista modelos mediante la API de Anthropic |
| OpenAI | API key | Admite la URL base predeterminada u otra compatible |
| Ollama | No requiere API key | URL local predeterminada: `http://localhost:11434` |

La disponibilidad, los límites, los costos y las políticas de datos dependen del proveedor y del modelo configurado.

## Privacidad y seguridad

QAPI no incluye telemetría propia, publicidad, cuentas de usuario ni un backend de recolección de datos.

| Información | Almacenamiento |
| --- | --- |
| API keys | `SecretStorage` de VS Code, protegido por el sistema operativo. Nunca se envían a la interfaz |
| Proveedor, modelo, idioma, apariencia, verificación y MCP | `globalState` local de VS Code |
| Historial, memoria editable, memoria automática, memoria holográfica y checkpoints | `workspaceState` local, separado por workspace |
| Skills y agentes personalizados | Archivos del proyecto en `.qapi/` |

Al enviar un mensaje, QAPI transmite al proveedor configurado el prompt y el contexto necesario. Antes, oculta los valores de contraseñas, tokens, claves privadas y credenciales en URLs; al escribir archivos los restaura, para no corromper credenciales de prueba. QAPI no lee ni envía archivos `.env`, `credentials*`, `secrets*`, claves (`.pem`, `.key`) ni el contenido de `.git`. Con Ollama, el procesamiento puede mantenerse local.

Los servidores MCP son procesos externos a QAPI. Revisa su código, permisos y política de datos antes de habilitarlos.

## Comandos de VS Code

Disponibles desde la Command Palette:

- `QAPI: Abrir agente`
- `QAPI: Configuración`
- `QAPI: Reindexar proyecto`
- `QAPI: Limpiar conversación`
- `QAPI: Limpiar memoria automática`

## Arquitectura

QAPI utiliza TypeScript y dos bundles independientes construidos con esbuild:

- **Extension host (`dist/extension.js`):** integración con VS Code, almacenamiento, contexto, proveedores, herramientas y ejecución.
- **Webview (`dist/webview.js`):** interfaz de todas las pestañas.

| Archivo | Responsabilidad |
| --- | --- |
| `src/extension.ts` | Activación, vista lateral, comandos e índice del workspace |
| `src/panel.ts` | Coordinación entre webview, Store, agente y servicios |
| `src/agent.ts` | Prompts, bucle de herramientas, verificación de archivos afirmados y orquestación de tools locales/MCP |
| `src/providers.ts` | Integraciones con Gemini, Claude, OpenAI y Ollama, con timeouts y cancelación |
| `src/skills.ts` | Formato, almacenamiento y selección de skills |
| `src/secretVault.ts` | Redacción reversible de secretos |
| `src/projectIndex.ts` | Índice léxico incremental, búsqueda, steps y convenciones Gherkin |
| `src/memory/` | Memoria holográfica: codificador bilingüe, fragmentador, primitivas HDC, asociaciones, notas y servicio de persistencia |
| `src/investigationMemory.ts` | Caché automática de investigaciones validada por hash |
| `src/projectProfile.ts` | Detección de stack, frameworks y manifiestos |
| `src/ideContext.ts` | Archivo activo, selección, Problems, Git, artefactos e impacto |
| `src/changes.ts` | Diffs, hunks, aplicación selectiva, verificación en disco y checkpoints |
| `src/execution.ts` | Ejecución controlada de comandos y comando de verificación |
| `src/verification.ts` | Verificación tras aplicar y corrección automática acotada |
| `src/mcp.ts` / `src/mcpRuntime.ts` | Configuración, pool de servidores y llamadas MCP por `stdio` |
| `src/customAgents.ts` | Agentes personalizados |
| `src/traceability.ts` | Trazabilidad estática y detección de gaps |
| `src/store.ts` | Preferencias, secretos y estado por workspace |
| `src/contextWindow.ts` | Límites de contexto y resumen de conversaciones extensas |
| `src/webview/main.ts` | UI, localización y eventos del webview |
| `media/webview.css` | Temas, layout y componentes visuales |

## Desarrollo local

### Requisitos

- Node.js 18 o superior.
- npm.
- VS Code 1.85.0 o superior.

### Preparación

```bash
git clone https://github.com/FelipeFariasAlfaro/QAPI.git
cd QAPI
npm install
npm run typecheck
npm run build
```

Pulsa `F5` en VS Code para abrir una ventana **Extension Development Host** con QAPI cargado.

### Scripts

```bash
npm run typecheck   # TypeScript del host y del webview
npm run build       # Bundle de producción
npm run watch       # Recompilación durante desarrollo
npm run package     # Genera qa-pi.vsix
```

## Contribuir

Las contribuciones de la comunidad son bienvenidas:

1. Crea un fork del repositorio.
2. Abre una rama descriptiva desde la rama principal.
3. Mantén los cambios enfocados y coherentes con la arquitectura existente.
4. Ejecuta `npm run typecheck` y `npm run build`.
5. Abre un Pull Request explicando el problema, la solución y cómo se validó.

Para reportar errores o proponer mejoras, utiliza [GitHub Issues](https://github.com/FelipeFariasAlfaro/QAPI/issues). No incluyas credenciales, información sensible ni contenido privado del proyecto en los reportes.

## Autor y contacto

- **Felipe Farias Alfaro**
- **Correo:** [felipe.farias@centyc.cl](mailto:felipe.farias@centyc.cl)
- **LinkedIn:** [linkedin.com/in/felipefariasalfaro](https://www.linkedin.com/in/felipefariasalfaro/)

## Licencia

QAPI es software de código abierto distribuido bajo la [Licencia MIT](LICENSE). Puedes usarlo, modificarlo y redistribuirlo de acuerdo con sus términos.

Copyright © 2026 Felipe Farias Alfaro.
