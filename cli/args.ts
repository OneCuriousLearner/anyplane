/** `--no-open` 等 flag 不是子命令；裸 `anyplane --no-open` 仍走 start。 */
export function resolveCliCommand(argv: string[]): string {
  return (
    argv.find((a) => !a.startsWith('-')) ??
    (argv.includes('--help') || argv.includes('-h')
      ? 'help'
      : argv.includes('--version') || argv.includes('-v')
        ? 'version'
        : 'start')
  )
}
