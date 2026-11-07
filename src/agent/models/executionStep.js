/**
 * Satu langkah dalam rencana eksekusi.
 *
 * Sebelumnya hanya membawa tool + argumen: cukup untuk dijalankan
 * berurutan sekali jalan, tetapi tidak cukup untuk tugas panjang.
 * Tanpa status, tidak ada yang tahu langkah mana yang sudah selesai
 * saat proses mati di tengah jalan; tanpa dependensi, langkah yang
 * sebenarnya bisa berjalan paralel dipaksa antre (§28, §29).
 *
 * Seluruh medan baru punya nilai bawaan, sehingga pemanggil lama
 * (`new ExecutionStep({ tool, arguments })`) tetap bekerja apa adanya.
 */

/** pending → running → done | failed | skipped */
const STATUS = ["pending", "running", "done", "failed", "skipped"];

class ExecutionStep {

  constructor({
    tool,
    arguments: args = {},
    id = null,
    metadata = {},

    // ---- Tambahan untuk DAG & pemulihan ----
    dependsOn = [],
    status = "pending",
    result = null,
    error = null,
    verification = null,
    startedAt = null,
    finishedAt = null,
    attempts = 0
  }) {

    this.id = id ?? crypto.randomUUID();
    this.tool = tool;
    this.arguments = args;
    this.metadata = metadata;

    /** Id langkah yang harus selesai lebih dulu. */
    this.dependsOn = Array.isArray(dependsOn) ? [...dependsOn] : [];

    this.status = STATUS.includes(status) ? status : "pending";
    this.result = result;
    this.error = error;

    /** Laporan Verification Engine (§46) — bukti, bukan klaim. */
    this.verification = verification;

    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
    this.attempts = attempts;

  }

  get isDone()      { return this.status === "done"; }
  get isTerminal()  { return this.status === "done" || this.status === "failed" || this.status === "skipped"; }

  /** Bentuk polos untuk disimpan ke checkpoint. */
  toJSON() {
    return {
      id: this.id,
      tool: this.tool,
      arguments: this.arguments,
      metadata: this.metadata,
      dependsOn: this.dependsOn,
      status: this.status,
      result: this.result,
      error: this.error,
      verification: this.verification,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      attempts: this.attempts
    };
  }

}

module.exports = ExecutionStep;
module.exports.STATUS = STATUS;
