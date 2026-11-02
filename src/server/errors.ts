export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new AppError(400, msg);
export const notFound = (msg = 'Nicht gefunden.') => new AppError(404, msg);
export const forbidden = (msg = 'Keine Berechtigung.') => new AppError(403, msg);
export const unauthorized = (msg = 'Bitte zuerst anmelden.') => new AppError(401, msg);
