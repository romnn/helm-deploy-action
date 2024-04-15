import memfs from 'metro-memory-fs'
import tmp from 'tmp'
import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs'
import * as actionExec from '@actions/exec'
import * as YAML from 'yaml'
import { run, HelmRepoConfig, AuthConfig } from '../src/deploy'
import {
  ActionConfig,
  MissingConfigError,
  isActionConfigKey,
  DEFAULT_CONF
} from '../src/config'

jest.mock('fs', () => {
  return new memfs({ cwd: () => '/in-mem-fs' })
})

type DirectoryItems = { [key: string]: DirectoryItems | string }

type MockExec = jest.SpiedFunction<typeof actionExec.exec>

type ExecCallArgs = [
  cmd: string,
  args?: string[] | undefined,
  options?: actionExec.ExecOptions | undefined
]

/**
 * Extract executable and arguments of a call to actionExec.exec
 */
function args(calls: ExecCallArgs[]): string[][] {
  return calls.map(call => [call[0], ...(call[1] ?? [])])
}

/**
 * Flatten dictionary by concatenating keys using a given separator
 */
function reduceNested(
  ob: DirectoryItems,
  separator = '.'
): { [key: string]: string } {
  const ans: { [key: string]: string } = {}

  for (const key in ob) {
    const val = ob[key]
    if (typeof val === 'string') {
      ans[key] = val
    } else {
      const flattened = reduceNested(val, separator)
      for (const key2 in flattened) {
        ans[key + separator + key2] = flattened[key2]
      }
    }
  }
  return ans
}

/**
 * Context manager that can be used to run test with mocked
 * calls to actionExec.exec
 *
 * Uses mocked in memory filesystem and patched getInput
 */
async function withMockedExec(
  conf: ActionConfig,
  files: DirectoryItems,
  callback: (mock: MockExec) => Promise<void>
): Promise<void> {
  // note that all
  await fs.promises.mkdir('/in-mem-fs', { recursive: true })
  await fs.promises.mkdir('/tmp', { recursive: true })
  const reducedFiles = Object.entries(reduceNested(files, '/')).reduce(
    (acc, item) => {
      acc[`/${item[0]}`] = item[1]
      return acc
    },
    {} as { [key: string]: string }
  )
  for (const file in reducedFiles) {
    const content = reducedFiles[file]
    const dir = path.dirname(file)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(file, content)
  }
  try {
    const mockGetInput = jest.spyOn(core, 'getInput')
    const mockTmpFile = jest.spyOn(tmp, 'fileSync')
    const mockExec = jest.spyOn(actionExec, 'exec')
    mockExec.mockImplementation(async () => 0)
    mockTmpFile.mockImplementation(
      (options?: tmp.FileOptions | undefined): tmp.FileResult => {
        if (options?.name) {
          const tmpFilePath = path.join('/tmp', options.name)
          const tmpFile = fs.openSync(tmpFilePath, 'w')
          return {
            name: tmpFilePath,
            fd: tmpFile,
            removeCallback: () => {
              fs.unlinkSync(tmpFilePath)
            }
          }
        } else {
          throw Error('cannot mock tmp files without name')
        }
      }
    )
    mockGetInput.mockImplementation(
      (key: string, options?: core.InputOptions): string => {
        if (isActionConfigKey(key, conf)) {
          return (conf[key] ?? '').toString()
        } else if (options && options.required) {
          // throw new Error(`unknown config key: ${key}`)
          throw new MissingConfigError(key as keyof ActionConfig)
        }
        return ''
      }
    )
    await callback(mockExec)
  } catch (err) {
    // cleanup the files
    for (const file in reducedFiles) {
      await fs.promises.unlink(file)
    }
    throw err
  }
}

// test('test_get_user_info', async () => {
//   const { uid, gid } = await getUserInfo('nobody')
//   expect(!Number.isNaN(uid))
//   expect(!Number.isNaN(gid))
// })

test('test_valid_delete', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'delete',
    release: 'test'
  }
  const expected = [
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    ['helm', 'delete', '-n', 'default', 'test']
  ]
  await withMockedExec(conf, {}, async (mock: MockExec) => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_invalid_delete_missing_release', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'delete'
    // missing the release to delete
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: release')
  })
})

