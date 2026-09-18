import { badRequest } from '../lib/errors.js';

export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    return next(badRequest('Check the highlighted fields and try again', parsed.error.flatten()));
  }
  req[source] = parsed.data;
  next();
};
