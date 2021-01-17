import * as fs from 'fs'
import * as core from '@actions/core'
import * as actionExec from '@actions/exec'
import * as path from 'path'
import * as util from 'util'
import * as cp from 'child_process'
import realChmodr from 'chmodr'

export const execFile = util.promisify(cp.execFile)
export const exec = util.promisify(cp.exec)

interface Dict<T> {
  [key: string]: T
}

export type MockExec = jest.SpiedFunction<typeof actionExec.exec>
export type ExecCallArgs = [
  cmd: string,
  args?: string[] | undefined,
  options?: actionExec.ExecOptions | undefined
]

export type ProcessEnv = Dict<string | undefined>

export type DirectoryItems = Dict<DirectoryItems | string>

/**
 * Flatten dictionary by concatenating keys using a given separator
 */
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

/**
 * Make dirs recursively
 */
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

async function chown(dir: string, owner: number, group: number): Promise<void> {
  try {
    /* console.log('changing', dir) */
    await fs.promises.chown(dir, owner, group)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

const chownImpl: (
  dir: string,
  uid: number,
  gid: number
) => Promise<void> | undefined = fs.promises.lchown
  ? fs.promises.lchown
  : fs.promises.chown

async function lchown(
  dir: string,
  owner: number,
  group: number
): Promise<void> {
  try {
    /* console.log('changing', dir) */
    if (chownImpl) await chownImpl(dir, owner, group)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// has lchown and runs on v10.6 or above
const needEISDIRHandled =
  fs.promises.lchown &&
  !process.version.match(/v1[1-9]+\./) &&
  !process.version.match(/v10\.[6-9]/)

async function handleEISDir(
  dir: string,
  owner: number,
  group: number
): Promise<void> {
  if (needEISDIRHandled) {
    // Node prior to v10 had a very questionable implementation of
    // fs.lchown, which would always try to call fs.open on a directory
    // Fall back to fs.chown in those cases.
    try {
      return await lchown(dir, owner, group)
    } catch (err) {
      if (err.code !== 'EISDIR') throw err
      await chown(dir, owner, group)
    }
  } else {
    await lchown(dir, owner, group)
  }
}

export async function chownrChild(
  parent: string,
  child: fs.Dirent | string,
  owner: number,
  group: number
): Promise<void> {
  let childDirent: fs.Dirent

  if (typeof child === 'string') {
    try {
      const childStat = await fs.promises.lstat(path.resolve(parent, child))
      childDirent = {...childStat, name: child}
    } catch (err) {
      if (err.code === 'ENOENT') return
      else throw err
    }
  } else {
    childDirent = child
  }

  if (childDirent.isDirectory())
    await chownr(path.resolve(parent, childDirent.name), owner, group)

  return await handleEISDir(
    path.resolve(parent, childDirent.name),
    owner,
    group
  )
}

/**
 * Change owner recursively
 */
export async function chownr(
  dir: string,
  owner: number,
  group: number
): Promise<void> {
  let children
  try {
    children = await fs.promises.readdir(dir, {withFileTypes: true})
  } catch (err) {
    if (err.code === 'ENOENT') return
    else if (err.code !== 'ENOTDIR' && err.code !== 'ENOTSUP')
      return await handleEISDir(dir, owner, group)
    else throw err
  }

  if (children && children.length)
    for (const child of children) {
      await chownrChild(dir, child, owner, group)
    }

  return await handleEISDir(dir, owner, group)
}

/**
 * change mod recursively
 */
export async function chmodr(dir: string, mode: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    realChmodr(dir, mode, err => {
      if (err) {
        reject(
          new Error(`failed to set permissions for ${path}: ${err.message}`)
        )
      } else {
        resolve()
      }
    })
  })
}

/**
 * Execute a helm command
 */
export async function helmExec(
  helmArgs: string[],
  options?: actionExec.ExecOptions
): Promise<void> {
  await actionExec.exec('helm', helmArgs, options)
}

/**
 * Execute a command and capture stdout and stderr
 */
export async function execWithOutput(
  executable: string,
  cmdArgs: string[],
  options?: actionExec.ExecOptions
): Promise<{stdout: string; stderr: string}> {
  let stdout = ''
  let stderr = ''
  await actionExec.exec(executable, cmdArgs, {
    ...options,
    ...{
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString()
        },
        stderr: (data: Buffer) => {
          stderr += data.toString()
        }
      }
    }
  })
  return {stdout, stderr}
}

/**
 * Get uid and gid of user
 */
export async function getUserInfo(
  username: string
): Promise<{uid: number; gid: number}> {
  const uid = parseInt((await execFile('id', ['-u', username])).stdout)
  const gid = parseInt((await execFile('id', ['-g', username])).stdout)
  return {uid, gid}
}

/**
 * Context manager that can be used to run test with mocked calls to actionExec.exec,
 * a mocked in memory filesystem and patched getInput
 */
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

/**
 * Run the transpiled action as a subprocess
 */
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
    const {stdout} = await execFile(np, [ip], options)
    return await callback(stdout)
  } catch (err) {
    throw new Error(`failed to run the action distributable: ${err.message}`)
  }
}

/**
 * Extract executable and arguments of a call to actionExec.exec
 */
export function args(calls: ExecCallArgs[]): string[][] {
  return calls.map(call => [call[0], ...(call[1] ?? [])])
}
