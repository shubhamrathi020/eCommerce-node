/** One JSON object per line on stdout (stderr for errors), like the other implementations of this API. */
export class Logger {
  constructor(private readonly context: string) {}

  private write(level: 'log' | 'warn' | 'error', message: string): void {
    const line = JSON.stringify({ time: new Date().toISOString(), level, logger: this.context, message });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  log(message: string): void {
    this.write('log', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }
}
