-- Hasil akhir misi Lab.
--
-- Orchestrator sudah mengembalikan `final` — jawaban yang disintesis
-- dari seluruh langkah — tetapi tidak ada tempat menyimpannya: tabel
-- lab_missions hanya punya status, progress, dan rencana. Akibatnya
-- misi selesai dengan progress 100% sementara pemiliknya tidak punya
-- satu pun cara melihat apa yang dihasilkan; jawabannya hidup hanya
-- selama satu respons HTTP lalu hilang.
--
-- `result_at` dipisah dari updated_at supaya terlihat kapan hasil itu
-- benar-benar dibuat, bukan kapan barisnya terakhir disentuh.

ALTER TABLE lab_missions ADD COLUMN result TEXT;
ALTER TABLE lab_missions ADD COLUMN result_at TEXT;
