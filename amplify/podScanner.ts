import { CfnFunction, Function as LambdaFunction, LayerVersion, Code } from 'aws-cdk-lib/aws-lambda'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { POD_SCAN_VERSION } from './functions/pod-actions/scan-version.js'

/** Directory used by `configurePodScanner` to stage the Lambda layer asset. */
const LAYER_ASSET_DIR = '.amplify/layers/pod-scan'

function resolveModuleDir(pkg: string): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve(join(pkg, 'package.json')))
}

/**
 * Build a deterministic Lambda layer containing Tesseract traineddata and
 * the core tesseract.js / tesseract.js-core packages so the Lambda never needs
 * to fetch assets from a CDN at runtime.
 */
function buildPodScanLayerAsset(): string {
  const baseDir = dirname(fileURLToPath(import.meta.url))
  const outDir = join(baseDir, LAYER_ASSET_DIR, 'dist')

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }

  const nodeModules = join(outDir, 'nodejs', 'node_modules')
  mkdirSync(nodeModules, { recursive: true })

  // tesseract.js spawns a worker thread from a file path, so the worker and
  // everything it requires at runtime must exist as real files on the layer;
  // the Lambda bundle only covers the main module graph.
  for (const pkg of [
    '@tesseract.js-data/eng',
    'tesseract.js',
    'tesseract.js-core',
    'wasm-feature-detect',
    'bmp-js',
    'idb-keyval',
    'is-url',
    'node-fetch',
    'regenerator-runtime',
    'zlibjs',
  ]) {
    cpSync(resolveModuleDir(pkg), join(nodeModules, pkg), { recursive: true })
  }

  return outDir
}

/**
 * Wire backing resources/configuration for the POD document scanner.
 * Called from amplify/backend.ts with the pod-actions Lambda function.
 *
 * - Adds a Lambda Layer with Tesseract traineddata + worker/WASM assets.
 * - Increases timeout/memory for geometry/OCR work.
 * - Exposes runtime paths via environment variables.
 */
export function configurePodScanner(fn: LambdaFunction): void {
  const layerDir = buildPodScanLayerAsset()

  const layer = new LayerVersion(fn.stack, 'PodScanLayer', {
    code: Code.fromAsset(layerDir),
    layerVersionName: 'pod-scan',
    description: 'Tesseract traineddata and tesseract.js worker/core assets for POD scanning',
    // Pure JS/WASM + data: valid for whichever Node runtime Amplify assigns.
    compatibleRuntimes: [fn.runtime],
  })
  fn.addLayers(layer)

  // CloudFormation Timeout/MemorySize expect integer seconds/MB.
  const cfn = fn.node.defaultChild as CfnFunction
  cfn.addPropertyOverride('Timeout', 180)
  cfn.addPropertyOverride('MemorySize', 2048)

  fn.addEnvironment('POD_SCAN_VERSION', String(POD_SCAN_VERSION))
  fn.addEnvironment('POD_SCAN_ENG_PATH', '/opt/nodejs/node_modules/@tesseract.js-data/eng/4.0.0')
  // The Node worker entry; the browser worker.min.js does not run under Node.
  fn.addEnvironment('POD_SCAN_WORKER_PATH', '/opt/nodejs/node_modules/tesseract.js/src/worker-script/node/index.js')
  fn.addEnvironment('POD_SCAN_CORE_PATH', '/opt/nodejs/node_modules/tesseract.js-core')
  fn.addEnvironment('POD_SCAN_CACHE_PATH', '/tmp/tesseract-cache')
}
