import * as p from "@clack/prompts";

export type Logger = (message: string) => void;

export function createLogger(verbose: boolean): Logger {
  return verbose ? (msg) => p.log.info(`[verbose] ${msg}`) : () => {};
}
