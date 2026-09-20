# QAPI - Agente de inteligencia artificial

QAPI es un agente de inteligencia artificial dentro de VS Code, especializado en QA, testing y automatización. Analiza el workspace abierto, investiga con herramientas propias y puede preparar cambios de código, pruebas y comandos para que la persona usuaria los revise y apruebe.

- Versión actual: `1.0.1`
- VS Code: `1.85.0` o superior
- Licencia: [MIT](LICENSE)
- Historial de cambios: [CHANGELOG.md](CHANGELOG.md)
- Repositorio oficial: [github.com/FelipeFariasAlfaro/QAPI](https://github.com/FelipeFariasAlfaro/QAPI)

## Características principales

- Interfaz y respuestas del asistente en español o inglés.
- Selección obligatoria de idioma en el primer inicio.
- Contexto del editor: archivo activo, selección, editores visibles y Problems.
- Contexto del repositorio: mapa de archivos, búsqueda léxica local, Git status y Git diff.
- Detección del stack, framework de pruebas y convenciones existentes.
- Modos **Agente** y **Plan QA**.
- Creación y edición de archivos mediante propuestas revisables, con explicación de qué cambia y por qué.
- Protección host-side para que saludos y solicitudes sin intención explícita no generen cambios.
- Diff por archivo y por hunk, con aplicación selectiva.
- Checkpoints persistentes y deshacer con verificación de conflictos.
- Comandos de test, lint o build ejecutados únicamente después de aprobación.
- Validación automática opcional después de aplicar cambios.
- Análisis de pruebas probablemente impactadas por el Git diff.
- Diagnóstico de reportes, logs, screenshots y traces recientes.
- Trazabilidad estática entre requisitos, escenarios, steps y pruebas.
- Memoria editable y persistente por workspace.
- Memoria automática de investigación con caché validada por hash para evitar lecturas repetidas.
- Integración con servidores MCP por `stdio`.
- Proveedores Gemini, Claude, OpenAI y Ollama local.
- API keys almacenadas mediante `SecretStorage` de VS Code.
- Ocho temas visuales (Oscuro, Claro, Medianoche, Océano, Bosque, Atardecer, Monocromo y Solarizado) con bloques de código de alto contraste.
- Tamaño de fuente configurable desde el encabezado del Agente (botones -a/+A) o desde Apariencia, con un mínimo de 9 px.

## Instalación

QAPI se distribuirá en los dos catálogos oficiales del ecosistema VS Code:

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

El idioma puede cambiarse posteriormente desde **Configuración > Idioma**. Las conversaciones anteriores conservan su texto original; el nuevo idioma se aplica a la interfaz y a las respuestas futuras.

## Guía de la interfaz

### Agente QAPI

Es el área principal de trabajo con el asistente. Muestra el proyecto activo, el estado del índice local, el uso estimado de la ventana de contexto, el historial y el compositor de mensajes.

#### Modos del agente

- **Agente:** investiga el proyecto, responde preguntas y puede preparar cambios o comandos para aprobación.
- **Plan QA:** investiga y diseña una solución sin modificar archivos ni ejecutar comandos. Entrega objetivo, hallazgos, alcance, riesgos, criterios de aceptación, archivos probables, tareas y validación. Un plan puede enviarse posteriormente al modo Agente para ejecutarlo.

#### Acciones rápidas

- **Pruebas impactadas:** relaciona los archivos presentes en el Git diff con pruebas probablemente afectadas y sugiere comandos verificables. El resultado es una inferencia, no una garantía de cobertura.
- **Diagnosticar último reporte:** localiza el artefacto de pruebas más reciente —reporte, log, screenshot o trace— y solicita al agente un diagnóstico basado en esa evidencia.
- **Nueva conversación:** elimina el historial del workspace actual y comienza una conversación limpia.

#### Contexto utilizado

Cada respuesta puede indicar qué fuentes estuvieron disponibles: archivo activo, selección del editor, archivos visibles, Problems, Git y metadatos de terminales. VS Code no permite leer el historial de terminales ajenas; QAPI sólo usa sus metadatos y la salida de procesos iniciados por la propia extensión.

#### Propuestas de cambios

Cuando el agente necesita modificar el proyecto:

1. Lee e investiga los archivos relevantes.
2. Prepara una edición exacta o el contenido completo de un archivo.
3. Explica el objetivo general y, para cada archivo, qué cambia y por qué.
4. Presenta un diff dividido en hunks.
5. Permite seleccionar todos los cambios, archivos completos o hunks individuales.
6. Aplica únicamente lo aprobado.
7. Crea un checkpoint para permitir una restauración segura.

Las herramientas de escritura y comandos sólo se habilitan cuando la solicitud actual expresa intención de cambio o confirma inequívocamente una propuesta o plan inmediato. Saludos como `hi!` o `hola` se responden sin herramientas, MCP, contexto del workspace ni reanudación de tareas anteriores.

QAPI comprueba que los archivos no hayan cambiado desde que se preparó la propuesta. Si detecta un conflicto, evita sobrescribir contenido de forma silenciosa.

#### Comandos y ejecuciones

El agente puede proponer comandos de test, lint o build, pero no los ejecuta automáticamente. Cada propuesta muestra el comando y su motivo; la persona usuaria decide si lo aprueba. La salida, duración, estado y código de salida quedan asociados a la conversación.

### Configuración

Todas las secciones son acordeones inicialmente plegados. Haz clic en el encabezado para abrir la sección necesaria.

#### Idioma

Cambia entre español e inglés. La selección actualiza inmediatamente los textos de la interfaz, los mensajes automáticos, los resúmenes y las respuestas futuras del agente. No traduce ni reescribe el historial existente.

#### Proveedor de IA

Configura la conexión con Gemini, Claude, OpenAI u Ollama:

- valida credenciales o conectividad;
- obtiene los modelos disponibles;
- guarda el modelo elegido;
- registra el límite de contexto cuando el proveedor lo informa;
- permite definir la URL de Ollama local.

Las API keys no se guardan en archivos del repositorio ni en texto plano dentro de la configuración de QAPI.

#### Comportamiento

Incluye la opción **Ejecutar validación detectada automáticamente**. Al activarla, QAPI intenta ejecutar un comando de validación reconocido después de aplicar cambios. Sólo funciona en workspaces confiables y permanece desactivada por defecto.

#### Memoria del proyecto

Permite guardar manualmente convenciones, objetivos, decisiones y reglas específicas del workspace. Esta memoria se añade al contexto de conversaciones futuras y puede editarse o eliminarse en cualquier momento. Su límite actual es de 12.000 caracteres.

Además, QAPI mantiene una **memoria automática de investigación** separada. Conserva de forma local y acotada los archivos ya leídos y las consultas de estructura o código realizadas. Antes de investigar una nueva solicitud, recupera sólo los recuerdos relacionados y comprueba sus hashes contra el índice actual:

- si un archivo no cambió, reutiliza el contenido ya inspeccionado;
- si cambió, elimina esa entrada y vuelve a leerla cuando sea necesario;
- cualquier cambio del índice invalida las búsquedas y listados que podrían estar obsoletos;
- sólo se cachean archivos incluidos en el índice y de hasta 200 KiB; el resto se vuelve a leer cuando haga falta;
- los archivos menos recientes se eliminan automáticamente al alcanzar el límite de la caché.

La memoria automática puede eliminarse desde la Command Palette con **QAPI: Limpiar memoria automática**.

#### Checkpoints recientes

Lista las últimas restauraciones disponibles para cambios aplicados por QAPI. Cada checkpoint conserva el estado anterior y posterior de los archivos, junto con hashes para detectar modificaciones externas. Deshacer se bloquea si la operación podría sobrescribir cambios posteriores.

#### Trazabilidad estática inferida

Analiza el contenido indexado para relacionar:

- IDs o tags de requisitos;
- escenarios Gherkin;
- steps y definiciones de steps;
- archivos de prueba;
- vínculos y gaps inferidos.

Esta sección aporta evidencia estática. No sustituye la ejecución de pruebas, la cobertura runtime ni una matriz de trazabilidad validada por el equipo.

#### Apariencia

Permite elegir entre ocho temas visuales —Oscuro, Claro, Medianoche, Océano, Bosque, Atardecer, Monocromo y Solarizado— y ajustar el tamaño de fuente del webview (entre 9 px y 18 px). El tamaño también puede modificarse con los botones **-a/+A** del encabezado del Agente. Los bloques de código usan un fondo casi negro en todos los temas para mejorar el contraste.

#### Servidores MCP

Acepta una configuración JSON compatible con el formato `mcpServers`. QAPI valida la estructura y comprueba que cada ejecutable exista antes de permitir su activación.

Habilitar un servidor autoriza a QAPI a iniciar su proceso y descubrir sus tools durante la conversación con el agente. Cada llamada MCP requiere una aprobación modal individual antes de ejecutarse, porque es externa y puede leer o modificar datos según su implementación. Activa únicamente servidores de confianza.

Ejemplo:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git"]
    }
  }
}
```

### Sobre Centyc

Presenta información y acceso al Centro Latinoamericano de Testing y Calidad de Software, junto con el aviso de privacidad, la licencia MIT y el enlace al repositorio oficial de QAPI.

## Proveedores compatibles

| Proveedor | Autenticación | Configuración adicional |
| --- | --- | --- |
| Gemini | API key | Lista modelos mediante la API de Google |
| Claude | API key | Lista modelos mediante la API de Anthropic |
| OpenAI | API key | Admite la URL base predeterminada u otra compatible |
| Ollama | No requiere API key | URL local predeterminada: `http://localhost:11434` |

