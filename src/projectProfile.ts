// Detección del perfil del proyecto abierto.
//
// No se asume ningún stack: se deduce del contenido real del workspace
// (manifiestos de dependencias, extensiones de archivo, carpetas de pruebas).
// El resultado alimenta el prompt para que las reglas que se le dan a la IA
// correspondan a ESTE proyecto (BDD o no, Python o Java o TS, etc.).
import * as vscode from 'vscode'

export interface ProjectProfile {
  /** Lenguajes por volumen de archivos, de mayor a menor. */
  languages: string[]
  /** Frameworks de prueba detectados: pytest, behave, playwright, cypress… */
  testFrameworks: string[]
  /** Gestores/manifiestos: package.json, pyproject.toml, pom.xml… */
  manifests: string[]
  /** Comandos de prueba encontrados en los manifiestos. */
  testCommands: string[]
  /** Carpetas donde viven las pruebas. */
  testDirs: string[]
  /** true si el proyecto usa BDD (.feature + step definitions). */
  usesBdd: boolean
  /** Rutas de archivos de configuración relevantes. */
  configFiles: string[]
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', go: 'Go',
  php: 'PHP', feature: 'Gherkin', robot: 'Robot Framework',
}

const MANIFESTS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'go.mod', 'composer.json',
]

const CONFIG_HINTS = [
  'playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js',
  'cypress.json', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'behave.ini',
  'pytest.ini', 'tox.ini', 'setup.cfg', 'testng.xml', 'karate-config.js', 'wdio.conf.js',
  'codeception.yml', 'robot.yaml', '.mocharc.json', 'nightwatch.conf.js',
]

// Marcadores de framework: se buscan en manifiestos y nombres de archivo.
const FRAMEWORK_MARKERS: { name: string; patterns: RegExp[] }[] = [
  { name: 'Playwright', patterns: [/@playwright\/test|playwright/i] },
  { name: 'Cypress', patterns: [/\bcypress\b/i] },
  { name: 'Selenium', patterns: [/selenium|webdriver/i] },
  { name: 'Behave', patterns: [/\bbehave\b/i] },
  { name: 'pytest', patterns: [/\bpytest\b/i] },
  { name: 'unittest', patterns: [/\bunittest\b/i] },
  { name: 'Jest', patterns: [/\bjest\b/i] },
  { name: 'Vitest', patterns: [/\bvitest\b/i] },
  { name: 'Mocha', patterns: [/\bmocha\b/i] },
  { name: 'JUnit', patterns: [/junit/i] },
  { name: 'TestNG', patterns: [/testng/i] },
  { name: 'Cucumber', patterns: [/cucumber/i] },
  { name: 'Karate', patterns: [/\bkarate\b/i] },
  { name: 'Robot Framework', patterns: [/robotframework/i] },
  { name: 'WebdriverIO', patterns: [/webdriverio|@wdio/i] },
  { name: 'RestAssured', patterns: [/rest-assured|restassured/i] },
]

const TEST_DIR_RE = /(^|\/)(tests?|e2e|spec|specs|features|cypress|__tests__|src\/test)(\/|$)/i

