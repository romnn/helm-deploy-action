import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import * as cp from 'child_process'

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