test('test_valid_upgrade_chart', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-linkerd',
    chart: 'stable/linkerd'
  }
  const expected = [
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    [
      'helm',
      'upgrade',
      'my-linkerd',
      'stable/linkerd',
      '--install',
      '--wait',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml',
      '-n',
      'default',
      '--atomic',
      '--values',
      'values.yml'
    ]
  ]
  const expectedRepos: HelmRepoConfig[] = [
    // { name: 'stable' url: 'https://charts.helm.sh/stable' }
  ]
  const expectedRegistries: { [key: string]: AuthConfig } = {
    // 'https://charts.helm.sh/stable': { }
  }

  await withMockedExec(conf, {}, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)

    const repos = YAML.parse(
      await fs.promises.readFile('/tmp/repositories.yaml', 'utf8')
    )
    expect(repos.repositories).toEqual(expectedRepos)

    const registries = JSON.parse(
      await fs.promises.readFile('/tmp/registries.json', 'utf8')
    )
    expect(registries.auths).toEqual(expectedRegistries)
  })
})

test('test_valid_upgrade_chart_with_options', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-linkerd',
    chart: 'stable/linkerd',
    timeout: '1m30s',
    atomic: true,
    'dry-run': true,
    'chart-version': '3.1.1',
    values: '{"test": "123"}',
    'value-files': '["/in-mem-fs/file1.yml", "/in-mem-fs/file2.yml"]'
  }
  const expected = [
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    [
      'helm',
      'upgrade',
      'my-linkerd',
      'stable/linkerd',
      '--install',
      '--wait',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml',
      '-n',
      'default',
      '--dry-run',
      '--version',
      '3.1.1',
      '--timeout',
      '1m30s',
      '--atomic',
      '--values',
      '/in-mem-fs/file1.yml',
      '--values',
      '/in-mem-fs/file2.yml',
      '--values',
      'values.yml'
    ]
  ]
  const files = {
    'in-mem-fs': {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_push_local_chart_with_single_dependency', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'push',
    timeout: '1m30s',
    force: true,
    chart: './my-charts/mychart',
    'chart-version': '3.1.1',
    'app-version': 'v3.1.1alpha',
    repo: 'https://charts.bitnami.com/bitnami',
    'use-oci': true,
    'repo-alias': 'bitnami',
    'repo-username': 'admin',
    'repo-password': '123456',
    dependencies: JSON.stringify([
      {
        repository: 'https://charts.bitnami.com/flink',
        alias: 'flink'
      }
    ])
  }
  const expected = [
    // [
    //   'helm',
    //   'repo',
    //   'add',
    //   'bitnami',
    //   'https://charts.bitnami.com/bitnami',
    //   '--username=admin',
    //   '--password=123456'
    // ],
    // ['helm', 'repo', 'update'],
    // dependency repos
    // ['helm', 'repo', 'add', 'dep', 'https://charts.bitnami.com/dep'],
    // update repos
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    // ['helm', 'repo', 'update'],
    // inspect
    ['helm', 'inspect', 'chart', '/in-mem-fs/my-charts/mychart'],
    // dependency update
    [
      'helm',
      'dependency',
      'update',
      '/in-mem-fs/my-charts/mychart',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    // package
    [
      'helm',
      'package',
      '--version',
      '3.1.1',
      '--app-version',
      'v3.1.1alpha',
      '/in-mem-fs/my-charts/mychart'
    ],
    // push
    [
      'helm',
      'push',
      '/in-mem-fs/my-charts/mychart/myactualchart-3.1.1.tgz',
      'oci://charts.bitnami.com/bitnami',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
      // '--username=admin',
      // '--password=123456',
      // '--force'
    ]
  ]
  const expectedRepos: HelmRepoConfig[] = [
    {
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      username: 'admin',
      password: '123456'
    }
  ]
  const expectedRegistries: { [key: string]: AuthConfig } = {
    'https://charts.bitnami.com/bitnami': {
      Username: 'admin',
      Password: '123456'
    }
  }
  const files = {
    'in-mem-fs': {
      'my-charts': {
        mychart: {
          'myactualchart-3.1.1.tgz': 'whatever',
          // 'linkkerd-mocks.yaml': 'whatever',
          'Chart.yaml': 'name: myactualchart\nversion: 0.3.0'
          // 'values.yaml': 'whatever'
        }
      }
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)

    const repos = YAML.parse(
      await fs.promises.readFile('/tmp/repositories.yaml', 'utf8')
    )
    expect(repos.repositories).toEqual(expectedRepos)

    const registries = JSON.parse(
      await fs.promises.readFile('/tmp/registries.json', 'utf8')
    )
    expect(registries.auths).toEqual(expectedRegistries)
  })
})

