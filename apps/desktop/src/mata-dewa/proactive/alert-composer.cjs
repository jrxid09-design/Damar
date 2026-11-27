'use strict';
// Alert message composition (Fase 6). Messages are composed FROM the event's
// data - facts, lead time, source, and a short action suggestion - not from
// a fixed template copying anyone's example sentence. The salutation comes
// from the centralized user-profile config (presence.salutation, falling
// back to the display name); no form of address is baked into code.

function locationPhrase(location) {
  if (location.kind === 'gps') return 'posisi Anda' + (location.stale ? ' (berdasarkan posisi GPS terakhir, yang sudah agak lama)' : '');
  return (location.profile === 'asset' ? 'aset ' : 'titik pantau ') + location.label;
}
const hhmm = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? String(d.getHours()).padStart(2, '0') + '.' + String(d.getMinutes()).padStart(2, '0') : ''; };
const leadText = (min) => min >= 90 ? 'sekitar ' + Math.round(min / 60) + ' jam lagi' : min >= 15 ? 'sekitar ' + min + ' menit lagi' : 'dalam beberapa menit';

function composeMessage(signal, location, { salutation = '' } = {}) {
  const greet = salutation ? salutation + ', ' : '';
  const phrase = locationPhrase(location);
  const d = signal.data || {};
  if (signal.ruleId === 'quake-near') {
    return greet + 'gempa M' + d.magnitude + ' tercatat ' + d.distanceKm + ' km dari ' + phrase + (d.place ? ', ' + d.place : '') +
      ', kedalaman ' + d.depthKm + ' km, pukul ' + hhmm(d.time) + '. Sumber: ' + d.source + '. ' +
      (location.profile === 'asset' ? 'Periksa kondisi aset dan waspadai gempa susulan.' : 'Periksa kondisi sekitar dan waspadai gempa susulan.');
  }
  if (signal.ruleId === 'weather-storm') {
    const parts = [];
    if (d.thunder) parts.push('badai petir');
    if (Number.isFinite(d.precipitationMm)) parts.push('hujan lebat (±' + d.precipitationMm + ' mm/jam)');
    if (Number.isFinite(d.windKmh) && d.windKmh >= 40) parts.push('angin kencang (±' + d.windKmh + ' km/jam)');
    return greet + 'prediksi ' + (parts.join(' dan ') || 'cuaca buruk') + ' untuk ' + phrase + ' ' + leadText(d.leadMinutes) + ' (± pukul ' + hhmm(d.at) + '). Sumber: ' + d.source + '. ' +
      (location.profile === 'asset' ? 'Saran: waspadai aktivitas di sekitar aset dan risiko sambaran petir pada jam itu.' : 'Saran: siapkan antisipasi bila ada aktivitas di luar pada jam itu.');
  }
  if (signal.ruleId === 'bmkg-quake-near') {
    return greet + 'gempa M' + d.magnitude + ' tercatat ' + d.distanceKm + ' km dari ' + phrase + (d.place ? ', ' + d.place : '') +
      ', kedalaman ' + d.depthKm + ' km, pukul ' + hhmm(d.time) + '. Sumber: BMKG. ' +
      (location.profile === 'asset' ? 'Periksa kondisi aset dan waspadai gempa susulan.' : 'Periksa kondisi sekitar dan waspadai gempa susulan.');
  }
  if (signal.ruleId === 'tsunami-relay') {
    // BMKG's wording is relayed verbatim (in quotes) with attribution;
    // DAMAR adds only localization and a safety suggestion.
    return greet + 'peringatan resmi BMKG: gempa M' + d.magnitude + ' ' + d.distanceKm + ' km dari ' + phrase + (d.place ? ', ' + d.place : '') +
      ', pukul ' + hhmm(d.time) + '. BMKG menyatakan: "' + d.potensi + '". Sumber: BMKG. ' +
      'Saran: menjauhi pantai dan pesisir sampai ada pembaruan resmi dari BMKG.';
  }
  if (signal.ruleId === 'bmkg-extreme-weather') {
    return greet + 'BMKG memprakirakan ' + (d.weatherDesc || 'cuaca ekstrem') + ' untuk ' + phrase + ' ' + leadText(d.leadMinutes) +
      ' (± pukul ' + hhmm(d.at) + '). Sumber: BMKG. ' +
      (location.profile === 'asset' ? 'Saran: waspadai aktivitas di sekitar aset dan risiko sambaran petir pada jam itu.' : 'Saran: siapkan antisipasi bila ada aktivitas di luar pada jam itu.');
  }
  if (signal.ruleId === 'volcano-status') {
    return greet + 'status gunung ' + d.volcano + ' berada pada Level ' + d.level + (d.levelLabel ? ' (' + d.levelLabel + ')' : '') +
      ', ' + d.distanceKm + ' km dari ' + phrase + '. Sumber: ' + d.source + '. ' +
      'Saran: ikuti rekomendasi PVMBG dan hindari zona bahaya di sekitar gunung tersebut.';
  }
  if (signal.ruleId === 'fire-near') {
    return greet + 'hotspot kebakaran terdeteksi ' + d.distanceKm + ' km dari ' + phrase + (Number.isFinite(d.frp) ? ' (FRP ' + d.frp + ')' : '') +
      '. Sumber: ' + d.source + '. Saran: verifikasi kondisi lapangan di sekitar titik tersebut.';
  }
  if (signal.ruleId === 'imagery-observation') {
    return 'Observasi citra: citra satelit baru (' + d.source + ', ' + String(d.datetime).slice(0, 10) + (Number.isFinite(d.cloudCoverPct) ? ', tutupan awan ' + d.cloudCoverPct + '%' : '') +
      ') tercatat untuk ' + phrase + '. Ini catatan observasi berkala, bukan klaim perubahan atau kerusakan.';
  }
  return greet + 'sinyal ' + signal.ruleId + ' untuk ' + phrase + '. Sumber: ' + (d.source || 'Mata Dewa') + '.';
}

module.exports = { composeMessage, locationPhrase };
