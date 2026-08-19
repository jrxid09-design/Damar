const db = require("../database");

class SessionRepository {
  getAll() {
    return new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          session_id,
          MIN(created_at) AS started_at,
          MAX(created_at) AS updated_at,
          COUNT(*) AS message_count
        FROM messages
        GROUP BY session_id
        ORDER BY updated_at DESC
        `,
        [],
        (err, rows) => {
          if (err) {
            return reject(err);
          }

          resolve(rows);
        }
      );
    });
  }

  getMessages(sessionId) {
    return new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          role,
          content,
          created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY id ASC
        `,
        [sessionId],
        (err, rows) => {
          if (err) {
            return reject(err);
          }

          resolve(rows);
        }
      );
    });
  }

  delete(sessionId) {
    return new Promise((resolve, reject) => {
      db.run(
        `
        DELETE FROM messages
        WHERE session_id = ?
        `,
        [sessionId],
        (err) => {
          if (err) {
            return reject(err);
          }

          resolve();
        }
      );
    });
  }
  debug() {

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        id,
        session_id,
        role,
        content,
        created_at
      FROM messages
      ORDER BY id DESC
      `,
      [],
      (err, rows) => {
        if (err) {
          return reject(err);
        }


        resolve(rows);
      }
    );
  });
}
}

module.exports = new SessionRepository();