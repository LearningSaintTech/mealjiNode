export class AppError extends Error {
  /**
   * `expose`: whether production may show `message` to the user. Client errors (4xx) always do;
   * a 5xx only when it was written for the user ("Couldn't connect the call. Please try again.")
   * and passes `{ expose: true }`. Internal detail belongs in the logs, not in the message.
   */
  constructor(statusCode, message, errors = null, { expose = statusCode < 500 } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    this.expose = Boolean(expose);
    Error.captureStackTrace?.(this, AppError);
  }
}
