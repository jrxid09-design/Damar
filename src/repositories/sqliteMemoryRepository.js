const db = require("../database");

class SQLiteMemoryRepository {
  get(sessionId) {
    return new Promise((resolve, reject) => {
      db.all(
        `
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY id ASC
        `,
        [sessionId],
        (err, rows) => {
          if (err) {
            return reject(err);
          }

          resolve(
            rows.map((row) => ({
              role: row.role,
              content: row.content,
              timestamp: row.created_at,
            }))
          );
        }
      );
    });
  }

  save(sessionId, message) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO messages (
        session_id,
        role,
        content
      )
      VALUES (?, ?, ?)
      `,
      [
        sessionId,
        message.role,
        message.content,
      ],
      function (err) {
        if (err) {
          return reject(err);
        }

        resolve();
      }
    );
  });
}

  clear(sessionId) {
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

  trim(sessionId, limit) {
    return new Promise((resolve, reject) => {
      db.run(
        `
        DELETE FROM messages
        WHERE id IN (
          SELECT id
          FROM messages
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT (
            SELECT CASE
              WHEN COUNT(*) > ? THEN COUNT(*) - ?
              ELSE 0
            END
            FROM messages
            WHERE session_id = ?
          )
        )
        `,
        [
          sessionId,
          limit,
          limit,
          sessionId,
        ],
        (err) => {
          if (err) {
            return reject(err);
          }

          resolve();
        }
      );
    });
  }
}

module.exports = new SQLiteMemoryRepository();