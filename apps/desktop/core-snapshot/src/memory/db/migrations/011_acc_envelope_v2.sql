-- ACC envelope v2 (Wave7 shared prerequisite).
--
-- Menambah dua kolom NULLABLE, tanpa DEFAULT, pada acc_event_journal.
-- Baris lama tetap NULL di kedua kolom => dibaca sebagai v1 legacy oleh
-- normalizeEnvelopeRecord() (src/cognition/core/envelope.js), yang
-- menormalisasi konservatif ke epistemicClass UNKNOWN. Tidak ada baris
-- jurnal historis yang ditulis ulang; forward-only.

ALTER TABLE acc_event_journal ADD COLUMN schema_version INTEGER;
ALTER TABLE acc_event_journal ADD COLUMN epistemic_class TEXT;
