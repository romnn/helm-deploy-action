import * as fs from 'fs'
import * as core from '@actions/core'
import * as actionExec from '@actions/exec'
import * as path from 'path'
import * as util from 'util'
import * as cp from 'child_process'
import realChmodr from 'chmodr'

export const exec = util.promisify(cp.exec)

export interface FsError {
  code: string
}

function isFsError(err: unknown): err is FsError {
  return typeof err === 'object' && err !== null && 'code' in err
}

function resolveHomeDir(p: string): string {
  const homeEnv = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const home = process.env[homeEnv]

  if (!home) {
    return p
  }
  if (p === '~') return home
  if (!p.startsWith('~/')) return p
  return path.join(home, p.slice(2))
}

/**
 * Resolve file path, including ".", "..", and "~"
 */
export async function resolvePath(p: string): Promise<string> {
  return await fs.promises.realpath(resolveHomeDir(p))
}

/**
 * Check if a file exists
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch (err: unknown) {
    if (isFsError(err) && err.code === 'ENOENT') {
      return false
    } else {
      throw new Error(`failed to check if ${p} exists`)
    }
  }
}

/**
 * Make dirs recursively
 */
// async function mkdirs(dir: string): Promise<void> {
//   const sep = '/'
//   const segments = dir.split(sep)
//   let current = ''
//   let i = 0
//   while (i < segments.length) {
//     current = current + sep + segments[i]
//     try {
//       await fs.promises.stat(current)
//     } catch {
//       await fs.promises.mkdir(current)
//     }
//     i++
//   }
// }

async function chown(dir: string, owner: number, group: number): Promise<void> {
  try {
    /* console.log('changing', dir) */
    await fs.promises.chown(dir, owner, group)
  } catch (err: unknown) {
    if (isFsError(err) && err.code === 'ENOENT') {
      // ignore chown of missing file
    } else {
      throw err
    }
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
  } catch (err: unknown) {
    if (isFsError(err) && err.code === 'ENOENT') {
      // ignore chown of missing file
    } else {
      throw err
    }
  }
}

// has lchown and runs on v10.6 or above
const needEISDIRHandled =
  fs.promises.lchown !== undefined &&
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
    } catch (err: unknown) {
      if (isFsError(err) && err.code === 'EISDIR') {
        // ignore is dir already
      } else {
        throw err
      }
      await chown(dir, owner, group)
    }
  } else {
    await lchown(dir, owner, group)
  }
}

async function chownrChild(
  parent: string,
  child: fs.Dirent | string,
  owner: number,
  group: number
): Promise<void> {
  let childDirent: fs.Dirent

  if (typeof child === 'string') {
    try {
      const childPath = path.resolve(parent, child)
      const childStat = await fs.promises.lstat(childPath)
      childDirent = { ...childStat, name: child, path: childPath }
    } catch (err: unknown) {
      if (isFsError(err) && err.code === 'ENOENT') {
        return
      } else {
        throw err
      }
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
  let children: fs.Dirent[]
  try {
    children = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err: unknown) {
    if (isFsError(err) && err.code === 'ENOENT') {
      return
    } else if (
      isFsError(err) &&
      err.code !== 'ENOTDIR' &&
      err.code !== 'ENOTSUP'
    ) {
      return await handleEISDir(dir, owner, group)
    } else {
      throw err
    }
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
    realChmodr(dir, mode, (err: unknown) => {
      if (err instanceof Error) {
        reject(
          new Error(`failed to set permissions for ${path}: ${err.message}`)
        )
      } else if (err) {
        reject(new Error(`failed to set permissions for ${path}`))
      } else {
        resolve()
      }
    })
  })
}

/**
 * Get uid and gid of user
 */
// export async function getUserInfo(
//   username: string
// ): Promise<{ uid: number; gid: number }> {
//   const uid = parseInt((await execFile('id', ['-u', username])).stdout)
//   const gid = parseInt((await execFile('id', ['-g', username])).stdout)
//   return { uid, gid }
// }
