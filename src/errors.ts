export class TraceError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "TraceError";
    this.status = status;
  }
}
