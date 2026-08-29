const timestamp = () => {
  return new Date().toISOString();
};

/**
 * Setiap log juga diteruskan ke telemetryService supaya muncul
 * realtime di panel Logs milik Damar Console. Require-nya lazy
 * agar tidak terjadi siklus dependensi saat boot.
 */
const forward = (level, message) => {
  try {
    require("../services/telemetryService").log(level, String(message));
  } catch {
    // Telemetri bersifat opsional; jangan sampai logging gagal
    // hanya karena panel monitoring belum siap.
  }
};

module.exports = {
  info(message) {
    console.log(`[${timestamp()}] [INFO] ${message}`);
    forward("info", message);
  },

  warn(message) {
    console.warn(`[${timestamp()}] [WARN] ${message}`);
    forward("warn", message);
  },

  error(message) {
    console.error(`[${timestamp()}] [ERROR] ${message}`);
    forward("error", message);
  }
};
