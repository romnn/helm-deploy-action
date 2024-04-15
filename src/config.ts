import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import * as YAML from 'yaml'
import { resolvePath, pathExists } from './utils'
import { isValidHttpURL } from './url'

function parseDependencies(
  deps: object | string | null | undefined
): HelmRepo[] {
  let depsObj: object | null = null
  if (typeof deps === 'string' && deps.length > 0) {
    try {
      depsObj = JSON.parse(deps)
    } catch (err) {
      throw new Error('dependencies must be a valid YAML or JSON array')
    }
  } else if (typeof deps === 'object') {
    depsObj = deps
  } else if (Array.isArray(deps)) {
    return deps
  }
  if (!depsObj) {
    return []
  }
  if (Array.isArray(depsObj)) {
    return depsObj
  }
  return [depsObj]
}

function parseValueFiles(files: string | string[]): string[] {
  let fileList
  if (typeof files === 'string') {
    try {
      fileList = JSON.parse(files)
    } catch (err) {
      fileList = [files]
    }
  } else {
    fileList = files
  }
  if (!Array.isArray(fileList)) {
    return []
  }
  return fileList.filter(f => !!f)
}

export class MissingConfigError extends Error {
  constructor(key: keyof ActionConfig) {
    super(`required and not supplied: ${key}`)
  }
}

export const DEFAULT_CONF: ActionConfig = {
  namespace: 'default',
  'use-oci': true,
  force: false,
  'dry-run': false,
  atomic: true
}

export function isActionConfigKey(
  key: string,
  obj: ActionConfig
): key is keyof ActionConfig {
  return key in obj
}

function parseInput(name: string, required = false): string {
  if (isActionConfigKey(name, DEFAULT_CONF)) {
    // this is a hack for local testing
    if (core.getInput(name) === '') {
      const defaultValue = DEFAULT_CONF[name]
      if (defaultValue !== undefined) {
        return defaultValue.toString()
      }
    }
  }
  return core.getInput(name, { required })
}

function parseBooleanInput(name: string, required = false): boolean {
  const trueValues = ['true', 'yes']
  const falseValues = ['false', 'no']
  const val = parseInput(name, required)
  if (trueValues.includes(val.toLowerCase())) return true
  if (falseValues.includes(val.toLowerCase())) return false
  throw new TypeError(
    `Boolean input "${name}" must be one of: ${[...trueValues, ...falseValues]}`
  )
}

function parseValues(values: object | string | null | undefined): string {
  if (!values) {
    return '{}'
  }
  if (typeof values === 'object') {
    return JSON.stringify(values)
  }
  return values
}

function parseSecrets(secrets: string | object): string | object {
  if (typeof secrets === 'string') {
    try {
      return JSON.parse(secrets)
    } catch (err) {
      return secrets
    }
  }
  return secrets
}

/**
 * Action input config
 */
export type ActionConfig = {
  command?: string
  namespace?: string
  'kubeconfig-path'?: string
  'kubeconfig-inline'?: string
  release?: string
  chart?: string
  atomic?: boolean
  'dry-run'?: boolean
  'chart-version'?: string
  'app-version'?: string
  repo?: string
  'repo-alias'?: string
  'repo-username'?: string
  'repo-password'?: string
  'use-oci'?: boolean
  values?: string
  'value-files'?: string
  dependencies?: string
  timeout?: string
  force?: boolean
}

/**
 * Helm repo configuration
 */
export interface HelmRepo {
  url?: string
  alias?: string
  username?: string
  password?: string
}

/**
 * Helm chart configuration
 */
export interface HelmChart {
  apiVersion: string
  name: string
  version: string
  kubeVersion?: string
  description?: string
  keywords?: string[]
  home?: string
  sources?: string[]
  dependencies?: {
    name: string
    version: string
    repository?: string
    condition?: string
    tags?: string[]
    'import-values'?: string[]
    alias?: string
  }[]
  maintainers?: {
    name: string
    email?: string
    url?: string
  }[]
  icon?: string
  appVersion?: string
  deprecated?: boolean
  annotations?: { [key: string]: string }
}

/**
 * Helm deployment configuration
 */
export interface HelmDeployConfig {
  command: string

  // remove and upgrade
  release?: string
  namespace?: string
  timeout?: string
  kubeconfigPath?: string
  kubeconfigInline?: string

  // upgrade
  values?: string
  dry?: boolean
  atomic?: boolean
  valueFiles?: string[]
  secrets?: string | object

  // upgrade and push
  chart?: string
  chartMetadata?: HelmChart
  chartVersion?: string
  repo?: string
  repoAlias?: string
  repoUsername?: string
  repoPassword?: string
  useOCI?: boolean
  dependencies?: HelmRepo[]
  appVersion?: string
  force?: boolean
}

