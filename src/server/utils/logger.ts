import chalk from "chalk";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogMetadata = Record<string, unknown> | Error | unknown;

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMetadata(
    metadata?: LogMetadata
  ): Record<string, unknown> | undefined {
    if (!metadata) return undefined;

    if (metadata instanceof Error) {
      return {
        name: metadata.name,
        message: metadata.message,
        stack: metadata.stack,
      };
    }

    if (typeof metadata === "object" && metadata !== null) {
      return metadata as Record<string, unknown>;
    }

    return { value: metadata };
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    metadata?: LogMetadata
  ): string {
    const timestamp = new Date().toISOString();
    const formattedMetadata = metadata
      ? ` ${JSON.stringify(this.formatMetadata(metadata))}`
      : "";
    return `${timestamp} [${level.toUpperCase()}] [${this.context}] ${message}${formattedMetadata}`;
  }

  private logWithColor(color: chalk.Chalk, message: string): void {
    console.log(color(message));
  }

  private log(level: LogLevel, message: string, metadata?: LogMetadata): void {
    const formattedMessage = this.formatMessage(level, message, metadata);
    switch (level) {
      case "debug":
        this.logWithColor(chalk.gray, formattedMessage);
        break;
      case "info":
        this.logWithColor(chalk.blue, formattedMessage);
        break;
      case "warn":
        this.logWithColor(chalk.yellow, formattedMessage);
        break;
      case "error":
        this.logWithColor(chalk.red, formattedMessage);
        break;
    }
  }

  public debug(message: string, metadata?: LogMetadata): void {
    if (process.env.NODE_ENV !== "production") {
      this.log("debug", message, metadata);
    }
  }

  public info(message: string, metadata?: LogMetadata): void {
    this.log("info", message, metadata);
  }

  public warn(message: string, metadata?: LogMetadata): void {
    this.log("warn", message, metadata);
  }

  public error(message: string, metadata?: LogMetadata): void {
    this.log("error", message, metadata);
  }
}
