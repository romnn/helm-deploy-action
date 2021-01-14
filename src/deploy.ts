import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as Mustache from 'mustache'

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
  return {
    command,

    release: parseInput('release', true),
    chart: parseInput('chart', command !== 'remove'),
    version: parseInput('version'),
    namespace: parseInput('namespace'),

    repo: parseInput('repo'),
    repoAlias: parseInput('repo-alias'),
    repoUsername: parseInput('repo-username'),
    repoPassword: parseInput('repo-password'),

    values: parseValues(parseInput('values')),
    dry: parseInput('dry-run') === 'true',
    atomic: parseInput('atomic') === 'true',
    valueFiles: parseValueFiles(parseInput('value-files')),
    secrets: parseSecrets(parseInput('secrets')),
    timeout: parseInput('timeout')
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

/**
 * Helm deployment configuration
 */
export interface HelmDeployConfig {
  release?: string
  chart?: string

  version?: string
  namespace?: string
  command?: string

  repo?: string
  repoAlias?: string
  repoUsername?: string
  repoPassword?: string

  dry?: boolean
  timeout?: string
  atomic?: boolean
  valueFiles?: string[]
  values?: string
  secrets?: string | object
}

/**
 * Execute a helm command
 */
async function helmExec(args: string[]): Promise<void> {
  await exec.exec('helm', args, {ignoreReturnCode: false})
}

/**
 * Deploy or remove a helm chart
 */
async function deployHelmChart(conf: HelmDeployConfig): Promise<void> {
  const context = github.context
  await status('pending')

  // set sensible defaults
  conf.atomic = conf.atomic || true
  if (!conf.command) conf.command = 'upgrade'
  if (!conf.namespace) conf.namespace = 'default'
  if (!conf.repoAlias) conf.repoAlias = 'source-chart-repo'

  // check for required values
  if (!conf.release) throw new Error('required and not supplied: release')

  // add the helm repository
  if (conf.repo) {
    const args = ['repo', 'add', conf.repoAlias, conf.repo]
    let supplied_both_or_none = true
    if (conf.repoUsername) {
      supplied_both_or_none = !supplied_both_or_none
      args.push(`--username=${conf.repoUsername}`)
    }
    if (conf.repoPassword) {
      supplied_both_or_none = !supplied_both_or_none
      args.push(`--password=${conf.repoPassword}`)
    }
    if (!supplied_both_or_none)
      throw new Error(
        'required and not supplied: repo-username or repo-password'
      )
    await helmExec(args)
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

  const args = []
  switch (conf.command) {
    case 'remove':
      await helmExec(['delete', '-n', conf.namespace, conf.release])
      await status('inactive')
      break
    case 'upgrade':
      if (!conf.chart) throw new Error('required and not supplied: chart')
      if (conf.dry) args.push('--dry-run')
      if (conf.version) args.push(`--version=${conf.version}`)
      if (conf.timeout) args.push(`--timeout=${conf.timeout}`)
      if (conf.atomic) args.push('--atomic')
      if (conf.valueFiles)
        for (const f of conf.valueFiles) {
          args.push(`--values=${f}`)
        }
      if (conf.values && conf.values.length > 0)
        args.push('--values=./values.yml')
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
      break
    default:
      throw new Error(`unkown helm command: ${conf.command}`)
  }
}

/**
 * Parse the action's config and start the deployment
 */
export async function run(): Promise<void> {
  await deployHelmChart(parseConfig())
}
