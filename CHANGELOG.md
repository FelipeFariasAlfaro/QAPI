# Changelog

Todos los cambios relevantes de QAPI se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto sigue [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

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

[Unreleased]: https://github.com/FelipeFariasAlfaro/QAPI/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/FelipeFariasAlfaro/QAPI/releases/tag/v1.0.0