/** Construye el perfil a partir de las rutas y los manifiestos del proyecto. */
export async function detectProfile(paths: string[]): Promise<ProjectProfile> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri

  // Lenguajes por volumen.
  const extCount = new Map<string, number>()
  for (const p of paths) {
    const ext = p.split('.').pop()?.toLowerCase()
    if (!ext) continue
    const lang = LANG_BY_EXT[ext]
    if (lang) extCount.set(lang, (extCount.get(lang) || 0) + 1)
  }
  const languages = [...extCount.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)

  // Manifiestos presentes y su contenido (para frameworks y comandos).
  const manifests: string[] = []
  const testCommands: string[] = []
  let manifestText = ''
  for (const name of MANIFESTS) {
    // El más cercano a la raíz: antes podía elegirse examples/x/package.json.
    const hit = shallowest(paths.filter((p) => matchesManifest(p, name)))
    if (!hit || !root) continue
    manifests.push(hit)
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, hit))
      const text = Buffer.from(bytes).toString('utf8')
      manifestText += `\n${text}`
      collectTestCommands(hit, text, testCommands)
    } catch { /* ilegible */ }
  }

  const configFiles = CONFIG_HINTS
    .map((c) => shallowest(paths.filter((p) => p === c || p.endsWith(`/${c}`))))
    .filter((p): p is string => Boolean(p))
  // Configuraciones de runner sin manifiesto que las declare (p. ej. sólo behave.ini).
  if (configFiles.some((file) => /(?:^|\/)behave\.ini$/.test(file))) testCommands.push('behave')
  if (configFiles.some((file) => /(?:^|\/)pytest\.ini$/.test(file))) testCommands.push('pytest')

  // Frameworks: por manifiesto, por config y por extensiones presentes. Las
  // carpetas de reportes no cuentan (playwright-report no implica Playwright).
  const sourcePaths = paths.filter((p) => !/(?:^|\/)(?:playwright-report|test-results|allure-[\w-]+|coverage)(?:\/|$)/.test(p))
  const haystack = `${manifestText}\n${configFiles.join('\n')}\n${sourcePaths.slice(0, 800).join('\n')}`
  const testFrameworks = FRAMEWORK_MARKERS
    .filter((f) => f.patterns.some((re) => re.test(haystack)))
    .map((f) => f.name)

  const testDirs = [...new Set(
    paths
      .filter((p) => TEST_DIR_RE.test(p))
      .map((p) => p.split('/').slice(0, -1).join('/'))
      .filter(Boolean),
  )].slice(0, 20)

  const hasFeatures = paths.some((p) => p.endsWith('.feature'))
  const usesBdd = hasFeatures

  return { languages, testFrameworks, manifests, testCommands: [...new Set(testCommands)], testDirs, usesBdd, configFiles }
}

function matchesManifest(path: string, name: string): boolean {
  if (name === 'requirements.txt') return /(?:^|\/)requirements[\w.-]*\.txt$/.test(path)
  return path === name || path.endsWith(`/${name}`)
}

function shallowest(paths: string[]): string | undefined {
  return [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
}

/** Extrae comandos de prueba declarados en el manifiesto. */
function collectTestCommands(file: string, text: string, out: string[]) {
  if (file.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(text)
      for (const [name, cmd] of Object.entries<any>(pkg.scripts || {})) {
        if (/test|e2e|cypress|playwright|spec|lint|typecheck|check/i.test(name)) out.push(`npm run ${name}  →  ${cmd}`)
      }
    } catch { /* json inválido */ }
  }
  if (file.endsWith('pom.xml')) out.push('mvn test')
  if (/build\.gradle/.test(file)) out.push('gradle test')
  if (/(?:pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|setup\.py)$/.test(file)) {
    if (/behave/i.test(text)) out.push('behave')
    if (/pytest/i.test(text)) out.push('pytest')
  }
}

/** Resumen legible del perfil para inyectar en el prompt. */
export function describeProfile(p: ProjectProfile): string {
  const lines: string[] = []
  if (p.languages.length) lines.push(`Lenguajes: ${p.languages.join(', ')}`)
  if (p.testFrameworks.length) lines.push(`Frameworks de prueba: ${p.testFrameworks.join(', ')}`)
  else lines.push('Frameworks de prueba: no detectados')
  if (p.manifests.length) lines.push(`Manifiestos: ${p.manifests.join(', ')}`)
  if (p.configFiles.length) lines.push(`Configuración: ${p.configFiles.join(', ')}`)
  if (p.testCommands.length) lines.push(`Comandos de prueba: ${p.testCommands.join(' | ')}`)
  if (p.testDirs.length) lines.push(`Carpetas de pruebas: ${p.testDirs.slice(0, 10).join(', ')}`)
  lines.push(`Estilo de pruebas: ${p.usesBdd ? 'BDD (Gherkin .feature + step definitions)' : 'pruebas en código (sin Gherkin)'}`)
  return lines.join('\n')
}
