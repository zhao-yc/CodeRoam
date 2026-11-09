export type ManagerContext = {
  configured: boolean
  workerConfigPath: string
  version: string
  platform: string
}

export type ConfigValues = {
  label: string
  relayUrl: string
  multiInstance: boolean
  newConversationSettingsCache: { ttlMs: number; maxEntries: number }
}

export type ConfigSnapshot = { revision: string; values: ConfigValues; tokenConfigured: boolean }
export type RuntimeStatus = {
  running: boolean
  connected: boolean
  pid: number | null
  supervisorPid: number | null
  version: string
  activeRevision: string
  savedRevision: string
  restartRequired: boolean
  maintenance: Record<string, number> | string
  instances: { label: string; ready: boolean }[]
  configPath: string
  backgroundSyncEnabled?: boolean
  startupEnabled?: boolean
  startError?: string
  serviceState?: 'starting' | 'running' | 'stopping' | 'stopped'
}

export type LogEntry = { time: number | string; level: string; message: string }
export type DesktopManager = {
  getContext(): Promise<ManagerContext>
  chooseWorker(): Promise<ManagerContext>
  status(): Promise<RuntimeStatus>
  readConfig(): Promise<ConfigSnapshot>
  saveConfig(input: { expectedRevision: string; values: ConfigValues }): Promise<ConfigSnapshot>
  readLogs(input: { limit?: number }): Promise<{ entries: LogEntry[] }>
  setBackgroundSync(input: { enabled: boolean }): Promise<{ backgroundSyncEnabled: boolean }>
  setStartup(input: { enabled: boolean }): Promise<{ startupEnabled: boolean }>
  restart(): Promise<unknown>
  start(): Promise<unknown>
  stop(): Promise<unknown>
}
