export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, d) => new AppError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Sign in to continue') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have access to this action') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new AppError(404, 'not_found', m);
export const conflict = (m, d) => new AppError(409, 'conflict', m, d);
export const unprocessable = (m, d) => new AppError(422, 'unprocessable', m, d);
export const upstream = (m, d) => new AppError(502, 'upstream_error', m, d);

export function errorHandler(logger) {
  return (err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error({ err, path: req.path }, 'request failed');
    else logger.warn({ code: err.code, path: req.path, msg: err.message }, 'request rejected');
    res.status(status).json({
      error: {
        code: err.code || 'internal_error',
        message: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message,
        details: err.details,
        requestId: req.id
      }
    });
  };
}
