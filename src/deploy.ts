import * as core from '@actions/core'
import * as github from '@actions/github'
import * as actionExec from '@actions/exec'
import * as fs from 'fs'
import * as assert from 'assert'
import * as path from 'path'
import * as YAML from 'yaml'
import tmp from 'tmp'
import { default as Mustache } from 'mustache'
import {
  parseConfig,
  HelmDeployConfig,
  getRepoConfig,
  MissingConfigError
} from './config'
import { pathExists } from './utils'
import { helmExec } from './exec'
import { replaceURLProtocol } from './url'

tmp.setGracefulCleanup()

/**
 * Mark the github deployment status if an github token was provided
 */
export async function status(
  state:
    | 'inactive'
    | 'error'
    | 'pending'
    | 'success'
    | 'queued'
    | 'in_progress'
    | 'failure'
): Promise<void> {
  try {
    const context = github.context
    const deployment = context.payload.deployment
    const token = core.getInput('github-token')
    if (!token || !deployment) {
      return
    }

    const client = github.getOctokit(token)
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}/checks`

    await client.rest.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: deployment.id,
      state,
      log_url: url,
      target_url: url
    })
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.warning(`failed to set deployment status: ${error.message}`)
    } else {
      core.warning('failed to set deployment status')
    }
  }
}

/**
 * Render files renders user provided values into the list of provided files
 * using the mustache template engine
 */
async function renderFiles(
  files: string[],
  data: { secrets: object | string; deployment: string[] }
): Promise<void> {
  const tags: [string, string] = ['${{', '}}']
  const promises = files.map(async (file: string) => {
    const content = await fs.promises.readFile(file, { encoding: 'utf8' })
    const rendered = Mustache.render(content, data, {}, tags)
    await fs.promises.writeFile(file, rendered, { mode: 0o777 })
  })
  Promise.all(promises)
}

function is_defined(v?: string): boolean {
  return v !== undefined && v !== null && v.trim() !== ''
}

export interface HelmRepoConfig {
  name?: string
  url?: string
  username?: string
  password?: string
  caFile?: string
  certFile?: string
  insecure_skip_tls_verify?: boolean
  keyFile?: string
  pass_credentials_all?: boolean
}

function buildRepositoryConfigYaml(conf: HelmDeployConfig): string {
  // apiVersion: ""
  // generated: "0001-01-01T00:00:00Z"
  // repositories:
  // - name: fantastic-charts
  //   url: https://fantastic-charts.storage.googleapis.com
  //   username: env.FANTASTIC_CHARTS_USERNAME
  //   password: env.FANTASTIC_CHARTS_PASSWORD
  //   caFile: ""
  //   certFile: ""
  //   insecure_skip_tls_verify: false
  //   keyFile: ""
  //   pass_credentials_all: false

  const repo = getRepoConfig(conf)

  let repositories: HelmRepoConfig[] = []
  if (conf.dependencies) {
    repositories = [
      ...repositories,
      ...conf.dependencies
        .filter(d => is_defined(d.url))
        .map(d => {
          let repoURL = new URL(d.url ?? '')
          if (conf.useOCI) {
            repoURL = replaceURLProtocol(repoURL, 'oci:')
          }
          return { ...d, url: repoURL.toString(), pass_credentials_all: true }
        })
    ]
  }

  if (repo.url) {
    let repoURL = new URL(repo.url ?? '')
    if (conf.useOCI) {
      repoURL = replaceURLProtocol(repoURL, 'oci:')
    }

    repositories = [
      ...repositories,
      { ...repo, url: repoURL.toString(), pass_credentials_all: true }
    ]
  }

  return YAML.stringify({
    apiVersion: '',
    repositories
  })
}

export interface AuthConfig {
  Username?: string
  Password?: string
  Auth?: string
  Email?: string
  ServerAddress?: string
  IdentityToken?: string
  RegistryToken?: string
}

function buildRegistryConfigJSON(conf: HelmDeployConfig): string {
  // {"auths": {
  //    "https://my.registry": {},
  // }}
  // see https://github.com/docker/cli/blob/master/cli/config/types/authconfig.go

  const repo = getRepoConfig(conf)

  const auths: { [key: string]: AuthConfig } = {}
  if (repo.url) {
    auths[repo.url] = {
      // Auth: btoa(`${repo.username}:${repo.password}`),
      Username: repo.username,
      Password: repo.password
    }
  }
  return JSON.stringify({ auths })
}

interface HelmConfigFiles {
  repositoryConfigFile: tmp.FileResult
  registryConfigFile: tmp.FileResult
}

async function buildHelmConfigFiles(
  conf: HelmDeployConfig
): Promise<HelmConfigFiles> {
  if (is_defined(conf.repoUsername) && !is_defined(conf.repoPassword)) {
    throw new Error('supplied repo-username but missing repo-password')
  }
  if (is_defined(conf.repoPassword) && !is_defined(conf.repoUsername)) {
    throw new Error('supplied repo-password but missing repo-username')
  }

  const registryConfigJSON = buildRegistryConfigJSON(conf)
  const registryConfigFile = tmp.fileSync({
    postfix: 'registries.json'
  })
  await fs.promises.writeFile(registryConfigFile.name, registryConfigJSON, {
    mode: 0o777
  })

  const repositoryConfigYAML = buildRepositoryConfigYaml(conf)
  const repositoryConfigFile = tmp.fileSync({ postfix: 'repositories.yaml' })
  await fs.promises.writeFile(repositoryConfigFile.name, repositoryConfigYAML, {
    mode: 0o777
  })

  return { repositoryConfigFile, registryConfigFile }
}

/**
 * Deploy or remove a helm chart
 */
async function deployHelmChart(conf: HelmDeployConfig): Promise<void> {
  const context = github.context
  await status('pending')

  if (!conf.command) throw new MissingConfigError('command')

  const configs = await buildHelmConfigFiles(conf)
  const kubeconfigFile = tmp.fileSync({ postfix: 'kubeconfig.yml' })

  try {
    // print out the helm version for reproductions
    await helmExec(['version'])

    if (is_defined(conf.repo) || (conf.dependencies ?? []).length > 0) {
      await helmExec([
        'repo',
        'update',
        '--registry-config',
        configs.registryConfigFile.name,
        '--repository-config',
        configs.repositoryConfigFile.name
      ])
    }

    // prepare values override file
    const valuesFile = path.join(
      process.env.DEPLOY_ACTION_DATA_HOME ?? '.',
      'values.yml'
    )
    if (conf.values && conf.values.length > 0)
      await fs.promises.writeFile(valuesFile, conf.values, { mode: 0o777 })

    if (conf.kubeconfigInline) {
      await fs.promises.writeFile(kubeconfigFile.name, conf.kubeconfigInline, {
        mode: 0o777
      })
      conf.kubeconfigPath = kubeconfigFile.name
    }

    // render value files using github variables
    if (conf.valueFiles)
      await renderFiles(conf.valueFiles.concat([valuesFile]), {
        secrets: conf.secrets ?? {},
        deployment: context.payload.deployment
      })

    switch (conf.command) {
      case 'delete':
        await helmDelete(conf)
        break
      case 'push':
        await helmPush(conf, configs)
        break
      case 'upgrade':
        await helmUpgrade(conf, configs, valuesFile)
        break
      default:
        throw new Error(`unkown helm command: ${conf.command}`)
    }
  } catch (err: unknown) {
    configs.repositoryConfigFile.removeCallback()
    configs.registryConfigFile.removeCallback()
    kubeconfigFile.removeCallback()
    throw err
  }
}

/**
 * Push a helm chart to a helm repository
 */
async function helmPush(
  conf: HelmDeployConfig,
  configs: HelmConfigFiles
): Promise<void> {
  if (!conf.chart) throw new MissingConfigError('chart')
  if (!(await pathExists(conf.chart)))
    throw new Error(`${conf.chart} does not exist`)

  // chart metadata should have been loaded from the chart path

  // push only makes sense for local charts
  assert.ok(conf.chartMetadata, 'have chart metadata from Chart.yaml')

  const chartName = conf.chartMetadata.name
  const chartVersion = conf.chartMetadata.version
  assert.ok(chartName, 'have chart name from Chart.yaml')
  assert.ok(chartVersion, 'have chart version from Chart.yaml')

  if (!conf.repo) throw new MissingConfigError('repo')

  await helmExec(['inspect', 'chart', conf.chart])

  await helmExec([
    'dependency',
    'update',
    conf.chart,
    '--registry-config',
    configs.registryConfigFile.name,
    '--repository-config',
    configs.repositoryConfigFile.name
  ])

  let args: string[] = []
  if (conf.chartVersion) args = [...args, '--version', conf.chartVersion]
  if (conf.appVersion) args = [...args, '--app-version', conf.appVersion]

  let options: actionExec.ExecOptions = {}
  if (await pathExists(conf.chart)) {
    options = { ...options, cwd: conf.chart }
  }
  await helmExec(['package', ...args, conf.chart], options)

  // find built package
  let packaged = `${conf.chart}/${chartName}`
  if (conf.chartVersion) {
    packaged += `-${conf.chartVersion}.tgz`
  } else {
    packaged += `-${chartVersion}.tgz`
  }

  if (!(await pathExists(packaged))) {
    throw new Error(`Could not find packaged chart.Expected ${packaged}`)
  }

  let repoURL = new URL(conf.repo)
  if (conf.useOCI) {
    repoURL = replaceURLProtocol(repoURL, 'oci:')
  }

  await helmExec(
    [
      'push',
      packaged,
      repoURL.toString(),
      '--registry-config',
      configs.registryConfigFile.name,
      '--repository-config',
      configs.repositoryConfigFile.name
    ],
    options
  )
}

/**
 * Remove a helm deployment
 */
async function helmDelete(conf: HelmDeployConfig): Promise<void> {
  if (!conf.release) throw new MissingConfigError('release')
  if (!conf.namespace) conf.namespace = 'default'
  let args: string[] = []
  if (conf.kubeconfigPath) {
    args = [...args, '--kubeconfig', conf.kubeconfigPath]
  }
  await helmExec(['delete', '-n', conf.namespace, ...args, conf.release])
  await status('inactive')
}

/**
 * Upgrade a helm deployment
 */
async function helmUpgrade(
  conf: HelmDeployConfig,
  configs: HelmConfigFiles,
  valuesFile: string
): Promise<void> {
  if (!conf.release) throw new MissingConfigError('release')
  if (!conf.chart) throw new MissingConfigError('chart')

  let args: string[] = []
  if (conf.namespace) {
    args = [...args, '-n', conf.namespace]
  }
  if (conf.kubeconfigPath) {
    args = [...args, '--kubeconfig', conf.kubeconfigPath]
  }
  if (conf.dry) args = [...args, '--dry-run']
  if (conf.chartVersion) args = [...args, '--version', conf.chartVersion]
  if (conf.timeout) args = [...args, '--timeout', conf.timeout]
  if (conf.atomic) args = [...args, '--atomic']
  if (conf.valueFiles)
    for (const f of conf.valueFiles) {
      args = [...args, '--values', f]
    }
  if (conf.values && conf.values.length > 0)
    args = [...args, '--values', valuesFile]

  await helmExec([
    'upgrade',
    conf.release,
    conf.chart,
    '--install',
    '--wait',
    '--registry-config',
    configs.registryConfigFile.name,
    '--repository-config',
    configs.repositoryConfigFile.name,
    ...args
  ])
  await status('success')
}

/**
 * Parse the action's config and start the deployment
 */
export async function run(): Promise<void> {
  const conf = await parseConfig()

  await deployHelmChart(conf)
}
