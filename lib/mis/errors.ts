export class MisError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = code) {
    super(message);
    this.name = "MisError";
  }
}

export function isMisError(value: unknown): value is MisError {
  return value instanceof MisError;
}

export const misFail = (status: number, code: string, message = code): never => {
  throw new MisError(status, code, message);
};
