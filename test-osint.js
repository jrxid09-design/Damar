const osint = require("./src/services/osintService");
const breach = require("./src/services/breachService");
const phoneIntel = require("./src/services/phoneIntelService");

async function main() {
    console.log("=== DAMAR OSINT TEST ===\n");

    // 1. Analisis email
    console.log("1. ANALISIS EMAIL: ronny.snex@gmail.com");
    try {
        const emailInfo = osint.analyzeEmail("ronny.snex@gmail.com");
        console.log("   Valid:", emailInfo.valid);
        console.log("   Domain:", emailInfo.domain);
        console.log("   Disposable:", emailInfo.isDisposable);
        console.log("   Free email:", emailInfo.isFree);
        console.log("   Corporate:", emailInfo.isCorporate);
        console.log("   Local part:", emailInfo.local);
        console.log("   Punya angka:", emailInfo.hasNumbers);
        console.log("   Punya titik:", emailInfo.hasDots);
    } catch (e) {
        console.log("   ERROR:", e.message);
    }

    // 2. Cek kebocoran email (gratis)
    console.log("\n2. CEK KEBOCORAN EMAIL (LeakCheck + ProxyNova)");
    try {
        const breachResult = await breach.check("ronny.snex@gmail.com");
        console.log("   Bocor:", breachResult.breached);
        console.log("   Jumlah sumber:", breachResult.sources.length);
        console.log("   Data terekspos:", breachResult.fields.join(", ") || "tidak ada");
        if (breachResult.sources.length > 0) {
            console.log("   Sumber:");
            for (const s of breachResult.sources.slice(0, 5)) {
                console.log("     -", s.name, "(" + (s.year ?? "?") + ")", "[" + (s.category ?? "?") + "]");
            }
        }
        if (breachResult.combos?.found) {
            console.log("   Combo list: DITEMUKAN", breachResult.combos.count, "entri");
        }
        console.log("   Saran:", breachResult.advice[0]);
    } catch (e) {
        console.log("   ERROR:", e.message);
    }

    // 3. Analisis telepon
    console.log("\n3. ANALISIS TELEPON: 081296497762");
    try {
        const phoneInfo = phoneIntel.analyze("081296497762");
        console.log("   Normalized:", phoneInfo.normalized);
        console.log("   Negara:", phoneInfo.country);
        console.log("   Kode negara:", phoneInfo.countryCode);
        console.log("   Carrier:", phoneInfo.carrier ?? "tidak dikenal");
        console.log("   Jenis line:", phoneInfo.lineType);
        console.log("   Panjang:", phoneInfo.length, "digit");
        console.log("   Skor penipuan:", phoneInfo.scamScore + "/100");
        console.log("   Level risiko:", phoneInfo.riskLevel);
        console.log("   Catatan:");
        for (const n of phoneInfo.scamNotes) {
            console.log("     -", n);
        }
    } catch (e) {
        console.log("   ERROR:", e.message);
    }

    // 4. Investigasi gabungan
    console.log("\n4. INVESTIGASI GABUNGAN (email + telepon)");
    try {
        const report = await osint.investigate({
            email: "ronny.snex@gmail.com",
            phone: "081296497762"
        });
        console.log("   Ringkasan:", report.summary);
        console.log("   Skor risiko:", report.riskScore + "/100");
        console.log("   Level:", report.riskLevel);
        console.log("   Seksi:", Object.keys(report.sections).join(", "));
        if (report.correlations.length > 0) {
            console.log("   Korelasi:");
            for (const c of report.correlations) {
                console.log("     -", c.detail);
            }
        }
        console.log("   Temuan:", report.findings.length);
    } catch (e) {
        console.log("   ERROR:", e.message);
    }

    console.log("\n=== SELESAI ===");
}

main().catch(console.error);
