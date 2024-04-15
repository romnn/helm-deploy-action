import * as core from '@actions/core'
import * as github from '@actions/github'
import * as actionExec from '@actions/exec'
import * as fs from 'fs'
import * as assert from 'assert'
import * as path from 'path'
import * as YAML from 'yaml'
import { glob } from 'glob'
import tmp from 'tmp'
import { default as Mustache } from 'mustache'
import {
  parseConfig,
  HelmRepo,
  HelmDeployConfig,
  getRepoConfig
} from './config'
import { helmExec } from './exec'
import { replaceURLProtocol } from './url'

tmp.setGracefulCleanup()

async function authenticateHelm(conf: HelmDeployConfig): Promise<void> {
  const repo = getRepoConfig(conf)
  try {
    await addHelmRepo(repo)
    await helmExec(['repo', 'update'])
  } catch (err) {
    await loginHelmRegistry(repo)
  }
}

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

function buildRepositoryConfigYaml(repo: HelmRepo): string {
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

  interface HelmRepoConfig {
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

  const repositories: {
    apiVersion: string
    generated?: string
    repositories: HelmRepoConfig[]
  } = {
    apiVersion: '',
    repositories: [
      {
        name: repo.alias,
        url: repo.url,
        username: repo.username,
        password: repo.password
      }
    ]
  }
  return YAML.stringify(repositories)
}

function buildRegistryConfigJSON(repo: HelmRepo): string {
  // {"auths": {
  //    "https://my.registry": {},
  // }}
  // see https://github.com/docker/cli/blob/master/cli/config/types/authconfig.go
  interface AuthConfig {
    Username?: string
    Password?: string
    Auth?: string
    Email?: string
    ServerAddress?: string
    IdentityToken?: string
    RegistryToken?: string
  }
  const auths: { [key: string]: AuthConfig } = {}
  if (repo.url) {
    auths[repo.url] = {
      // Auth: btoa(`${repo.username}: ${repo.password}`),
      Username: repo.username,
      Password: repo.password
    }
  }
  return JSON.stringify({ auths })
}

async function loginHelmRegistry(repo: HelmRepo): Promise<void> {
  if (!repo.url)
    throw new Error('required and not supplied: repo / dependency repository')
  if (is_defined(repo.username) && !is_defined(repo.password)) {
    throw new Error('supplied repo-username but missing repo-password')
  }
  if (is_defined(repo.password) && !is_defined(repo.username)) {
    throw new Error('supplied repo-password but missing repo-username')
  }

  let options: actionExec.ExecOptions = {}
  const args: string[] = []
  if (repo.username) {
    args.push(`--username='${repo.username}'`)
  }
  if (repo.password) {
    options = { ...options, input: Buffer.from(repo.password) }
    args.push('--password-stdin')
  }

  await helmExec(['registry', 'login', ...args, repo.url], options)
}

// Note: helm repos often only exist once they contain at least a single chart
// Hence, if adding the repo fails, try logging into the registry instead
async function addHelmRepo(repo: HelmRepo): Promise<void> {
  if (!repo.url)
    throw new Error('required and not supplied: repo / dependency repository')
  if (!repo.alias)
    throw new Error('required and not supplied: repo-alias / dependency alias')
  if (is_defined(repo.username) && !is_defined(repo.password)) {
    throw new Error('supplied repo-username but missing repo-password')
  }
  if (is_defined(repo.password) && !is_defined(repo.username)) {
    throw new Error('supplied repo-password but missing repo-username')
  }

  let options: actionExec.ExecOptions = {}
  const args: string[] = []
  if (repo.username) {
    args.push(`--username='${repo.username}'`)
  }
  if (repo.password) {
    options = { ...options, input: Buffer.from(repo.password) }
    args.push('--password-stdin')
  }
  await helmExec(['repo', 'add', ...args, repo.alias, repo.url], options)
}

/**
 * Deploy or remove a helm chart
 */
async function deployHelmChart(conf: HelmDeployConfig): Promise<void> {
  const context = github.context
  await status('pending')

  if (!conf.command) throw new Error('required and not supplied: command')

  // add the helm repository
  if (conf.repo) {
    // await authenticateHelm(conf)
  }

  // add dependency repositories
  if (conf.dependencies && conf.dependencies.length > 0) {
    for (const dep of conf.dependencies) {
      await addHelmRepo(dep)
    }
    await helmExec(['repo', 'update'])
  }

  // prepare values override file
  const valuesFile = path.join(
    process.env.DEPLOY_ACTION_DATA_HOME ?? '.',
    'values.yml'
  )
  if (conf.values && conf.values.length > 0)
    await fs.promises.writeFile(valuesFile, conf.values, { mode: 0o777 })

  // prepare kubeconfig file
  // if (process.env.KUBECONFIG_FILE) {
  //   process.env.KUBECONFIG = path.join(
  //     process.env.DEPLOY_ACTION_DATA_HOME ?? '.',
  //     'kubeconfig.yml'
  //   )
  //   await fs.promises.writeFile(
  //     process.env.KUBECONFIG,
  //     process.env.KUBECONFIG_FILE,
  //     { mode: 0o777 }
  //   )
  // }

  // render value files using github variables
  if (conf.valueFiles)
    await renderFiles(conf.valueFiles.concat([valuesFile]), {
      secrets: conf.secrets ?? {},
      deployment: context.payload.deployment
    })

  switch (conf.command) {
    case 'remove':
      await helmRemove(conf)
      break
    case 'push':
      await helmPush(conf)
      break
    case 'upgrade':
      await helmUpgrade(conf, valuesFile)
      break
    default:
      throw new Error(`unkown helm command: ${conf.command}`)
  }
}

/**
 * Push a helm chart to a helm repository
 */
async function helmPush(conf: HelmDeployConfig): Promise<void> {
  if (!conf.chartPath) throw new Error('required and not supplied: chart')
  const chartName = conf.chartMetadata?.name
  // chart name should have been derived from the chart path
  assert.ok(chartName)

  if (!conf.repo) throw new Error('required and not supplied: repo')
  if (!conf.repoUsername)
    throw new Error('required and not supplied: repo-username')
  if (!conf.repoPassword)
    throw new Error('required and not supplied: repo-password')

  // console.log(path.join(conf.chartDir ?? '.', conf.chart))
  // console.log(conf.chartPath)
  // const chartPath = await resolve(path.join(conf.chartDir ?? '.', conf.chart))
  await helmExec(['inspect', 'chart', conf.chartPath])

  await helmExec(['dependency', 'update', conf.chartPath])

  let args: string[] = []
  if (conf.chartVersion) args.push(`--version=${conf.chartVersion}`)
  if (conf.appVersion) args.push(`--app-version=${conf.appVersion}`)
  await helmExec(['package', ...args, conf.chartPath], { cwd: conf.chartPath })

  // find built package
  let packagePattern = `${conf.chartPath}/${chartName}`
  if (conf.chartVersion) {
    packagePattern += `-${conf.chartVersion}.tgz`
  } else {
    packagePattern += `-${conf.chartMetadata?.version ?? '*'}.tgz`
  }
  // console.log(packagePattern)

  const packaged = await glob(packagePattern, {})
  if (packaged.length < 1)
    throw new Error(
      'Could not find packaged chart to upload. This might be an internal error.'
    )

  const options: actionExec.ExecOptions = {}
  args = []
  if (conf.force) args.push('--force')

  const repo = getRepoConfig(conf)
  let registryConfigFile: tmp.FileResult | undefined
  let repositoryConfigFile: tmp.FileResult | undefined

  if (repo.username) {
    // helm push does not support username and password
    // we create a temporary registry config

    // const registryConfigPath = tempfile({ extension: "json" });
    // await fs.promises.writeFile(registryConfigPath, registryConfigJSON, {

    const registryConfigJSON = buildRegistryConfigJSON(repo)
    // console.log(registryConfigJSON)
    registryConfigFile = tmp.fileSync()
    await fs.promises.writeFile(registryConfigFile.name, registryConfigJSON, {
      mode: 0o777
    })
    args.push(`--registry-config=${registryConfigFile.name}`)

    const repositoryConfigYAML = buildRepositoryConfigYaml(repo)
    // console.log(repositoryConfigYAML)
    repositoryConfigFile = tmp.fileSync()
    await fs.promises.writeFile(
      repositoryConfigFile.name,
      repositoryConfigYAML,
      {
        mode: 0o777
      }
    )
    // this is not necessary
    // args.push(`--repository-config=${repositoryConfigFile.name}`)

    // await temporaryWrite(registryConfigJSON, {
    //   extension: "json",
    // });
  }

  // if (conf.repoUsername) {
  //   args.push(`--username='${conf.repoUsername}'`);
  // }
  // if (conf.repoPassword) {
  //   options = { ...options, input: Buffer.from(conf.repoPassword) };
  //   args.push("--password-stdin");
  // }
  //

  const repoURL = new URL(conf.repo)
  const ociRepoURL = replaceURLProtocol(repoURL, 'oci:')
  // console.log(ociRepoURL.toString())

  for (const p of packaged) {
    try {
      await helmExec(['push', p, ociRepoURL.toString(), ...args], options)
    } catch (err) {
      if (registryConfigFile) {
        registryConfigFile.removeCallback()
        // await fs.promises.unlink(registryConfigPath);
      }
      throw err
    }
    // Fix: the container uses root and we need to namually set the chart directory permissions
    // to something that the following actions can still read and write
    // const user = await getUserInfo('nobody')
    // await chownR(path.dirname(chartPath), 65534, 65534);
    // await chmodR(path.dirname(chartPath), 0o777);

    // const { uid, gid } = await getUserInfo('nobody')
    // await chownr(path.dirname(conf.chartPath), uid, gid)
    // await chmodr(path.dirname(conf.chartPath), 0o777)
  }

  if (registryConfigFile) {
    registryConfigFile.removeCallback()
    // await fs.promises.unlink(registryConfigFile.name);
  }
}

/**
 * Remove a helm deployment
 */
async function helmRemove(conf: HelmDeployConfig): Promise<void> {
  if (!conf.release) throw new Error('required and not supplied: release')
  if (!conf.namespace) conf.namespace = 'default'
  await helmExec(['delete', '-n', conf.namespace, conf.release])
  await status('inactive')
}

/**
 * Upgrade a helm deployment
 */
async function helmUpgrade(
  conf: HelmDeployConfig,
  valuesFile: string
): Promise<void> {
  const args: string[] = []
  if (!conf.release) throw new Error('required and not supplied: release')
  if (!conf.chartPath) throw new Error('required and not supplied: chart')
  if (!conf.namespace) conf.namespace = 'default'
  if (conf.dry) args.push('--dry-run')
  if (conf.chartVersion) args.push(`--version=${conf.chartVersion}`)
  if (conf.timeout) args.push(`--timeout=${conf.timeout}`)
  if (conf.atomic) args.push('--atomic')
  if (conf.valueFiles)
    for (const f of conf.valueFiles) {
      args.push(`--values=${f}`)
    }
  if (conf.values && conf.values.length > 0) args.push(`--values=${valuesFile}`)
  await helmExec([
    'upgrade',
    '-n',
    conf.namespace,
    conf.release,
    conf.chartPath,
    '--install',
    '--wait',
    ...args
  ])
  await status('success')
}

/**
 * Parse the action's config and start the deployment
 */
export async function run(): Promise<void> {
  const conf = await parseConfig()
  if (conf.command === 'login') {
    if (conf.repo) {
      // this is just for testing
      authenticateHelm(conf)
    }
  }
  await deployHelmChart(conf)
}
