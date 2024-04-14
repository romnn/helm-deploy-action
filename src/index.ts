import { run, status } from './deploy'
import * as core from '@actions/core'

async function entrypoint(): Promise<void> {
  try {
    await run()
  } catch (err: unknown) {
    if (err instanceof Error) {
      core.error(err)
      core.setFailed(err.message)
    }
    await status('failure')
  }
}

entrypoint()