La disponibilidad, los límites, los costos y las políticas de datos dependen del proveedor y del modelo configurado.

## Privacidad y seguridad

QAPI no incluye telemetría propia, publicidad, cuentas de usuario ni un backend de recolección de datos.

| Información | Almacenamiento |
| --- | --- |
| API keys | `SecretStorage` de VS Code, protegido por el mecanismo seguro del sistema operativo |
| Proveedor, modelo, idioma, apariencia y MCP | `globalState` local de VS Code |
| Historial, memoria editable, memoria automática y checkpoints | `workspaceState` local, separado por workspace |
| Índice y perfil del proyecto | Procesados localmente por la extensión |

Al enviar un mensaje, QAPI transmite al proveedor configurado el prompt y el contexto de proyecto necesario para producir la respuesta. Ese tratamiento se rige por las políticas del proveedor elegido. Con Ollama, el procesamiento puede mantenerse local si la instalación y los modelos también son locales.

Los servidores MCP son procesos externos a QAPI. Revisa su código, permisos y política de datos antes de habilitarlos.

Nunca publiques archivos `.env`, credenciales, tokens ni un VSIX modificado que contenga secretos.

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
- **Webview (`dist/webview.js`):** interfaz del Agente, Configuración y Sobre Centyc.

Componentes principales:

