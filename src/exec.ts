import * as cp from 'child_process'
import * as path from 'path'
import * as util from 'util'
import * as actionExec from '@actions/exec'

export const execFile = util.promisify(cp.execFile)

export type ProcessEnv = { [key: string]: string | undefined }

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
): Promise<{ stdout: string; stderr: string }> {
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
  return { stdout, stderr }
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
    env: { ...process.env, ...env }
    /* stdio: 'inherit' */
  }
  try {
    const { stdout } = await execFile(np, [ip], options)
    return await callback(stdout)
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error(`failed to run the action distributable: ${err.message}`)
    } else {
      throw new Error('failed to run the action distributable')
    }
  }
}
