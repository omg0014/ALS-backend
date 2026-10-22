export class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details)
export const notFound = (what = 'Not found') => new HttpError(404, what)
export const forbidden = (msg = 'Not allowed for your role') => new HttpError(403, msg)
export const conflict = (msg) => new HttpError(409, msg)

export function errorHandler(err, req, res, _next) {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: Object.values(err.errors).map((e) => e.message) })
  }
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` })
  if (err.code === 11000) return res.status(409).json({ error: 'Already exists', details: err.keyValue })
  const status = err.status || 500
  if (status >= 500) console.error('[api]', err)
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, details: err.details })
}
