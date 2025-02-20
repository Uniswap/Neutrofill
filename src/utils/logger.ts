export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(...args: any[]): void {
    console.log(`[${this.context}]`, ...args);
  }

  error(...args: any[]): void {
    console.error(`[${this.context}] ERROR:`, ...args);
  }

  warn(...args: any[]): void {
    console.warn(`[${this.context}] WARNING:`, ...args);
  }

  debug(...args: any[]): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[${this.context}] DEBUG:`, ...args);
    }
  }
}
