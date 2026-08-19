-- Provenance epistemik + masa berlaku (§13, §20, Konstitusi Pasal 6.3 & 7).
--
-- Skema sudah punya `source`, `confidence`, `valid_until`, dan
-- `superseded_by` — tetapi pemeriksaan pada basis data produksi
-- menunjukkan valid_until dan superseded_by TERISI 0 dari 9 memori.
-- Kolomnya ada, mekanismenya tidak pernah dipakai.
--
-- Yang benar-benar hilang:
--
--   1. KIND — Aether tidak dapat membedakan "yang saya lihat" dari
--      "yang saya simpulkan". Tanpa ini, dugaan dan pengamatan
--      punya bobot yang sama saat diambil kembali, dan Aether bisa
--      menyampaikan tebakannya sendiri sebagai fakta.
--
--   2. VALID_FROM — hanya ada valid_until, jadi masa berlaku sebuah
--      fakta tidak punya titik awal. Pertanyaan "apa yang benar pada
--      bulan lalu?" tidak dapat dijawab.
--
--   3. LAST_VERIFIED — tidak ada jejak kapan sebuah memori terakhir
--      dibuktikan masih benar.
--
-- Semuanya aditif; baris lama tetap valid tanpa penulisan ulang.

ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'observation';
-- fact | observation | inference | hypothesis | preference
-- | system_state | external
--
-- Default 'observation' dipilih sengaja: memori lama memang berasal
-- dari percakapan yang teramati, bukan kesimpulan Aether sendiri.
-- Menandainya 'fact' akan mengklaim kepastian yang tak pernah diuji.

ALTER TABLE memories ADD COLUMN valid_from TEXT;
-- Sejak kapan pernyataan ini benar. NULL = sejak dicatat.

ALTER TABLE memories ADD COLUMN last_verified TEXT;
-- Kapan terakhir dibuktikan masih benar. NULL = belum pernah.

ALTER TABLE memories ADD COLUMN supersedes INTEGER;
-- Kebalikan dari superseded_by, supaya rantai perubahan fakta dapat
-- ditelusuri dua arah tanpa pemindaian tabel.

CREATE INDEX IF NOT EXISTS idx_memories_kind        ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_superseded  ON memories(superseded_by);
