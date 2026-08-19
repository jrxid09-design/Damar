const { initialize, database } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * TestChamber — ruang verifikasi (§19).
 *
 * Misi yang masuk VERIFYING menjalankan test NYATA via tool code_test
 * yang terdaftar (runner test proyek Aether/terhubung). Tidak ada
 * hasil palsu: gagal runner = gagal, dan itu tercatat.
 */

class TestChamber {

    /**
     * Jalankan satu kategori test untuk project.
     * @param {object} opts { projectId, missionId, category }
     * categories: unit | integration | agent | tool | memory | ui | security | e2e
     */
    async run({ projectId, missionId = null, category = "unit" }) {

        const aiRuntime = require("../services/aiRuntimeService");

        await initialize();

        await activity.record({
            type: "test.started", projectId, missionId,
            payload: { category }
        });

        const project = await database.get("SELECT * FROM lab_projects WHERE id=?", [projectId]);

        // code_test = tool nyata di registry (runner test Aether).
        let result;
        let ok = false;

        try {

            const tools = aiRuntime.tools();
            const codeTest = tools.find(t => t.name === "code_test");

            if (!codeTest) {
                throw new Error("tool code_test tidak terdaftar di registry");
            }

            await activity.record({
                type: "tool.started", projectId, missionId, agentId: "forge",
                tool: "code_test", payload: { category }
            });

            result = await codeTest.execute({
                scope: project?.dir ?? undefined,
                filter: category === "unit" ? "tests/" : undefined
            });

            ok = result?.failed == null || Number(result?.failed ?? 0) === 0;

            await activity.record({
                type: "tool.completed", projectId, missionId, agentId: "forge",
                tool: "code_test", payload: { category, ok }
            });

        }
        catch (error) {

            await activity.record({
                type: "tool.failed", projectId, missionId, agentId: "forge",
                tool: "code_test", payload: { category, error: error.message }
            });

            await activity.record({
                type: "test.failed", projectId, missionId,
                payload: { category, error: error.message }
            });

            return { ok: false, category, error: error.message };

        }

        await activity.record({
            type: ok ? "test.passed" : "test.failed", projectId, missionId,
            payload: { category, summary: summarize(result) }
        });

        return { ok, category, result };

    }

    categories() {
        return ["unit", "integration", "agent", "tool", "memory", "ui", "security", "e2e"];
    }

}

function summarize(result) {
    const s = [];
    if (result?.total != null) s.push(`${result.total} total`);
    if (result?.passed != null) s.push(`${result.passed} lulus`);
    if (result?.failed != null) s.push(`${result.failed} gagal`);
    return s.join(", ") || "selesai";
}

module.exports = new TestChamber();
