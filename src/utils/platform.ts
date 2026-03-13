const platform = (window as any).electronAPI?.getPlatform?.() ?? 'darwin'

export const isWindows = platform === 'win32'
export const isMac = platform === 'darwin'

export function pathBasename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath
}
