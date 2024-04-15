import memfs from 'metro-memory-fs'
import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs'
import * as actionExec from '@actions/exec'
import { run } from '../src/deploy'
// import { withMockedExec, args, MockExec } from '../src/exec'

jest.mock('fs', () => {
  return new memfs({ cwd: () => '/tmp' })
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
 * Context manager that can be used to run test with mocked calls to actionExec.exec,
 * a mocked in memory filesystem and patched getInput
 */
async function withMockedExec(
  conf: { [key: string]: string },
  files: DirectoryItems,
  callback: (mock: MockExec) => Promise<void>
): Promise<void> {
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
    const mockExec = jest.spyOn(actionExec, 'exec')
    mockExec.mockImplementation(async () => 0)
    mockGetInput.mockImplementation(
      (key: string, options?: core.InputOptions): string => {
        if (key in conf) {
          return conf[key] ?? ''
        } else if (options && options.required) {
          throw new Error(`required but not supplied: ${key}`)
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

const command = 'command'
const release = 'release'
const chart = 'chart'
const chartDir = 'chart-dir'
const atomic = 'atomic'
const dryRun = 'dry-run'
const chartVersion = 'chart-version'
const appVersion = 'app-version'
const repo = 'repo'
const repoAlias = 'repo-alias'
const repoUsername = 'repo-username'
const repoPassword = 'repo-password'
const values = 'values'
const valueFiles = 'value-files'
const dependencies = 'dependencies'
const helmTimeout = 'timeout'
const force = 'force'

// test('test_get_user_info', async () => {
//   const { uid, gid } = await getUserInfo('nobody')
//   expect(!Number.isNaN(uid))
//   expect(!Number.isNaN(gid))
// })

test('test_valid_remove', async () => {
  const conf = {
    [command]: 'remove',
    [release]: 'test'
  }
  const expected = [['helm', 'delete', '-n', 'default', 'test']]
  await withMockedExec(conf, {}, async (mock: MockExec) => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_invalid_remove_missing_release', async () => {
  const conf = {
    [command]: 'remove'
    // missing the release to remove
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: release')
  })
})

test('test_valid_upgrade_chart', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-linkerd',
    [chart]: 'stable/linkerd'
  }
  const expected = [
    [
      'helm',
      'upgrade',
      '-n',
      'default',
      'my-linkerd',
      'stable/linkerd',
      '--install',
      '--wait',
      '--values=values.yml'
    ]
  ]
  await withMockedExec(conf, {}, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-linkerd',
    [chart]: 'stable/linkerd',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [chartVersion]: '3.1.1',
    [values]: '{"test": "123"}',
    [valueFiles]: '["/tmp/file1.yml", "/tmp/file2.yml"]'
  }
  const expected = [
    [
      'helm',
      'upgrade',
      '-n',
      'default',
      'my-linkerd',
      'stable/linkerd',
      '--install',
      '--wait',
      '--dry-run',
      '--version=3.1.1',
      '--timeout=1m30s',
      '--atomic',
      '--values=/tmp/file1.yml',
      '--values=/tmp/file2.yml',
      '--values=values.yml'
    ]
  ]
  const files = {
    tmp: {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_push_chart_with_single_dependency', async () => {
  const conf = {
    [command]: 'push',
    [helmTimeout]: '1m30s',
    [force]: 'true',
    [chart]: 'linkerd',
    [chartDir]: './charts',
    [chartVersion]: '3.1.1',
    [appVersion]: 'v3.1.1alpha',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [repoUsername]: 'admin',
    [repoPassword]: '123456',
    [dependencies]: JSON.stringify([
      {
        repository: 'https://charts.bitnami.com/bitnami',
        alias: 'bitnami'
      }
    ])
  }
  const expected = [
    [
      'helm',
      'repo',
      'add',
      'bitnami',
      'https://charts.bitnami.com/bitnami',
      '--username=admin',
      '--password=123456'
    ],
    ['helm', 'repo', 'update'],
    // dependency repos
    ['helm', 'repo', 'add', 'bitnami', 'https://charts.bitnami.com/bitnami'],
    ['helm', 'repo', 'update'],
    // inspect
    ['helm', 'inspect', 'chart', '/tmp/charts/linkerd'],
    // update
    ['helm', 'dependency', 'update', '/tmp/charts/linkerd'],
    // package
    [
      'helm',
      'package',
      '/tmp/charts/linkerd',
      '--version=3.1.1',
      '--app-version=v3.1.1alpha'
    ],
    // push
    [
      'helm',
      'push',
      '/tmp/charts/linkerd/linkerd-0.1.2.tgz',
      'https://charts.bitnami.com/bitnami',
      '--username=admin',
      '--password=123456',
      '--force'
    ]
  ]
  const files = {
    tmp: {
      charts: {
        linkerd: {
          'linkerd-0.1.2.tgz': 'whatever',
          'linkkerd-mocks.yaml': 'whatever',
          'Chart.yaml': 'whatever',
          'values.yaml': 'whatever'
        }
      }
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options_external_public_repo', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-mongodb',
    [chart]: 'bitnami/mongodb',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [chartVersion]: '3.1.1',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [values]: '{"test": "123"}',
    [valueFiles]: '["/tmp/file1.yml", "/tmp/file2.yml"]'
  }
  const expected = [
    ['helm', 'repo', 'add', 'bitnami', 'https://charts.bitnami.com/bitnami'],
    ['helm', 'repo', 'update'],
    [
      'helm',
      'upgrade',
      '-n',
      'default',
      'my-mongodb',
      'bitnami/mongodb',
      '--install',
      '--wait',
      '--dry-run',
      '--version=3.1.1',
      '--timeout=1m30s',
      '--atomic',
      '--values=/tmp/file1.yml',
      '--values=/tmp/file2.yml',
      '--values=values.yml'
    ]
  ]
  const files = {
    tmp: {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options_external_private_repo', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-mongodb',
    [chart]: 'bitnami/mongodb',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [chartVersion]: '3.1.1',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [repoUsername]: 'admin',
    [repoPassword]: '123456',
    [values]: '{"test": "123"}',
    [valueFiles]: '["/tmp/file1.yml", "/tmp/file2.yml"]'
  }
  const expected = [
    [
      'helm',
      'repo',
      'add',
      'bitnami',
      'https://charts.bitnami.com/bitnami',
      '--username=admin',
      '--password=123456'
    ],
    ['helm', 'repo', 'update'],
    [
      'helm',
      'upgrade',
      '-n',
      'default',
      'my-mongodb',
      'bitnami/mongodb',
      '--install',
      '--wait',
      '--dry-run',
      '--version=3.1.1',
      '--timeout=1m30s',
      '--atomic',
      '--values=/tmp/file1.yml',
      '--values=/tmp/file2.yml',
      '--values=values.yml'
    ]
  ]
  const files = {
    tmp: {
      'file1.yml': 'test: file1',
      'file2.yml': 'test: file2'
    }
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_invalid_upgrade_chart_missing_repo_password', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-linkerd',
    [chart]: 'bitnami/linkerd',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [repoUsername]: 'admin'
    // missing the repo password for user "admin"
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow(
      'not supplied: repo-username or repo-password'
    )
  })
})

test('test_invalid_upgrade_chart_missing_chart', async () => {
  const conf = {
    [command]: 'upgrade',
    [release]: 'my-linkerd'
    // missing the chart to upgrade
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: chart')
  })
})

test('test_invalid_upgrade_chart_missing_release', async () => {
  const conf = {
    [command]: 'upgrade',
    [chart]: 'stable/linkerd'
    // missing the release to upgrade
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: release')
  })
})

test('test_invalid_upgrade_chart_missing_command', async () => {
  const conf = {
    // missing the command to perform
    [release]: 'my-linkerd',
    [chart]: 'stable/linkerd'
  }
  await withMockedExec(conf, {}, async () => {
    await expect(run()).rejects.toThrow('not supplied: command')
  })
})