test('test_valid_upgrade_chart_with_options_external_public_repo', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-mongodb',
    chart: 'bitnami/mongodb',
    timeout: '1m30s',
    atomic: true,
    'dry-run': true,
    'chart-version': '3.1.1',
    repo: 'https://charts.bitnami.com/bitnami',
    'repo-alias': 'bitnami',
    values: '{"test": "123"}',
    'value-files': '["/in-mem-fs/file1.yml", "/in-mem-fs/file2.yml"]'
  }
  const expected = [
    // ['helm', 'repo', 'add', 'bitnami', 'https://charts.bitnami.com/bitnami'],
    // ['helm', 'repo', 'update'],
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    [
      'helm',
      'upgrade',
      'my-mongodb',
      'bitnami/mongodb',
      '--install',
      '--wait',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml',
      '-n',
      'default',

      '--dry-run',
      '--version',
      '3.1.1',
      '--timeout',
      '1m30s',
      '--atomic',
      '--values',
      '/in-mem-fs/file1.yml',
      '--values',
      '/in-mem-fs/file2.yml',
      '--values',
      'values.yml'
    ]
  ]
  const expectedRepos: HelmRepoConfig[] = [
    {
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      username: '',
      password: ''
    }
  ]
  const expectedRegistries: { [key: string]: AuthConfig } = {
    'https://charts.bitnami.com/bitnami': {
      Username: '',
      Password: ''
    }
  }
  const files = {
    'in-mem-fs': {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
    const repos = YAML.parse(
      await fs.promises.readFile('/tmp/repositories.yaml', 'utf8')
    )
    expect(repos.repositories).toEqual(expectedRepos)

    const registries = JSON.parse(
      await fs.promises.readFile('/tmp/registries.json', 'utf8')
    )
    expect(registries.auths).toEqual(expectedRegistries)
  })
})

test('test_valid_upgrade_chart_with_options_external_private_repo', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-mongodb',
    chart: 'bitnami/mongodb',
    timeout: '1m30s',
    'kubeconfig-inline': 'top secret',
    atomic: true,
    'dry-run': true,
    'chart-version': '3.1.1',
    repo: 'https://charts.bitnami.com/bitnami',
    'repo-alias': 'bitnami',
    'repo-username': 'admin',
    'repo-password': '123456',
    values: '{"test": "123"}',
    'value-files': '["/in-mem-fs/file1.yml", "/in-mem-fs/file2.yml"]'
  }
  const expected = [
    // [
    //   'helm',
    //   'repo',
    //   'add',
    //   'bitnami',
    //   'https://charts.bitnami.com/bitnami'
    //   '--username=admin',
    //   '--password=123456'
    // ],
    [
      'helm',
      'repo',
      'update',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml'
    ],
    [
      'helm',
      'upgrade',
      'my-mongodb',
      'bitnami/mongodb',
      '--install',
      '--wait',
      '--registry-config',
      '/tmp/registries.json',
      '--repository-config',
      '/tmp/repositories.yaml',
      '-n',
      'default',
      '--kubeconfig',
      '/tmp/kubeconfig.yml',
      '--dry-run',
      '--version',
      '3.1.1',
      '--timeout',
      '1m30s',
      '--atomic',
      '--values',
      '/in-mem-fs/file1.yml',
      '--values',
      '/in-mem-fs/file2.yml',
      '--values',
      'values.yml'
    ]
  ]
  const expectedRepos: HelmRepoConfig[] = [
    {
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      username: 'admin',
      password: '123456'
    }
  ]
  const expectedRegistries: { [key: string]: AuthConfig } = {
    'https://charts.bitnami.com/bitnami': {
      Username: 'admin',
      Password: '123456'
    }
  }
  const files = {
    'in-mem-fs': {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)

    const repos = YAML.parse(
      await fs.promises.readFile('/tmp/repositories.yaml', 'utf8')
    )
    expect(repos.repositories).toEqual(expectedRepos)

    const registries = JSON.parse(
      await fs.promises.readFile('/tmp/registries.json', 'utf8')
    )
    expect(registries.auths).toEqual(expectedRegistries)
  })
})

test('test_invalid_upgrade_chart_missing_repo_password', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-linkerd',
    chart: 'bitnami/linkerd',
    repo: 'https://charts.bitnami.com/bitnami',
    'repo-alias': 'bitnami',
    'repo-username': 'admin'
    // missing the repo password for user "admin"
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow(
      'supplied repo-username but missing repo-password'
    )
  })
})

test('test_invalid_upgrade_chart_missing_chart', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    release: 'my-linkerd'
    // missing the chart to upgrade
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: chart')
  })
})

test('test_invalid_upgrade_chart_missing_release', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    command: 'upgrade',
    chart: 'stable/linkerd'
    // missing the release to upgrade
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: release')
  })
})

test('test_invalid_upgrade_chart_missing_command', async () => {
  const conf: ActionConfig = {
    ...DEFAULT_CONF,
    // missing the command to perform
    release: 'my-linkerd',
    chart: 'stable/linkerd'
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: command')
  })
})
