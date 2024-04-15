import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import * as YAML from 'yaml'
import { resolvePath, pathExists } from './utils'

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

/**
 * Parse actions input values
 */
function parseInput(name: string, required = false): string {
  return core.getInput(name, { required })
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

  // upgrade
  values?: string
  dry?: boolean
  atomic?: boolean
  valueFiles?: string[]
  secrets?: string | object

  // upgrade and push
  chartPath?: string
  chartMetadata?: HelmChart
  chartVersion?: string
  repo?: string
  repoAlias?: string
  repoUsername?: string
  repoPassword?: string
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
  let chartPath = parseInput('chart', isUpgrade || isPush)

  if (chartPath) {
    chartPath = await resolvePath(chartPath)

    // check if chart path exists
    if (!pathExists(chartPath)) {
      throw new Error(`${chartPath} does not exist`)
    }
    // try {
    //   await fs.promises.stat(chartPath)
    // } catch (err: unknown) {
    //   if (isFsError(err) && err.code === 'ENOENT') {
    //     throw new Error(`chart ${chartPath} does not exist`)
    //   } else {
    //     throw new Error(`failed to check if ${chartPath} exists`)
    //   }
    // }

    if (path.basename(chartPath) === 'Chart.yaml') {
      chartPath = path.dirname(chartPath)
    }

    // check if chart path is directory
    const stat = await fs.promises.stat(chartPath)
    if (!stat.isDirectory()) {
      throw new Error(`${chartPath} is not a directory`)
    }

    // check if Chart.yaml exists
    const chartYAMLPath = path.join(chartPath, 'Chart.yaml')
    if (!pathExists(chartYAMLPath)) {
      throw new Error(`${chartYAMLPath} does not exist`)
    }

    // get chart name
    const chartYAMLContent = await fs.promises.readFile(chartYAMLPath, 'utf8')
    chartMetadata = YAML.parse(chartYAMLContent)
  }

  const conf = {
    command,

    // remove and upgrade
    release: parseInput('release', isRemove || isUpgrade),
    namespace: parseInput('namespace'),
    timeout: parseInput('timeout'),

    // upgrade
    values: parseValues(parseInput('values')),
    dry: parseInput('dry-run') === 'true',
    atomic: parseInput('atomic') === 'true',
    valueFiles: parseValueFiles(parseInput('value-files')),
    secrets: parseSecrets(parseInput('secrets')),

    // upgrade and push
    chartPath,
    chartMetadata,
    chartVersion: parseInput('chart-version'),
    repo: parseInput('repo', isPush),
    repoAlias: parseInput('repo-alias'),
    repoUsername: parseInput('repo-username'),
    repoPassword: parseInput('repo-password'),
    dependencies: parseDependencies(parseInput('dependencies')),
    appVersion: parseInput('app-version'),
    force: parseInput('force') === 'true'
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
