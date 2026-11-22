"use strict";

const REPORT_SCHEMA_VERSION = "mission.report.v1";

function makeReport(store) {
    async function add(missionId, content) {
        const id = `rep:${missionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const record = {
            schemaVersion: REPORT_SCHEMA_VERSION,
            reportId: id, missionId, content, createdAt: Date.now(),
        };
        await store.putKv(`report:${id}`, record);
        await store.addToIndex(`reports:${missionId}`, id);
        return record;
    }
    async function list(missionId) {
        const ids = await store.getIndex(`reports:${missionId}`);
        const records = await Promise.all(ids.map(id => store.getKv(`report:${id}`)));
        return records.filter(Boolean);
    }
    return { add, list };
}

module.exports = { makeReport };
