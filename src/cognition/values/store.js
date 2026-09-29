"use strict";

const PREFIX = "values:";

function makeValuesStore(acc) {
    async function getPreferences() {
        return (await acc.getKv(`${PREFIX}preferences`)) || [];
    }
    async function putPreference(pref) {
        const prefs = await getPreferences();
        const idx = prefs.findIndex(p => p.preferenceId === pref.preferenceId);
        if (idx >= 0) prefs[idx] = pref; else prefs.push(pref);
        await acc.putKv(`${PREFIX}preferences`, prefs);
    }
    async function getValues() {
        return (await acc.getKv(`${PREFIX}values`)) || [];
    }
    async function putValue(val) {
        const vals = await getValues();
        const idx = vals.findIndex(v => v.valueId === val.valueId);
        if (idx >= 0) vals[idx] = val; else vals.push(val);
        await acc.putKv(`${PREFIX}values`, vals);
    }
    async function getInferredTodayCount() {
        return (await acc.getKv(`${PREFIX}inferredToday`)) || 0;
    }
    async function incrementInferredToday() {
        const count = await getInferredTodayCount();
        await acc.putKv(`${PREFIX}inferredToday`, count + 1);
    }
    return { getPreferences, putPreference, getValues, putValue, getInferredTodayCount, incrementInferredToday };
}

module.exports = { makeValuesStore };
