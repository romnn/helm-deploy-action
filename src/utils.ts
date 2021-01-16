import * as fs from 'fs'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as path from 'path'
import * as cp from 'child_process'

interface Dict<T> {
  [key: string]: T
}

export type MockExec = jest.SpiedFunction<typeof exec.exec>
export type ExecCallArgs = [
  cmd: string,
  args?: string[] | undefined,
  options?: exec.ExecOptions | undefined
]

export type ProcessEnv = Dict<string | undefined>

export type DirectoryItems = Dict<DirectoryItems | string>

export function reduceNested(
  ob: DirectoryItems,
  separator = '.'
): Dict<string> {
  const ans: Dict<string> = {}

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

async function mkdirs(dir: string): Promise<void> {
  const sep = '/'
  const segments = dir.split(sep)
  let current = ''
  let i = 0
  while (i < segments.length) {
    current = current + sep + segments[i]
    try {
      await fs.promises.stat(current)
    } catch {
      await fs.promises.mkdir(current)
    }
    i++
  }
}

export async function withMockedExec(
  conf: Dict<string>,
  files: DirectoryItems,
  callback: (mock: MockExec) => Promise<void>
): Promise<void> {
  await mkdirs('/tmp')
  const reducedFiles = Object.entries(reduceNested(files, '/')).reduce(
    (acc, item) => {
      acc[`/${item[0]}`] = item[1]
      return acc
    },
    {} as Dict<string>
  )
  for (const file in reducedFiles) {
    const content = reducedFiles[file]
    const dir = path.dirname(file)
    await mkdirs(dir)
    await fs.promises.writeFile(file, content)
  }
  try {
    const mockGetInput = jest.spyOn(core, 'getInput')
    const mockExec = jest.spyOn(exec, 'exec')
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

export async function runAction(
  conf: object,
  callback: (output: string) => Promise<void>
): Promise<void> {
  const env: ProcessEnv = Object.entries(conf).reduce((acc, item) => {
    acc[`INPUT_${item[0].replace(/ /g, '_').toUpperCase()}`] = item[1]
    return acc
  }, {} as ProcessEnv)

  const np = process.execPath
  const ip = path.join(__dirname, '..', 'lib', 'main.js')
  const options: cp.ExecFileSyncOptions = {
    env: {...process.env, ...env}
    /* stdio: 'inherit' */
  }
  try {
    return await callback(cp.execFileSync(np, [ip], options)?.toString())
  } catch (err) {
    throw new Error(`failed to run the action distributable: ${err.message}`)
  }
}

export function args(calls: ExecCallArgs[]): string[][] {
  return calls.map(call => [call[0], ...(call[1] ?? [])])
}