| Archivo | Responsabilidad |
| --- | --- |
| `src/extension.ts` | Activación, vista lateral, comandos e índice del workspace |
| `src/panel.ts` | Coordinación entre webview, Store, agente y servicios |
| `src/agent.ts` | Prompts, modos Chat/Plan y orquestación de tools locales/MCP |
| `src/projectIndex.ts` | Índice léxico, hashes, mapa del repositorio y recuperación de contexto |
| `src/investigationMemory.ts` | Caché automática, relevancia, reutilización e invalidación de investigaciones |
| `src/projectProfile.ts` | Detección de stack, BDD y comandos del proyecto |
| `src/ideContext.ts` | Archivo activo, selección, Problems, Git, artefactos e impacto |
| `src/changes.ts` | Diffs, hunks, aplicación selectiva, hashes y checkpoints |
| `src/execution.ts` | Propuestas, validación y ejecución controlada de comandos |
| `src/mcp.ts` | Parseo y validación de configuración MCP |
| `src/mcpRuntime.ts` | Inicio efímero y llamadas a servidores MCP por `stdio` |
| `src/traceability.ts` | Trazabilidad estática y detección de gaps |
| `src/store.ts` | Preferencias globales, secretos y estado por workspace |
| `src/providers.ts` | Integraciones con Gemini, Claude, OpenAI y Ollama |
| `src/contextWindow.ts` | Estimación de uso y resumen de conversaciones extensas |
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
```

### Crear el VSIX

```bash
npx --yes @vscode/vsce package --allow-missing-repository
```

El archivo resultante se crea en la raíz del proyecto.

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
