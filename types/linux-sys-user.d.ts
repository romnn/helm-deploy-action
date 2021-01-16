declare module 'linux-sys-user' {
  export interface UserInfo {
    username: string
    password: string
    uid: number
    gid: number
    fullname: string
    homedir: string
    shell: string
  }

  export function getUserInfo(
    name: string,
    callback: (err: Error, info: UserInfo) => void
  ): void
}
