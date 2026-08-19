module.exports = {
  success(res, message, data = {}, statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  },

  error(res, message, statusCode = 500, error = null) {
    return res.status(statusCode).json({
      success: false,
      message,
      error,
    });
  },
};