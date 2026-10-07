export function sendSuccess(res, { status = 200, message, data = {} } = {}) {
  return res.status(status).json({
    success: true,
    message,
    data,
  });
}
