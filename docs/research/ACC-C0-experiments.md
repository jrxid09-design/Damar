# ACC C0 — Experiments & Research Discipline

Semua eksperimen C0 berjalan di atas state murni (jam suntik, store memori)
atau store SQLite temporer. Tidak ada klaim berbasis prosa model.

| Eksperimen | Pertanyaan | Lokasi uji | Status |
|---|---|---|---|
| False-self injection (§56/§98) | Apakah klaim user menulis SELF_STATE? | `accEpistemics.test.js` | PENDING-GATE |
| Model hallucination (§99) | Apakah output model menjadi fakta? | idem | PENDING-GATE |
| Unknown event (§100) | Event asing memutasi state? | idem | PENDING-GATE |
| Hidden-state intervention (§57) | Perubahan internal terlihat pada witness? | `accWitnessMetaPrediction.test.js` + affect tests | PENDING-GATE |
| Prompt-variation control (§58) | State identik → representasi stabil? | witness determinisme (diff murni fungsi state) | PENDING-GATE |
| Restart continuity (§49) | Identitas & state selamat restart? | `accContinuity.test.js` | PENDING-GATE |
| Replay determinism (§101–§103) | H1 == H2; duplikat sekali? | idem | PENDING-GATE |
| Model-swap continuity (§54) | Ganti substrate tidak reset diri? | `accAutobiographySubstrateSecurity.test.js` | PENDING-GATE |
| Decay determinism (§104) | Peluruhan eksak per half-life? | `accAffectInteroception.test.js` | PENDING-GATE |
| Workspace storm (§105) | Bounded + yang penting menang? | `accWorkspace.test.js` | PENDING-GATE |
| Affect ≠ authority (§22) | Tekanan emosi maksimum tak mengubah izin? | idem + security boundary | PENDING-GATE |
| Zero-capability cognition (§97) | Kognisi internal tanpa disclosure/eksekusi? | idem | PENDING-GATE |
| Ablation (§59–§60) | Kontribusi kausal tiap modul? | switch lab di `CognitiveCore.ablation`; pengukuran menyusul setelah gate hijau | DESIGNED |

Metrik risiko (§62): vektor fungsional — Introspective Grounding, Identity
Continuity, Prompt Resistance, Prediction/Metacognitive Calibration,
Model-Swap/Restart Continuity, Ablation Dependence. Tidak ada
"consciousness score".

Hasil negatif wajib dicatat di laporan akhir; kegagalan ablasi
("tanpa efek terukur") dilaporkan apa adanya.
