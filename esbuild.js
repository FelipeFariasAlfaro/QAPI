// Build de la extensión (Node/CommonJS) y del bundle del webview (navegador/IIFE).
const esbuild = require('esbuild')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/webview.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig)
    const ctxWeb = await esbuild.context(webviewConfig)
    await Promise.all([ctxExt.watch(), ctxWeb.watch()])
    console.log('[watch] build inicial listo')
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)])
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
