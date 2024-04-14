declare module 'metro-memory-fs' {
  class MemoryFs {
    constructor(options?: { cwd?: () => string })
    reset(): void
  }
  export = MemoryFs
}