export function getRepoConfig(conf: HelmDeployConfig): HelmRepo {
  return {
    url: conf.repo,
    alias: conf.repoAlias,
    username: conf.repoUsername,
    password: conf.repoPassword
  }
}

/**
 * Parse the action's entire config
 */
export async function parseConfig(): Promise<HelmDeployConfig> {
  const command = parseInput('command').toLowerCase()

  const isPush = command === 'push'
  const isUpgrade = command === 'upgrade'
  const isRemove = command === 'remove'

  let chartMetadata: HelmChart | undefined
  let chart = parseInput('chart', isUpgrade || isPush)

  if (chart) {
    // check if chart is repo/chart
    const validRelativeRepoChart =
      path.extname(chart) === '' &&
      chart.split(path.sep).length == 2 &&
      chart.indexOf('~') == -1 &&
      chart.indexOf('.') == -1

    // check if chart is full absolute url
    const validAbsoluteRepoChart = isValidHttpURL(chart)
    const validRepoChart = validRelativeRepoChart || validAbsoluteRepoChart

    let localChartPath = false
    try {
      // check if chart path exists
      if (await pathExists(await resolvePath(chart))) {
        chart = await resolvePath(chart)
        localChartPath = true
      } else {
        throw new Error(
          `${chart} does not exist and is not in the form <chartname> or <repo/chartname>`
        )
      }
    } catch (err) {
      if (!validRepoChart) throw err
    }

    // const isPathToChart =
    //   (path.extname(chart) !== '' && chart.split(path.sep).length > 2) ||
    //   chart.indexOf('~') != -1 ||
    //   chart.indexOf('.') != -1 ||
    //   pathExists(chart)

    if (localChartPath) {
      // chart = await resolvePath(chart)
      //
      // // check if chart path exists
      // if (!pathExists(chart)) {
      //   throw new Error(`${chart} does not exist`)
      // }
      // try {
      //   await fs.promises.stat(chartPath)
      // } catch (err: unknown) {
      //   if (isFsError(err) && err.code === 'ENOENT') {
      //     throw new Error(`chart ${chartPath} does not exist`)
      //   } else {
      //     throw new Error(`failed to check if ${chartPath} exists`)
      //   }
      // }

      if (path.basename(chart) === 'Chart.yaml') {
        chart = path.dirname(chart)
      }

      // check if chart path is directory
      const stat = await fs.promises.stat(chart)
      if (!stat.isDirectory()) {
        throw new Error(`${chart} is not a directory`)
      }

      // check if Chart.yaml exists
      const chartYAMLPath = path.join(chart, 'Chart.yaml')
      if (!pathExists(chartYAMLPath)) {
        throw new Error(`${chartYAMLPath} does not exist`)
      }

      // get chart name
      const chartYAMLContent = await fs.promises.readFile(chartYAMLPath, 'utf8')
      chartMetadata = YAML.parse(chartYAMLContent)
    }
  }

  const conf: HelmDeployConfig = {
    command,

    // remove and upgrade
    release: parseInput('release', isRemove || isUpgrade),
    namespace: parseInput('namespace'),
    kubeconfigPath: parseInput('kubeconfig-path'),
    kubeconfigInline: parseInput('kubeconfig-inline'),
    timeout: parseInput('timeout'),

    // upgrade
    values: parseValues(parseInput('values')),
    dry: parseBooleanInput('dry-run'),
    atomic: parseBooleanInput('atomic'),
    valueFiles: parseValueFiles(parseInput('value-files')),
    secrets: parseSecrets(parseInput('secrets')),

    // upgrade and push
    chart,
    chartMetadata,
    chartVersion: parseInput('chart-version'),
    repo: parseInput('repo', isPush),
    repoAlias: parseInput('repo-alias'),
    repoUsername: parseInput('repo-username'),
    repoPassword: parseInput('repo-password'),
    useOCI: parseBooleanInput('use-oci'),
    dependencies: parseDependencies(parseInput('dependencies')),
    appVersion: parseInput('app-version'),
    force: parseBooleanInput('force')
  }

  if (!conf.repoAlias) conf.repoAlias = 'source-chart-repo'

  // normalize chart versions
  // function normalizeVersion(version: string): string {
  //   return version.startsWith('v') ? version : `v${version}`
  // }
  // if (conf.chartMetadata?.version) {
  //   conf.chartMetadata.version = normalizeVersion(conf.chartMetadata.version)
  // }
  // if (conf.chartVersion) {
  //   conf.chartVersion = normalizeVersion(conf.chartVersion)
  // }

  return conf
}
