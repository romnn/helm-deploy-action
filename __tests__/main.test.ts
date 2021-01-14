import memfs from 'metro-memory-fs'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as cp from 'child_process'
import * as path from 'path'
import * as process from 'process'
import * as fs from 'fs'

import {run, HelmDeployConfig} from '../src/deploy'
import {withMockedExec, args, MockExec} from '../src/utils'

jest.mock('fs', () => {
  return new memfs({cwd: () => '/tmp'})
})

const command = 'command'
const namespace = 'namespace'
const release = 'release'
const chart = 'chart'
const atomic = 'atomic'
const dryRun = 'dry-run'
const version = 'version'
const repo = 'repo'
const repoAlias = 'repo-alias'
const repoUsername = 'repo-username'
const repoPassword = 'repo-password'
const values = 'values'
const valueFiles = 'value-files'
const secrets = 'secrets'
const helmTimeout = 'timeout'

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
  await withMockedExec(conf, {}, async mock => {
    expect(run()).rejects.toThrow('not supplied: release')
  })
})

test('test_valid_upgrade_chart', async () => {
  const conf = {
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
      '--atomic',
      '--values=./values.yml'
    ]
  ]
  await withMockedExec(conf, {}, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options', async () => {
  const conf = {
    [release]: 'my-linkerd',
    [chart]: 'stable/linkerd',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [version]: '3.1.1',
    [values]: '{"test": "123"}',
    [valueFiles]: '["./file1.yml", "./file2.yml"]'
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
      '--values=./file1.yml',
      '--values=./file2.yml',
      '--values=./values.yml'
    ]
  ]
  const files = {
    'file1.yml': 'test: file1',
    'file2.yml': 'test: file2'
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options_external_public_repo', async () => {
  const conf = {
    [release]: 'my-mongodb',
    [chart]: 'bitnami/mongodb',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [version]: '3.1.1',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [values]: '{"test": "123"}',
    [valueFiles]: '["./file1.yml", "./file2.yml"]'
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
      '--values=./file1.yml',
      '--values=./file2.yml',
      '--values=./values.yml'
    ]
  ]
  const files = {
    'file1.yml': 'test: file1',
    'file2.yml': 'test: file2'
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_valid_upgrade_chart_with_options_external_private_repo', async () => {
  const conf = {
    [release]: 'my-mongodb',
    [chart]: 'bitnami/mongodb',
    [helmTimeout]: '1m30s',
    [atomic]: 'true',
    [dryRun]: 'true',
    [version]: '3.1.1',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [repoUsername]: 'admin',
    [repoPassword]: '123456',
    [values]: '{"test": "123"}',
    [valueFiles]: '["./file1.yml", "./file2.yml"]'
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
      '--values=./file1.yml',
      '--values=./file2.yml',
      '--values=./values.yml'
    ]
  ]
  const files = {
    'file1.yml': 'test: file1',
    'file2.yml': 'test: file2'
  }
  await withMockedExec(conf, files, async mock => {
    await run()
    expect(args(mock.mock.calls)).toEqual(expected)
  })
})

test('test_invalid_upgrade_chart_missing_chart', async () => {
  const conf = {
    [release]: 'my-linkerd',
    [chart]: 'bitnami/linkerd',
    [repo]: 'https://charts.bitnami.com/bitnami',
    [repoAlias]: 'bitnami',
    [repoUsername]: 'admin'
    // missing the repo password for user "admin"
  }
  await withMockedExec(conf, {}, async mock => {
    expect(run()).rejects.toThrow(
      'not supplied: repo-username or repo-password'
    )
  })
})

test('test_invalid_upgrade_chart_missing_chart', async () => {
  const conf = {
    [release]: 'my-linkerd'
    // missing the chart to upgrade
  }
  await withMockedExec(conf, {}, async mock => {
    expect(run()).rejects.toThrow('not supplied: chart')
  })
})

test('test_invalid_upgrade_chart_missing_release', async () => {
  const conf = {
    [chart]: 'stable/linkerd'
    // missing the release to upgrade
  }
  await withMockedExec(conf, {}, async mock => {
    expect(run()).rejects.toThrow('not supplied: release')
  })
})
