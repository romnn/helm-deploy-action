import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import * as glob from 'glob'
import * as util from 'util'
import * as Mustache from 'mustache'

const asyncGlob = util.promisify(glob.glob)

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
  return core.getInput(name, {required})
}

/**
 * Parse the action's entire config
 */
function parseConfig(): HelmDeployConfig {
  const command = parseInput('command').toLowerCase()

  const isPush = command === 'push'
  const isUpgrade = command === 'upgrade'
  const isRemove = command === 'remove'
  return {
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
    chart: parseInput('chart', isUpgrade || isPush),
    chartVersion: parseInput('chart-version'),
    repo: parseInput('repo', isPush),
    repoAlias: parseInput('repo-alias'),
    repoUsername: parseInput('repo-username'),
    repoPassword: parseInput('repo-password'),
    dependencies: parseDependencies(parseInput('dependencies')),

    // push
    appVersion: parseInput('app-version'),
    chartDir: parseInput('chart-dir'),
    force: parseInput('force') === 'true'
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

    await client.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: deployment.id,
      state,
      log_url: url,
      target_url: url,
      headers: {accept: 'application/vnd.github.ant-man-preview+json'}
    })
  } catch (error) {
    core.warning(`failed to set deployment status: ${error.message}`)
  }
}

/**
 * Render files renders user provided values into the list of provided files
 * using the mustache template engine
 */
async function renderFiles(
  files: string[],
  data: {secrets: object | string; deployment: string[]}
): Promise<void> {
  const tags: [string, string] = ['${{', '}}']
  const promises = files.map(async (file: string) => {
    const content = await fs.promises.readFile(file, {encoding: 'utf8'})
    const rendered = Mustache.render(content, data, {}, tags)
    await fs.promises.writeFile(file, rendered)
  })
  Promise.all(promises)
}

export interface HelmRepo {
  repository?: string
  alias?: string
  username?: string
  password?: string
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
  chart?: string
  chartVersion?: string
  repo?: string
  repoAlias?: string
  repoUsername?: string
  repoPassword?: string
  dependencies?: HelmRepo[]

  // push
  appVersion?: string
  chartDir?: string
  force?: boolean
}

/**
 * Execute a helm command
 */
async function helmExec(
  args: string[],
  options?: exec.ExecOptions
): Promise<void> {
  await exec.exec('helm', args, options)
}

async function addHelmRepo(repo: HelmRepo): Promise<void> {
  if (!repo.repository)
    throw new Error('required and not supplied: repo / dependency repository')
  if (!repo.alias)
    throw new Error('required and not supplied: repo-alias / dependency alias')
  const args = ['repo', 'add', repo.alias, repo.repository]
  let supplied_both_or_none = true
  if (repo.username) {
    supplied_both_or_none = !supplied_both_or_none
    args.push(`--username=${repo.username}`)
  }
  if (repo.password) {
    supplied_both_or_none = !supplied_both_or_none
    args.push(`--password=${repo.password}`)
  }
  if (!supplied_both_or_none)
    throw new Error('required and not supplied: repo-username or repo-password')
  await helmExec(args)
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
    if (!conf.repoAlias) conf.repoAlias = 'source-chart-repo'
    await addHelmRepo({
      repository: conf.repo,
      alias: conf.repoAlias,
      username: conf.repoUsername,
      password: conf.repoPassword
    })
    await helmExec(['repo', 'update'])
  }

  // add dependency repositories
  if (conf.dependencies && conf.dependencies.length > 0) {
    for (const dep of conf.dependencies) {
      await addHelmRepo(dep)
    }
    await helmExec(['repo', 'update'])
  }

  // prepare values override file
  if (conf.values && conf.values.length > 0)
    await fs.promises.writeFile('./values.yml', conf.values)

  // prepare kubeconfig file
  if (process.env.KUBECONFIG_FILE) {
    process.env.KUBECONFIG = './kubeconfig.yml'
    await fs.promises.writeFile(
      process.env.KUBECONFIG,
      process.env.KUBECONFIG_FILE
    )
  }

  // render value files using github variables
  if (conf.valueFiles)
    await renderFiles(conf.valueFiles.concat(['./values.yml']), {
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
      await helmUpgrade(conf)
      break
    default:
      throw new Error(`unkown helm command: ${conf.command}`)
  }
}

/**
 * Push a helm chart to a helm repository
 */
async function helmPush(conf: HelmDeployConfig): Promise<void> {
  if (!conf.chart) throw new Error('required and not supplied: chart')
  if (!conf.repo) throw new Error('required and not supplied: repo')
  if (!conf.repoUsername)
    throw new Error('required and not supplied: repo-username')
  if (!conf.repoPassword)
    throw new Error('required and not supplied: repo-password')

  const cwd = await fs.promises.realpath(
    path.join(conf.chartDir ?? '.', conf.chart)
  )
  await helmExec(['inspect', 'chart', cwd])

  let args = []
  if (conf.chartVersion) args.push(`--version=${conf.chartVersion}`)
  if (conf.appVersion) args.push(`--app-version=${conf.appVersion}`)
  await helmExec(['package', cwd, ...args], {cwd})

  await helmExec(['dependency', 'update', cwd])

  args = []
  args.push(`--username=${conf.repoUsername}`)
  args.push(`--password=${conf.repoPassword}`)
  if (conf.force) args.push('--force')
  const packaged = await asyncGlob(`${cwd}/${conf.chart}-*.tgz`)
  if (packaged.length < 1)
    throw new Error(
      'Could not find packaged chart to upload. This might be an internal error.'
    )
  for (const p of packaged) await helmExec(['push', p, conf.repo, ...args])
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
async function helmUpgrade(conf: HelmDeployConfig): Promise<void> {
  const args = []
  if (!conf.release) throw new Error('required and not supplied: release')
  if (!conf.chart) throw new Error('required and not supplied: chart')
  if (!conf.namespace) conf.namespace = 'default'
  if (conf.dry) args.push('--dry-run')
  if (conf.chartVersion) args.push(`--version=${conf.chartVersion}`)
  if (conf.timeout) args.push(`--timeout=${conf.timeout}`)
  if (conf.atomic) args.push('--atomic')
  if (conf.valueFiles)
    for (const f of conf.valueFiles) {
      args.push(`--values=${f}`)
    }
  if (conf.values && conf.values.length > 0) args.push('--values=./values.yml')
  await helmExec([
    'upgrade',
    '-n',
    conf.namespace,
    conf.release,
    conf.chart,
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
  await deployHelmChart(parseConfig())
}
