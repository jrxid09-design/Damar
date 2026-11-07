const ExecutionStep = require("./executionStep");

/**
 * Rencana eksekusi sebagai GRAF, bukan daftar (§28).
 *
 * Daftar datar memaksa segalanya berurutan dan tidak menyimpan
 * kemajuan. Dengan dependensi eksplisit, langkah yang tidak saling
 * bergantung dapat berjalan bersamaan, dan yang sudah selesai tidak
 * perlu diulang setelah proses mati (§29, §30).
 *
 * Konstruktor lama `new ExecutionPlan({ thought, steps })` tetap
 * bekerja; tanpa `dependsOn`, seluruh langkah menjadi siap sekaligus
 * — persis perilaku sebelumnya.
 */
class ExecutionPlan {

  constructor({
    thought = "",
    steps = [],
    id = null,
    goal = "",
    createdAt = null,
    updatedAt = null
  } = {}) {

    this.id = id ?? crypto.randomUUID();
    this.goal = goal;
    this.thought = thought;

    this.steps = steps.map(step =>
      step instanceof ExecutionStep
        ? step
        : new ExecutionStep(step)
    );

    this.createdAt = createdAt ?? new Date().toISOString();
    this.updatedAt = updatedAt ?? this.createdAt;

  }

  addStep(step) {
    this.steps.push(
      step instanceof ExecutionStep
        ? step
        : new ExecutionStep(step)
    );
    return this.steps[this.steps.length - 1];
  }

  get hasSteps() {
    return this.steps.length > 0;
  }

  get(id) {
    return this.steps.find(s => s.id === id) ?? null;
  }

  /**
   * Langkah yang SIAP dijalankan: masih pending dan seluruh
   * dependensinya sudah selesai.
   *
   * Dependensi yang gagal tidak membuat langkah ini siap — ia akan
   * menggantung, dan itu disengaja: melanjutkan di atas fondasi yang
   * gagal menghasilkan pekerjaan yang tidak dapat dipercaya.
   */
  ready() {
    return this.steps.filter(step =>
      step.status === "pending" &&
      step.dependsOn.every(id => this.get(id)?.isDone === true)
    );
  }

  /** Langkah yang tak akan pernah siap karena dependensinya gagal. */
  blocked() {
    return this.steps.filter(step =>
      step.status === "pending" &&
      step.dependsOn.some(id => {
        const dep = this.get(id);
        return !dep || dep.status === "failed" || dep.status === "skipped";
      })
    );
  }

  get isComplete() {
    return this.steps.every(s => s.isTerminal);
  }

  get progress() {

    const total = this.steps.length;
    const done = this.steps.filter(s => s.status === "done").length;
    const failed = this.steps.filter(s => s.status === "failed").length;

    return {
      total,
      done,
      failed,
      pending: this.steps.filter(s => s.status === "pending").length,
      running: this.steps.filter(s => s.status === "running").length,
      percent: total ? Math.round((done / total) * 100) : 0
    };

  }

  /**
   * Cari siklus dependensi.
   *
   * Rencana yang melingkar tidak akan pernah punya langkah siap —
   * tanpa pemeriksaan ini gejalanya adalah "tugas menggantung tanpa
   * sebab", yang jauh lebih sulit didiagnosis daripada penolakan
   * langsung saat rencana dibuat.
   *
   * @returns {string[]} id langkah yang terlibat siklus; kosong bila sehat
   */
  findCycles() {

    const visiting = new Set();
    const visited = new Set();
    const cycles = new Set();

    const walk = (id, trail) => {

      if (visiting.has(id)) {
        // Semua yang ada di jejak sejak kemunculan pertama = siklus.
        const from = trail.indexOf(id);
        trail.slice(from).forEach(s => cycles.add(s));
        return;
      }

      if (visited.has(id)) return;

      visiting.add(id);

      for (const dep of this.get(id)?.dependsOn ?? []) {
        if (this.get(dep)) walk(dep, [...trail, id]);
      }

      visiting.delete(id);
      visited.add(id);

    };

    for (const step of this.steps) walk(step.id, []);

    return [...cycles];

  }

  /** Dependensi yang menunjuk langkah tak dikenal. */
  danglingDependencies() {

    const out = [];

    for (const step of this.steps) {
      for (const dep of step.dependsOn) {
        if (!this.get(dep)) out.push({ step: step.id, missing: dep });
      }
    }

    return out;

  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      thought: this.thought,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      steps: this.steps.map(s => s.toJSON())
    };
  }

}

module.exports = ExecutionPlan;
