/* Overhead UAS Pilot Portal – Mission Planning (OVH-208)
 * Map (Esri imagery / OpenStreetMap via Leaflet), address search (Nominatim),
 * FAA airspace, LAANC grid, airports, special use airspace (FAA ArcGIS open data),
 * TFRs + METAR/TAF + Kp (fetched by the Overhead UAS Google script),
 * NWS observations, Open-Meteo hourly forecast with winds aloft, sun times,
 * automatic risk score (OVH-205 rules), and a kneeboard pack (OVH-201 + OVH-205).
 * A planning aid only: pilots must still verify with B4UFLY / a LAANC provider.
 */
(function () {
  'use strict';
  const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
  const L_CLASS = FAA + 'Class_Airspace/FeatureServer/0';
  const L_SUA = FAA + 'Special_Use_Airspace/FeatureServer/0';
  const L_GRID = FAA + 'FAA_UAS_FacilityMap_Data_V5/FeatureServer/0';
  const L_APT = FAA + 'US_Airport/FeatureServer/0';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const RANK = {B: 4, C: 3, D: 2, E: 1};
  const FACTORS = [
    {g: 'f1', name: 'Wind / gusts', auto: true, hard: true}, {g: 'f2', name: 'Visibility / ceiling', auto: true, hard: true},
    {g: 'f3', name: 'Precipitation / temp', auto: true, hard: true}, {g: 'f4', name: 'Airspace', auto: true, hard: true},
    {g: 'f5', name: 'Obstacles & wires', opts: ['Few', 'Some', 'Many / close']}, {g: 'f6', name: 'People & traffic', opts: ['None', 'Controlled', 'Crowds / roads']},
    {g: 'f7', name: 'Launch / landing area', opts: ['Open & clear', 'Tight', 'Poor / unstable']}, {g: 'f8', name: 'Pilot (IMSAFE)', opts: ['Rested, fit', 'Tired / rushed', 'Not fit'], hard: true},
    {g: 'f9', name: 'Aircraft & batteries', aircraft: true, opts: ['Airworthy', 'Minor issue', 'Unresolved issue']}, {g: 'f10', name: 'Mission complexity', auto: true}];
  const LV = ['', 'Low', 'Medium', 'High'], LVC = ['', 'green', 'amber', 'red'];

  // ---------------- helpers ----------------
  const rad = Math.PI / 180;
  function distMi(a, b, c, d) { const R = 3958.8, dLat = (c - a) * rad, dLon = (d - b) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  function bearing(a, b, c, d) { const y = Math.sin((d - b) * rad) * Math.cos(c * rad), x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad);
    const deg = (Math.atan2(y, x) / rad + 360) % 360; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]; }
  async function getJSON(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (j && j.error && typeof j.error !== 'boolean') throw new Error(j.error.message || j.reason || 'service error'); return j; }
  const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  function arcgis(layer, p) { return getJSON(layer + '/query?' + qs(Object.assign({f: 'json', outFields: '*', returnGeometry: false, inSR: 4326, outSR: 4326}, p))); }
  function arcPoint(layer, lat, lon, extra) { return arcgis(layer, Object.assign({geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects'}, extra || {})); }
  function arcBox(layer, lat, lon, d, extra) { return getJSON(layer + '/query?' + qs(Object.assign({f: 'geojson', outFields: '*', returnGeometry: true, inSR: 4326, outSR: 4326,
    geometry: [lon - d, lat - d, lon + d, lat + d].join(','), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', geometryPrecision: 5}, extra || {}))); }
  const pick = (o, re) => { for (const k of Object.keys(o || {})) if (re.test(k) && o[k] !== null && o[k] !== '') return o[k]; return ''; };
  const altTxt = (v, u, c) => (v === null || v === undefined || v === '') ? '' : (String(c || '').toUpperCase() === 'SFC' || (+v === 0 && !c) ? 'SFC' : `${v} ${u || 'ft'} ${c || ''}`.trim());
  const r0 = x => x === null || x === undefined || isNaN(x) ? null : Math.round(x);

  // Sun times (SunCalc formulas)
  function sunTimes(date, lat, lng) {
    const dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397, J0 = 0.0009;
    const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000, fromJ = j => new Date((j + 0.5 - J1970) * dayMs);
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), n = Math.round(d - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n, M = rad * (357.5291 + 0.98560028 * ds);
    const Lc = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(e) * Math.sin(Lc)), Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * Lc);
    const at = h => { const w = Math.acos((Math.sin(h * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
      const Jset = J2000 + (J0 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * Lc); return [fromJ(Jnoon - (Jset - Jnoon)), fromJ(Jset)]; };
    const [sunrise, sunset] = at(-0.833), [dawn, dusk] = at(-6);
    return {sunrise, sunset, dawn, dusk};
  }

  // Weather → risk levels (OVH-205 thresholds)
  const windLevel = kt => kt === null ? 0 : kt < 10 ? 1 : kt <= 20 ? 2 : 3;
  const visLevel = (sm, low) => sm === null ? 0 : (sm < 3 ? 3 : (sm < 5 || (low !== null && low >= 70)) ? 2 : 1);
  const wxLevel = (pop, t) => { if (pop === null && t === null) return 0; let l = 1;
    if ((pop !== null && pop >= 25) || (t !== null && (t < 40 || t > 95))) l = 2;
    if ((pop !== null && pop >= 60) || (t !== null && (t < 32 || t > 105))) l = 3; return l; };

  window.OUAS_PLANNER = {mount};

  function mount(root, X) {
    if (root._planner) { root._planner.map.invalidateSize(); if (root._planner.sync) root._planner.sync(); return; }
    const esc = X.esc;
    const S = {lat: null, lon: null, address: '', tz: undefined, brief: null, manual: {}, aircraft: null};
    root.innerHTML = `
      <div class="view-head"><a href="#" class="back-btn">&lsaquo; Portal</a><h2>Mission Planning</h2></div>
      <div id="plBanner"></div>
      <div class="pcard plan-card">
        <div class="plan-search"><input type="search" id="plSearch" placeholder="Search an address or place" autocomplete="off">
          <button class="btn btn-primary sm" id="plGo">Search</button><button class="btn btn-ghost sm" id="plMe" title="Use my location">&#9678; Me</button></div>
        <div class="plan-results" id="plResults" hidden></div>
        <div id="plMap" class="plan-map"></div>
        <p class="note">Tap or click the map to drop a pin. Toggle satellite / streets and FAA layers with the layer button.</p>
        <div class="grid2 plan-inputs">
          <div class="wide"><label>Mission</label><input type="text" id="plMission" placeholder="e.g. Smith Realty listing shoot"></div>
          <div><label>Flight date</label><input type="date" id="plDate"></div><div><label>Start time</label><input type="time" id="plTime" value="10:00"></div>
          <div><label>Planned end time</label><input type="time" id="plEnd" value="11:00"></div>
          <div><label>Flight radius</label><select id="plRadius"><option value="200">200 ft</option><option value="400" selected>400 ft</option><option value="800">800 ft</option><option value="1500">1,500 ft</option><option value="2640">0.5 mi</option></select></div>
          <div><label>Max altitude (ft AGL)</label><input type="number" id="plAlt" value="400" min="0" max="400" step="10" inputmode="numeric"></div>
          <div><label>Aircraft</label><select id="plAc"><option value="">Select aircraft…</option></select></div>
          <label class="remember wide"><input type="checkbox" id="plLong">SKYHOOK long-line / payload drop on this mission</label>
        </div>
      </div>
      <div id="plBrief"></div>
      <div id="plRisk"></div>
      <div class="pcard" id="plNotesCard" hidden>
        <h4>Hazards &amp; notes</h4>
        <p class="note">Add anything you see on the satellite map or know about the site: trees, power lines, towers, roads, people, launch / landing spot.</p>
        <textarea id="plNotes" rows="3" placeholder="e.g. Power lines along the street on the south side. Launch from the driveway."></textarea>
        <h4>Mitigations / crew briefing</h4>
        <textarea id="plMit" rows="2" placeholder="Required for every HIGH rating, e.g. VO watches the road, launch from the driveway"></textarea>
        <div class="fill-actions">
          <button class="btn btn-primary" id="plKnee">Kneeboard pack: Mission Sheet + Risk Assessment</button>
          <button class="btn btn-ghost" id="plPdf">Full mission plan (PDF)</button>
          <button class="btn btn-ghost" id="plSend">Send to online forms to sign</button>
        </div>
        <p class="plan-msg" id="plMsg"></p>
        <p class="note">Planning aid only. Always verify airspace and TFRs with B4UFLY or an FAA-approved LAANC app (e.g. Aloft) and get LAANC authorization before flying in controlled airspace.</p>
      </div>`;
    const $ = id => root.querySelector('#' + id);
    const today = new Date(); $('plDate').value = new Date(today - today.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const am0 = X.activeMission && X.activeMission();
    if (am0) { $('plMission').value = am0.name || ''; const md = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(am0.date || ''); if (md) $('plDate').value = `${md[3]}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
      if (am0.location) $('plSearch').value = am0.location; }

    // ---- map
    const sat = L.tileLayer(ESRI, {maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'});
    const streets = L.tileLayer(OSM, {maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'});
    const airLayer = L.layerGroup(), gridLayer = L.layerGroup(), tfrLayer = L.layerGroup();
    const map = L.map($('plMap'), {layers: [sat, airLayer, gridLayer, tfrLayer], zoomControl: true}).setView([33.1581, -117.3506], 11);
    L.control.layers({'Satellite': sat, 'Streets': streets}, {'Airspace boundaries': airLayer, 'LAANC grid ceilings': gridLayer, 'TFRs': tfrLayer}, {collapsed: true}).addTo(map);
    L.control.scale({imperial: true, metric: false}).addTo(map);
    let pin = null, ring = null;
    root._planner = {map, sync() {   // switching to a different active mission refills the mission fields
      const am = X.activeMission && X.activeMission(); if (!am || am.id === S.missionId) return; S.missionId = am.id;
      $('plMission').value = am.name || ''; const md = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(am.date || ''); if (md) $('plDate').value = `${md[3]}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
      if (am.location) $('plSearch').value = am.location; }};
    S.missionId = am0 ? am0.id : null;
    setTimeout(() => map.invalidateSize(), 50);

    function setPin(lat, lon, label, zoom) {
      S.lat = +(+lat).toFixed(6); S.lon = +(+lon).toFixed(6);
      if (!pin) { pin = L.marker([S.lat, S.lon], {draggable: true}).addTo(map); pin.on('dragend', e => { const p = e.target.getLatLng(); setPin(p.lat, p.lng); }); }
      else pin.setLatLng([S.lat, S.lon]);
      if (ring) ring.remove();
      ring = L.circle([S.lat, S.lon], {radius: +$('plRadius').value * 0.3048, color: '#c8102e', weight: 2, fillOpacity: 0.08}).addTo(map);
      map.setView([S.lat, S.lon], zoom || Math.max(map.getZoom(), 15));
      if (label) S.address = label; else { S.address = ''; reverse(S.lat, S.lon); }
      briefing();
    }
    map.on('click', e => setPin(e.latlng.lat, e.latlng.lng));
    $('plRadius').onchange = () => { if (ring) ring.setRadius(+$('plRadius').value * 0.3048); };
    const redraw = () => { if (S.brief && !S.brief.loading) { drawBrief(); drawRisk(); } };
    $('plDate').onchange = $('plTime').onchange = $('plAlt').onchange = $('plLong').onchange = $('plEnd').onchange = redraw;

    // ---- aircraft list (company aircraft from the maintenance log + the pilot's registered drones)
    const acList = [];
    (async () => {
      const sel = $('plAc');
      (X.mydocs || []).filter(d => d.type === 'Drone registration').forEach(d => acList.push({kind: 'mine', label: (d.aircraft || 'Drone') + (d.reg ? ' (' + d.reg + ')' : ''), reg: d.reg, model: d.aircraft}));
      if (X.submit && X.submit.url) {
        try { const r = await (await fetch(X.submit.url, {method: 'POST', body: JSON.stringify({token: X.submit.token, action: 'aircraft.list'})})).json();
          (r.aircraft || []).forEach(a => acList.push({kind: 'co', id: a.id, label: [a.nickname, a.model].filter(Boolean).join(' – ') + (a.reg ? ' (' + a.reg + ')' : ''), reg: a.reg, model: a.model, nickname: a.nickname})); } catch (e) {}
      }
      sel.innerHTML = '<option value="">Select aircraft…</option>' + acList.map((a, i) => `<option value="${i}">${esc(a.label)}${a.kind === 'mine' ? ' · my drone' : ''}</option>`).join('') + '<option value="other">Other / not listed</option>';
    })();
    $('plAc').onchange = async () => {
      const v = $('plAc').value; S.aircraft = v === '' ? null : v === 'other' ? {label: 'Other aircraft', status: null} : Object.assign({}, acList[+v], {status: 'checking'});
      delete S.manual.f9; drawRisk();
      const a = S.aircraft;
      if (a && a.kind === 'co' && X.submit && X.submit.url) {
        try { const r = await (await fetch(X.submit.url, {method: 'POST', body: JSON.stringify({token: X.submit.token, action: 'maint.history', aircraftId: a.id})})).json();
          const es = (r.entries || []).slice().sort((p, q) => new Date(q['Entry date']) - new Date(p['Entry date']));
          const last = es[0], insp = es.find(e => /inspection/i.test(e['Entry type']));
          a.lastResult = last ? last['Result'] : ''; a.lastDate = last ? last['Entry date'] : ''; a.inspDate = insp ? insp['Entry date'] : '';
          const days = a.inspDate ? Math.floor((Date.now() - new Date(a.inspDate)) / 864e5) : null;
          a.level = a.lastResult === 'GROUNDED' ? 3 : (days === null || days > 35) ? 2 : 1;
          a.why = a.lastResult === 'GROUNDED' ? `GROUNDED (last entry ${a.lastDate})` : days === null ? 'No monthly inspection on record' : days > 35 ? `Last inspection ${a.inspDate} (${days} days ago – overdue)` : `Airworthy · inspected ${a.inspDate}`;
        } catch (e) { a.level = 0; a.why = 'Could not check the maintenance log'; }
        a.status = 'done';
      } else if (a) { a.status = 'done'; a.level = 0; a.why = a.kind === 'mine' ? 'Your drone: rate its condition' : 'Rate the aircraft condition'; }
      if (S.aircraft === a) drawRisk();
    };

    // ---- search
    async function search() {
      const q = $('plSearch').value.trim(); if (!q) return;
      const box = $('plResults'); box.hidden = false; box.innerHTML = '<p class="note">Searching…</p>';
      try {
        const r = await getJSON('https://nominatim.openstreetmap.org/search?' + qs({format: 'jsonv2', limit: 5, countrycodes: 'us', q}));
        if (!r.length) { box.innerHTML = '<p class="note">No matches. Try a fuller address, or tap the map.</p>'; return; }
        box.innerHTML = r.map((x, i) => `<button class="plan-hit" data-i="${i}">${esc(x.display_name)}</button>`).join('');
        box.querySelectorAll('.plan-hit').forEach(b => b.onclick = () => { const x = r[+b.dataset.i]; box.hidden = true; setPin(x.lat, x.lon, x.display_name, 17); });
      } catch (e) { box.innerHTML = `<p class="note">Search isn't available right now (${esc(e.message)}). Tap the map instead.</p>`; }
    }
    $('plGo').onclick = search; $('plSearch').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    $('plMe').onclick = () => { if (!navigator.geolocation) return alert('Location is not available on this device.');
      navigator.geolocation.getCurrentPosition(p => setPin(p.coords.latitude, p.coords.longitude, null, 17), () => alert('Could not get your location. Check location permissions.'), {enableHighAccuracy: true, timeout: 10000}); };
    async function reverse(lat, lon) {
      try { const r = await getJSON('https://nominatim.openstreetmap.org/reverse?' + qs({format: 'jsonv2', lat, lon, zoom: 18}));
        if (S.lat === lat && S.lon === lon) { S.address = r.display_name || ''; drawBrief(); } } catch (e) {}
    }

    // ---- briefing data
    const script = (action, body) => X.submit && X.submit.url
      ? fetch(X.submit.url, {method: 'POST', body: JSON.stringify(Object.assign({token: X.submit.token, action}, body))}).then(r => r.json()).then(j => { if (!j.ok) throw new Error(j.error || action + ' failed'); return j; })
      : Promise.reject(new Error('not connected'));
    async function briefing() {
      const lat = S.lat, lon = S.lon;
      S.brief = {loading: true}; S.manual = Object.fromEntries(Object.entries(S.manual).filter(([k]) => ['f5', 'f6', 'f7', 'f8', 'f9'].includes(k)));
      $('plNotesCard').hidden = false; drawBrief(); drawRisk();
      const B = {lat, lon};
      const wx = nws(lat, lon);
      const jobs = {
        grid: arcPoint(L_GRID, lat, lon).then(r => r.features.map(f => f.attributes)),
        cls: arcPoint(L_CLASS, lat, lon).then(r => r.features.map(f => f.attributes)),
        sua: arcgis(L_SUA, {geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', distance: 3, units: 'esriSRUnit_StatuteMile'}).then(r => r.features.map(f => f.attributes)),
        apt: arcgis(L_APT, {geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', distance: 5, units: 'esriSRUnit_StatuteMile', returnGeometry: true}).then(r => r.features),
        tfr: script('plan.tfr', {lat, lon, miles: 30}).then(j => j.tfrs),
        wx,
        om: getJSON('https://api.open-meteo.com/v1/forecast?' + qs({latitude: lat.toFixed(4), longitude: lon.toFixed(4), forecast_days: 7, timezone: 'auto',
          wind_speed_unit: 'kn', temperature_unit: 'fahrenheit', precipitation_unit: 'inch',
          hourly: 'temperature_2m,precipitation_probability,weather_code,cloud_cover_low,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_speed_120m,wind_direction_120m'})),
        avwx: wx.catch(() => null).then(w => script('plan.wx', {lat, lon, station: w && w.obs ? w.obs.station : ''}))
      };
      const keys = Object.keys(jobs), res = await Promise.allSettled(Object.values(jobs));
      if (S.lat !== lat || S.lon !== lon) return;
      keys.forEach((k, i) => { B[k] = res[i].status === 'fulfilled' ? res[i].value : null; B[k + 'Err'] = res[i].status === 'rejected' ? (res[i].reason && res[i].reason.message) || 'unavailable' : ''; });
      S.brief = B; S.tz = (B.om && B.om.timezone) || (B.wx && B.wx.tz);
      drawBrief(); drawRisk(); drawOverlays(lat, lon);
    }
    async function nws(lat, lon) {
      const H = {headers: {Accept: 'application/geo+json'}};
      const pt = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, H);
      const P = pt.properties, out = {tz: P.timeZone, place: P.relativeLocation && P.relativeLocation.properties ? P.relativeLocation.properties.city + ', ' + P.relativeLocation.properties.state : ''};
      try { const st = await getJSON(P.observationStations, H); const id = st.features[0].properties.stationIdentifier;
        const o = await getJSON(`https://api.weather.gov/stations/${id}/observations/latest`, H); out.obs = Object.assign({station: id}, o.properties); } catch (e) { out.obs = null; }
      return out;
    }

    // ---- time helpers (location's time zone)
    const fmtT = d => d && !isNaN(d) ? d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: S.tz}) : '–';
    const hhmm = d => d && !isNaN(d) ? d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: S.tz}) : '';
    const ampm = t => { const m = /^(\d{2}):(\d{2})/.exec(t || ''); if (!m) return t || ''; const h = +m[1]; return `${(h % 12) || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
    const planDate = () => new Date(($('plDate').value || '') + 'T' + ($('plTime').value || '10:00') + ':00');
    function hourly(dateStr, hour) {      // Open-Meteo hour (local times like 2026-11-20T10:00)
      const O = S.brief && S.brief.om && S.brief.om.hourly; if (!O) return null;
      const key = `${dateStr}T${String(hour).padStart(2, '0')}:00`, i = O.time.indexOf(key); if (i < 0) return null;
      const g = k => (O[k] || [])[i];
      const w10 = g('wind_speed_10m'), w80 = g('wind_speed_80m'), w120 = g('wind_speed_120m'), gust = g('wind_gusts_10m');
      return {time: key, temp: r0(g('temperature_2m')), pop: r0(g('precipitation_probability')), code: g('weather_code'), low: r0(g('cloud_cover_low')),
        vis: g('visibility') === null || g('visibility') === undefined ? null : Math.round(g('visibility') / 1609.34 * 10) / 10,
        w10: r0(w10), w80: r0(w80), w120: r0(w120), gust: r0(gust), dir: g('wind_direction_120m') ?? g('wind_direction_10m')};
    }
    const dirTxt = d => d === null || d === undefined ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
    const WMO = c => c === null || c === undefined ? '' : c === 0 ? 'Clear' : c <= 3 ? ['Mostly clear', 'Partly cloudy', 'Overcast'][c - 1] : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorms';
    const flightWind = h => h ? Math.max(...[h.w10, h.w80, h.w120, h.gust].filter(x => x !== null && x !== undefined)) : null;
    const altWind = h => { if (!h) return null; const a = +$('plAlt').value || 400; return a <= 50 ? h.w10 : a <= 300 ? h.w80 : h.w120; };

    function summarize() {
      const B = S.brief || {}, grid = B.grid || [], cls = B.cls || [];
      const surface = cls.filter(a => String(pick(a, /^LOWER_CODE$/i)).toUpperCase() === 'SFC' || /E2|E4/i.test(pick(a, /^LOCAL_TYPE$/i)) || +pick(a, /^LOWER_VAL$/i) === 0);
      const top = surface.sort((a, b) => (RANK[String(pick(b, /^CLASS$/i)).toUpperCase()] || 0) - (RANK[String(pick(a, /^CLASS$/i)).toUpperCase()] || 0))[0];
      const ceilings = grid.map(g => +pick(g, /^CEILING$/i)).filter(x => !isNaN(x));
      const ceiling = ceilings.length ? Math.min(...ceilings) : null;
      const gAirport = grid.length ? (pick(grid[0], /APT1_ICAO|APT1_FAAID|APT1_LAANC|ARPT_ID|AIRPORT/i) || '') : '';
      const alt = +$('plAlt').value || 400;
      let airspace, risk = 1, laanc = '', why = '';
      if (B.gridErr && B.clsErr) { airspace = 'Could not load airspace data'; risk = 2; why = 'Airspace not verified'; }
      else if (grid.length || top) {
        const c = top ? String(pick(top, /^CLASS$/i)).toUpperCase() : '';
        airspace = (c ? 'Class ' + c : 'Controlled airspace') + (top && pick(top, /^NAME$/i) ? ' (' + pick(top, /^NAME$/i) + ')' : '');
        laanc = ceiling === null ? 'No LAANC grid here: requires FAA DroneZone authorization' : ceiling === 0 ? 'LAANC ceiling 0 ft: no LAANC, FAA DroneZone authorization needed' : `LAANC grid ceiling ${ceiling} ft AGL${gAirport ? ' (' + gAirport + ')' : ''}`;
        risk = (c === 'B' || c === 'C' || ceiling === 0 || ceiling === null) ? 3 : 2; why = (c ? 'Class ' + c : 'Controlled') + (ceiling ? `, LAANC ${ceiling} ft` : '');
      } else { airspace = 'Class G (uncontrolled) at 400 ft AGL and below'; laanc = 'No LAANC authorization needed'; why = 'Class G'; }
      const above = ceiling !== null && ceiling > 0 && alt > ceiling;
      if (above) laanc += ` · planned ${alt} ft is ABOVE the grid ceiling`;
      const tfrIn = (B.tfr || []).filter(t => t.inside), tfrNear = (B.tfr || []).filter(t => !t.inside && t.miles <= 5);
      if (tfrIn.length) { risk = 3; why = 'Inside a TFR'; } else if (tfrNear.length && risk < 2) { risk = 2; why += ', TFR within 5 mi'; }
      const sun = S.lat !== null ? sunTimes(planDate(), S.lat, S.lon) : null;
      const d = $('plDate').value, h = +($('plTime').value || '10:00').slice(0, 2);
      const fc = hourly(d, h);
      return {airspace, laanc, ceiling, above, airspaceRisk: risk, airspaceWhy: why, tfrs: tfrIn.concat(tfrNear), fc, sun};
    }

    // ---- automatic factor ratings
    function autoRatings(Z) {
      const fc = Z.fc, o = {};
      const fw = flightWind(fc);
      o.f1 = fc ? {lv: windLevel(fw), why: `${fc.w120 ?? '–'} kt at 400 ft, ${fc.w80 ?? '–'} kt at 260 ft, gusts ${fc.gust ?? '–'} kt`} : {lv: 0, why: 'No forecast for this time'};
      o.f2 = fc ? {lv: visLevel(fc.vis, fc.low), why: `Visibility ${fc.vis ?? '–'} SM, low clouds ${fc.low ?? '–'}%`} : {lv: 0, why: 'No forecast for this time'};
      o.f3 = fc ? {lv: wxLevel(fc.pop, fc.temp), why: `${WMO(fc.code)}, precip ${fc.pop ?? '–'}%, ${fc.temp ?? '–'}°F`} : {lv: 0, why: 'No forecast for this time'};
      o.f4 = {lv: Z.airspaceRisk, why: Z.airspaceWhy};
      const start = planDate(), endT = $('plEnd').value ? new Date($('plDate').value + 'T' + $('plEnd').value + ':00') : start;
      const night = Z.sun && (start < Z.sun.dawn || endT > Z.sun.dusk);
      let lv = 1, why = [];
      if (night) { lv = 2; why.push('Night / outside civil twilight'); }
      if ($('plLong').checked) { lv = Math.max(lv, 2); why.push('Long-line'); }
      if (night && $('plLong').checked) lv = 3;
      if (Z.above) { lv = 3; why.push('Above LAANC ceiling'); }
      o.f10 = {lv, why: why.join(', ') || 'Routine'};
      if (S.aircraft && S.aircraft.status === 'done' && S.aircraft.level) o.f9 = {lv: S.aircraft.level, why: S.aircraft.why};
      return o;
    }
    function ratings() {
      const Z = summarize(), A = autoRatings(Z), R = {};
      FACTORS.forEach(f => { const m = S.manual[f.g], a = A[f.g]; R[f.g] = m ? {lv: m, why: a ? (m !== a.lv ? 'Changed by pilot · ' : '') + a.why : '', manual: true} : a ? Object.assign({auto: true}, a) : {lv: 0, why: ''}; });
      if (!R.f9.why && S.aircraft && S.aircraft.why) R.f9.why = S.aircraft.why;
      const rated = FACTORS.filter(f => R[f.g].lv);
      const score = rated.reduce((s, f) => s + R[f.g].lv, 0), hard = FACTORS.some(f => f.hard && R[f.g].lv === 3);
      const complete = rated.length === FACTORS.length;
      const decision = !complete ? '' : (hard || score >= 23) ? 'NO-GO' : score >= 16 ? 'CAUTION' : 'GO';
      return {R, score, rated: rated.length, complete, decision, hard, highs: FACTORS.filter(f => R[f.g].lv === 3).map(f => f.name)};
    }

    // ---- briefing UI
    function drawBrief() {
      const box = $('plBrief'), B = S.brief;
      if (!B) { box.innerHTML = ''; return; }
      if (B.loading) { box.innerHTML = `<div class="pcard"><h4>Briefing</h4><p class="note">Checking airspace, TFRs, airports, and weather for ${S.lat}, ${S.lon}…</p></div>`; return; }
      const Z = summarize(), fc = Z.fc, err = m => `<span class="badge grey">${esc(m || 'unavailable')}</span>`;
      const apts = (B.apt || []).map(f => { const a = f.attributes, g = f.geometry || {}; const d = (g.y !== undefined) ? distMi(S.lat, S.lon, g.y, g.x) : null;
        const type = String(pick(a, /^TYPE_CODE$/i)).toUpperCase(); return {name: pick(a, /^NAME$/i), id: pick(a, /^IDENT$|ICAO_ID/i), heli: type === 'HP' || /HELI/i.test(pick(a, /^NAME$/i)), priv: +pick(a, /PRIVATE/i) === 1, d, dir: d === null ? '' : bearing(S.lat, S.lon, g.y, g.x)}; })
        .sort((a, b) => (a.d || 99) - (b.d || 99));
      const sua = B.sua || [], o = B.wx && B.wx.obs, av = B.avwx || {};
      const obsTxt = o ? [o.textDescription, o.temperature && o.temperature.value !== null ? Math.round(o.temperature.value * 9 / 5 + 32) + '°F' : '',
        o.windSpeed && o.windSpeed.value !== null ? 'wind ' + Math.round(o.windSpeed.value * 0.54) + ' kt' : '', o.windGust && o.windGust.value !== null ? 'gusts ' + Math.round(o.windGust.value * 0.54) + ' kt' : '',
        o.visibility && o.visibility.value !== null ? 'vis ' + Math.round(o.visibility.value / 1609) + ' SM' : ''].filter(Boolean).join(', ') + ` (${o.station})` : '';
      const rk = Z.airspaceRisk === 3 ? 'red' : Z.airspaceRisk === 2 ? 'amber' : 'green';
      const kpNow = (av.kp || []).find(k => new Date(k.time) >= new Date(planDate().getTime() - 3 * 36e5)) || null;
      box.innerHTML = `<div class="pcard plan-brief">
        <div class="pcard-top"><div><b>${esc(S.address || 'Selected location')}</b><div class="note">${S.lat}, ${S.lon}${B.wx && B.wx.place ? ' · near ' + esc(B.wx.place) : ''}</div></div></div>
        <div class="brow"><div class="bl">Airspace</div><div>${B.gridErr && B.clsErr ? err(B.gridErr) : `<span class="badge ${rk}">${esc(Z.airspace)}</span><div class="note">${esc(Z.laanc)}</div>`}</div></div>
        <div class="brow"><div class="bl">TFRs</div><div>${B.tfrErr ? err('TFR check unavailable (' + B.tfrErr + ')') + ' <a href="https://tfr.faa.gov/" target="_blank" rel="noopener">Check tfr.faa.gov</a>'
          : !(B.tfr || []).length ? '<span class="badge green">None within 30 mi</span>'
          : (B.tfr || []).slice(0, 6).map(t => `<div class="${t.inside ? 'tfr-in' : ''}"><span class="badge ${t.inside ? 'red' : t.miles <= 5 ? 'amber' : 'grey'}">${t.inside ? 'INSIDE' : t.miles.toFixed(1) + ' mi'}</span> ${esc(t.title)}</div>`).join('')}</div></div>
        <div class="brow"><div class="bl">Airports &amp; heliports (5 mi)</div><div>${B.aptErr ? err(B.aptErr) : !apts.length ? '<span class="badge green">None within 5 mi</span>'
          : apts.slice(0, 6).map(a => `<div>${a.heli ? '&#x1F681;' : '&#x2708;&#xFE0F;'} ${esc(a.id)} ${esc(a.name)}${a.priv ? ' <span class="note">(private)</span>' : ''} <span class="note">${a.d === null ? '' : a.d.toFixed(1) + ' mi ' + a.dir}</span></div>`).join('')}</div></div>
        <div class="brow"><div class="bl">Special use airspace</div><div>${B.suaErr ? err(B.suaErr) : !sua.length ? '<span class="badge green">None within 3 mi</span>'
          : sua.map(a => `<div><span class="badge amber">${esc(pick(a, /^TYPE_CODE$/i) || 'SUA')}</span> ${esc(pick(a, /^NAME$/i))} <span class="note">${esc([altTxt(pick(a, /^LOWER_VAL$/i), pick(a, /^LOWER_UOM$/i), pick(a, /^LOWER_CODE$/i)), altTxt(pick(a, /^UPPER_VAL$/i), pick(a, /^UPPER_UOM$/i), pick(a, /^UPPER_CODE$/i))].filter(Boolean).join(' – '))}</span></div>`).join('')}</div></div>
        <div class="brow"><div class="bl">Forecast at start</div><div>${B.omErr && !fc ? err(B.omErr) : fc ? `<b>${esc(WMO(fc.code))}</b>, ${fc.temp}°F, precip ${fc.pop ?? '–'}%, visibility ${fc.vis ?? '–'} SM, low clouds ${fc.low ?? '–'}%
          <table class="aloft"><tr><th></th><th>Ground</th><th>260 ft</th><th>400 ft</th><th>Gusts</th></tr><tr><td>Wind (kt)</td><td>${fc.w10 ?? '–'}</td><td>${fc.w80 ?? '–'}</td><td>${fc.w120 ?? '–'}</td><td>${fc.gust ?? '–'}</td></tr></table>
          <div class="note">From ${dirTxt(fc.dir)} · winds aloft are usually stronger than at the ground.</div>${fc.temp !== null && fc.temp < 40 ? '<div class="warn-inline">Cold: warm batteries and expect shorter flight times.</div>' : fc.temp !== null && fc.temp > 95 ? '<div class="warn-inline">Hot: watch motor and battery temperatures.</div>' : ''}`
          : '<span class="note">Forecast covers the next 7 days.</span>'}</div></div>
        <div class="brow"><div class="bl">Best time to fly</div><div>${timeline(Z)}</div></div>
        <div class="brow"><div class="bl">Aviation weather</div><div>${B.avwxErr ? err(B.avwxErr) : `${av.metar ? `<div class="mono">${esc(av.metar.raw)}</div>` : '<span class="note">No METAR found nearby.</span>'}
          ${av.taf ? `<div class="mono taf">${esc(av.taf.raw)}</div><div class="note">TAF from ${esc(av.taf.station)}${av.taf.miles ? ', ' + av.taf.miles + ' mi away' : ''}</div>` : '<div class="note">No TAF within about 40 mi.</div>'}`}
          ${obsTxt ? `<div class="note">Now: ${esc(obsTxt)}</div>` : ''}</div></div>
        <div class="brow"><div class="bl">GPS / space weather</div><div>${B.avwxErr || !av.kp ? err('Kp unavailable') : kpNow ? `<span class="badge ${kpNow.kp >= 5 ? 'red' : kpNow.kp >= 4 ? 'amber' : 'green'}">Kp ${kpNow.kp}</span> <span class="note">${kpNow.kp >= 5 ? 'Geomagnetic storm: GPS may be degraded. Be ready to fly manually (ATTI).' : kpNow.kp >= 4 ? 'Active: watch GPS satellite count.' : 'Quiet: normal GPS expected.'}</span>` : '<span class="note">Kp forecast covers about 3 days.</span>'}</div></div>
        <div class="brow"><div class="bl">Sun</div><div>${Z.sun ? `Civil dawn ${fmtT(Z.sun.dawn)} · Sunrise ${fmtT(Z.sun.sunrise)} · Sunset ${fmtT(Z.sun.sunset)} · Civil dusk ${fmtT(Z.sun.dusk)}` : ''}<div class="note">Flying before civil dawn or after civil dusk is night operations (anti-collision lighting and night training required).</div></div></div>
      </div>`;
      box.querySelectorAll('[data-hr]').forEach(b => b.onclick = () => { $('plTime').value = String(b.dataset.hr).padStart(2, '0') + ':00';
        const e = (+b.dataset.hr + 1) % 24; $('plEnd').value = String(e).padStart(2, '0') + ':00'; redraw(); });
    }
    function timeline(Z) {
      const d = $('plDate').value; if (!S.brief.om || !hourly(d, 12)) return '<span class="note">Hourly forecast covers the next 7 days.</span>';
      const sel = +($('plTime').value || '10:00').slice(0, 2);
      const cells = [];
      for (let h = 5; h <= 21; h++) {
        const fc = hourly(d, h); if (!fc) continue;
        const t = new Date(`${d}T${String(h).padStart(2, '0')}:30:00`);
        const dark = Z.sun && (t < Z.sun.dawn || t > Z.sun.dusk);
        const lv = Math.max(windLevel(flightWind(fc)), visLevel(fc.vis, fc.low), wxLevel(fc.pop, fc.temp), dark ? 2 : 1);
        cells.push(`<button class="tl ${LVC[lv]}${h === sel ? ' sel' : ''}" data-hr="${h}" title="${h}:00 · ${flightWind(fc)} kt · ${fc.pop}% precip${dark ? ' · dark' : ''}"><span>${(h % 12) || 12}${h < 12 ? 'a' : 'p'}</span><b>${flightWind(fc)}</b></button>`);
      }
      return `<div class="timeline">${cells.join('')}</div><div class="note">Strongest wind or gust (kt) each hour. Green good · yellow caution · red poor. Tap an hour to plan for it.</div>`;
    }

    // ---- risk UI
    function drawRisk() {
      const box = $('plRisk');
      if (!S.brief || S.brief.loading) { box.innerHTML = ''; $('plBanner').innerHTML = ''; return; }
      const K = ratings();
      const ban = K.complete ? `<div class="risk-banner ${K.decision === 'GO' ? 'go' : K.decision === 'CAUTION' ? 'caution' : 'nogo'}"><b>${K.decision}</b><span>Risk score ${K.score}${K.hard ? ' · HIGH in ' + K.highs.filter(n => FACTORS.find(f => f.name === n).hard).join(', ') : ''}</span></div>`
        : `<div class="risk-banner pending"><b>Risk score ${K.score || '–'}</b><span>${K.rated} of 10 factors rated · rate the rest below</span></div>`;
      $('plBanner').innerHTML = ban;
      box.innerHTML = `<div class="pcard"><h4>Risk assessment (OVH-205)</h4>${ban}
        <div class="rlist">${FACTORS.map(f => { const r = K.R[f.g], opts = f.opts || ['Low', 'Medium', 'High'];
          return `<div class="rrow"><div class="rname"><b>${esc(f.name)}</b>${r.auto ? ' <span class="badge grey">auto</span>' : ''}${f.aircraft && S.aircraft ? ' <span class="note">' + esc(S.aircraft.label) + '</span>' : ''}<div class="note">${esc(r.why || (f.aircraft && !S.aircraft ? 'Pick the aircraft above, or rate it' : ''))}</div></div>
            <div class="seg">${[1, 2, 3].map(l => `<label><input type="radio" name="rk_${f.g}" data-g="${f.g}" value="${l}"${r.lv === l ? ' checked' : ''}><span class="${l === 3 ? 'hi' : ''}">${esc(f.opts ? opts[l - 1] : LV[l])}</span></label>`).join('')}</div></div>`; }).join('')}</div>
        <p class="note">GO 10–15 · CAUTION 16–22 · NO-GO 23+. Any HIGH in wind, visibility, precipitation, airspace, or pilot fitness is a NO-GO. Weather and airspace are rated automatically; tap to change any rating.</p></div>`;
      box.querySelectorAll('input[data-g]').forEach(i => i.onchange = () => { S.manual[i.dataset.g] = +i.value; drawRisk(); });
    }

    function drawOverlays(lat, lon) {
      airLayer.clearLayers(); gridLayer.clearLayers(); tfrLayer.clearLayers();
      const color = {B: '#1f63a3', C: '#a3237a', D: '#1f63a3', E: '#a3237a'};
      arcBox(L_CLASS, lat, lon, 0.25, {where: "LOCAL_TYPE IN ('CLASS_B','CLASS_C','CLASS_D','CLASS_E2')"}).then(g => {
        L.geoJSON(g, {style: ft => { const c = String(pick(ft.properties, /^CLASS$/i)).toUpperCase(); return {color: color[c] || '#555', weight: c === 'D' || c === 'E' ? 1.5 : 2.5, dashArray: c === 'D' ? '6 4' : c === 'E' ? '2 4' : null, fillOpacity: 0.04}; },
          onEachFeature: (ft, ly) => ly.bindTooltip('Class ' + pick(ft.properties, /^CLASS$/i) + ' ' + (pick(ft.properties, /^NAME$/i) || ''))}).addTo(airLayer); }).catch(() => {});
      arcBox(L_GRID, lat, lon, 0.04).then(g => {
        L.geoJSON(g, {style: ft => { const c = +pick(ft.properties, /^CEILING$/i); return {color: c === 0 ? '#c42330' : c < 200 ? '#c77700' : '#1b7a40', weight: 0.6, fillOpacity: c === 0 ? 0.18 : 0.08}; },
          onEachFeature: (ft, ly) => { const c = pick(ft.properties, /^CEILING$/i); const ctr = ly.getBounds().getCenter();
            L.marker(ctr, {interactive: false, icon: L.divIcon({className: 'grid-lbl', html: String(c), iconSize: [30, 14]})}).addTo(gridLayer); }}).addTo(gridLayer); }).catch(() => {});
      ((S.brief && S.brief.tfr) || []).forEach(t => { if (t.geometry) L.geoJSON(t.geometry, {style: {color: '#c42330', weight: 2, fillOpacity: 0.12}}).bindTooltip(t.title).addTo(tfrLayer); });
    }

    // ---- static satellite map image (JPEG bytes) with the radius drawn on it
    async function mapImage(W = 768, H = 432, pad = 140) {
      const rM = +$('plRadius').value * 0.3048;
      const z = Math.max(12, Math.min(18, Math.floor(Math.log2(156543.034 * Math.cos(S.lat * rad) / (rM / pad)))));
      const n = 2 ** z, px = (S.lon + 180) / 360 * n * 256, py = (1 - Math.log(Math.tan(S.lat * rad) + 1 / Math.cos(S.lat * rad)) / Math.PI) / 2 * n * 256;
      const x0 = px - W / 2, y0 = py - H / 2, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
      ctx.fillStyle = '#dde3ea'; ctx.fillRect(0, 0, W, H);
      const loads = [];
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
        loads.push(new Promise(ok => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => { ctx.drawImage(im, tx * 256 - x0, ty * 256 - y0); ok(); }; im.onerror = () => ok();
          im.src = ESRI.replace('{z}', z).replace('{y}', ty).replace('{x}', ((tx % n) + n) % n); }));
      }
      await Promise.all(loads);
      const mpp = 156543.034 * Math.cos(S.lat * rad) / n;
      ctx.strokeStyle = '#ff2b3a'; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(255,43,58,.12)';
      ctx.beginPath(); ctx.arc(W / 2, H / 2, rM / mpp, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff2b3a'; ctx.beginPath(); ctx.arc(W / 2, H / 2, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(W - 34, 8, 26, 30); ctx.fillStyle = '#0b1f33'; ctx.font = 'bold 13px Helvetica'; ctx.fillText('N', W - 25, 22);
      ctx.beginPath(); ctx.moveTo(W - 21, 26); ctx.lineTo(W - 26, 35); ctx.lineTo(W - 16, 35); ctx.fill();
      const ft = Math.round(+$('plRadius').value); ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(8, H - 26, 170, 18); ctx.fillStyle = '#0b1f33'; ctx.font = '11px Helvetica'; ctx.fillText(`Red circle: ${ft.toLocaleString()} ft radius`, 13, H - 13);
      try { const b = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.85)); return b ? new Uint8Array(await b.arrayBuffer()) : null; } catch (e) { return null; }
    }

    // ---- text bits shared by the PDFs and forms
    function texts() {
      const Z = summarize(), fc = Z.fc, B = S.brief || {}, av = B.avwx || {};
      const wx = fc ? `${WMO(fc.code)}, ${fc.temp}°F, precip ${fc.pop ?? '-'}%, vis ${fc.vis ?? '-'} SM. Wind ${dirTxt(fc.dir)} ${fc.w10 ?? '-'} kt sfc / ${fc.w120 ?? '-'} kt at 400 ft, gusts ${fc.gust ?? '-'} kt` : '';
      const hz = [$('plNotes').value.trim(), ...Z.tfrs.map(t => (t.inside ? 'INSIDE TFR: ' : 'TFR ' + t.miles + ' mi: ') + (t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title)),
        ...(B.apt || []).slice(0, 2).map(f => { const a = f.attributes, g = f.geometry || {}; return (String(pick(a, /^TYPE_CODE$/i)).toUpperCase() === 'HP' ? 'Heliport ' : 'Airport ') + pick(a, /^IDENT$/i) + (g.y !== undefined ? ' ' + distMi(S.lat, S.lon, g.y, g.x).toFixed(1) + ' mi ' + bearing(S.lat, S.lon, g.y, g.x) : ''); })].filter(Boolean).join('; ');
      const short = Z.airspace.replace(/\s*\(.*\)\s*/, '').replace(' (uncontrolled) at 400 ft AGL and below', '').replace('Could not load airspace data', 'Verify airspace');
      const lshort = Z.ceiling !== null ? (Z.ceiling ? `LAANC ${Z.ceiling} ft AGL` : 'LAANC 0 ft: DroneZone auth') : /Class G/.test(Z.airspace) ? 'no LAANC needed' : 'no LAANC grid';
      return {Z, wx, hz, metar: av.metar ? av.metar.raw : '', air: Z.airspace + (Z.laanc ? ' · ' + Z.laanc : ''), airShort: short + ' · ' + lshort + (Z.above ? ' · plan ABOVE ceiling' : '') + (Z.tfrs.some(t => t.inside) ? ' · IN TFR' : '')};
    }
    const pilotName = () => (X.profile && X.profile.name) || (X.me && X.me.name) || '';
    const fileTag = () => ($('plMission').value || S.address.split(',')[0] || 'Plan').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const ready = () => S.brief && !S.brief.loading;

    // ---- Kneeboard pack: filled OVH-201 (map in the sketch box) + OVH-205
    async function kneeboard() {
      const {PDFDocument, StandardFonts} = await X.loadPdfLib();
      const T = texts(), K = ratings(), out = await PDFDocument.create();
      out.setTitle('Kneeboard pack – OVH-201 + OVH-205'); out.setAuthor('Overhead UAS');
      // OVH-201
      const ms = await PDFDocument.load(await X.getForm('OVH-201')), f1 = ms.getForm();
      const set = (form, n, v) => { try { const t = form.getTextField(n), txt = String(v || ''); t.setMaxLength(undefined); t.setText(txt);
        const big = ['weather', 'hazards', 'mitigations'].includes(n); t.setFontSize(big ? (txt.length > 170 ? 6.5 : txt.length > 110 ? 7.5 : 9) : (txt.length > 48 ? 7 : 9.5)); } catch (e) {} };
      const latTxt = (S.address ? S.address.split(',').slice(0, 2).join(',') + ' · ' : '') + S.lat;
      [['mission', $('plMission').value], ['date', X.usDate($('plDate').value)], ['time', ampm($('plTime').value)], ['weather', T.wx], ['hazards', T.hz],
       ['latitude', latTxt], ['longitude', String(S.lon)], ['airspace', T.airShort], ['sunset_time', T.Z.sun ? fmtT(T.Z.sun.sunset) : ''],
       ['start_time', ampm($('plTime').value)], ['end_time', ampm($('plEnd').value)], ['name_position', pilotName() ? pilotName() + ' / RPIC' : '']].forEach(([n, v]) => set(f1, n, v));
      try {
        const tf = f1.getTextField('sketch'), r = tf.acroField.getWidgets()[0].getRectangle(), img = await mapImage(Math.round(r.width * 2.2), Math.round(r.height * 2.2), 120);
        if (img) { const im = await ms.embedJpg(img); ms.getPages()[0].drawImage(im, {x: r.x, y: r.y, width: r.width, height: r.height}); }
        f1.removeField(tf);
      } catch (e) {}
      f1.updateFieldAppearances(await ms.embedFont(StandardFonts.Helvetica)); f1.flatten();
      (await out.copyPages(ms, [0])).forEach(p => out.addPage(p));
      // OVH-205
      const ra = await PDFDocument.load(await X.getForm('OVH-205')), f2 = ra.getForm();
      [['mission', $('plMission').value], ['date', X.usDate($('plDate').value)], ['pilot', pilotName()], ['time', ampm($('plTime').value)],
       ['score', K.complete ? String(K.score) : ''], ['mitigations', $('plMit').value]].forEach(([n, v]) => set(f2, n, v));
      FACTORS.forEach((f, i) => { const lv = K.R[f.g].lv; [1, 2, 3].forEach(l => { try { const cb = f2.getCheckBox(`f${i + 1}_${l}`); l === lv ? cb.check() : cb.uncheck(); } catch (e) {} }); });
      if (K.complete) [['GO', 'go'], ['CAUTION', 'caution'], ['NO-GO', 'nogo']].forEach(([d, n]) => { try { const cb = f2.getCheckBox(n); d === K.decision ? cb.check() : cb.uncheck(); } catch (e) {} });
      f2.updateFieldAppearances(await ra.embedFont(StandardFonts.Helvetica)); f2.flatten();
      (await out.copyPages(ra, [0])).forEach(p => out.addPage(p));
      return out.save();
    }

    // ---- Full mission plan PDF (Letter)
    async function makePdf() {
      const {PDFDocument, StandardFonts, rgb} = await X.loadPdfLib();
      const T = texts(), Z = T.Z, K = ratings(), B = S.brief, doc = await PDFDocument.create();
      doc.setTitle('OVH-208 Mission Plan'); doc.setAuthor('Overhead UAS');
      const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), mono = await doc.embedFont(StandardFonts.Courier);
      const NAVY = rgb(0.043, 0.122, 0.2), GREY = rgb(0.36, 0.42, 0.48), RED = rgb(0.78, 0.06, 0.18), LINE = rgb(0.6, 0.65, 0.7);
      const COL = {GO: rgb(0.1, 0.5, 0.25), CAUTION: rgb(0.7, 0.4, 0), 'NO-GO': RED};
      const Wp = 612, Hp = 792, M = 44, FW = Wp - 2 * M; let page = doc.addPage([Wp, Hp]), y = Hp - M;
      let logo = null; try { logo = await doc.embedPng(await X.fetchBytes('logo.png')); } catch (e) {}
      const TX = (t, x, yy, s = 9.5, f = font, c = rgb(0, 0, 0)) => page.drawText(String(t), {x, y: yy, size: s, font: f, color: c});
      const clean = t => String(t).replace(/[^\n\x20-\x7E -ÿ]/g, '').replace(/[^\S\n]+/g, ' ').trim();
      const wrap = (t, s, w, f = font) => { const out = []; for (const para of String(t || '').split(/\n/)) { let line = ''; for (const wd of para.split(/\s+/)) { const tt = line ? line + ' ' + wd : wd; if (f.widthOfTextAtSize(tt, s) > w && line) { out.push(line); line = wd; } else line = tt; } out.push(line); } return out; };
      const footer = () => { page.drawLine({start: {x: M, y: 40}, end: {x: Wp - M, y: 40}, thickness: 0.5, color: LINE});
        TX('Overhead UAS  ·  www.overheaduas.com  ·  (760) 527-3267', M, 28, 7.5, font, GREY); const r = 'OVH-208  ·  Rev. 11/2026'; TX(r, Wp - M - font.widthOfTextAtSize(r, 7.5), 28, 7.5, font, GREY); };
      const need = h => { if (y - h < 56) { footer(); page = doc.addPage([Wp, Hp]); y = Hp - M; } };
      const section = t => { need(60); y -= 6; page.drawRectangle({x: M, y: y - 15, width: FW, height: 15, color: NAVY}); TX(t, M + 6, y - 11, 8.5, bold, rgb(1, 1, 1)); y -= 19; };
      const row = (label, text, color, f = font, s = 9.3) => { const lines = wrap(clean(text || '-'), s, FW - 140, f); need(lines.length * 12 + 6);
        TX(label.toUpperCase(), M + 4, y - 10, 7, bold, NAVY); lines.forEach((l, i) => TX(l, M + 136, y - 10 - i * 12, s, f, color || rgb(0, 0, 0)));
        y -= lines.length * 12 + 6; page.drawLine({start: {x: M, y: y + 2}, end: {x: Wp - M, y: y + 2}, thickness: 0.3, color: LINE}); };
      if (logo) page.drawImage(logo, {x: Wp - M - 58, y: Hp - M - 54, width: 58, height: 58});
      TX('MISSION PLAN', M, y - 18, 20, bold, NAVY); TX('OVERHEAD UAS', M, y - 32, 9, bold, RED); TX('OVH-208  ·  Rev. 11/2026  ·  Created ' + X.nowStamp(), M, y - 44, 7.5, font, GREY);
      y -= 58;
      if (K.complete) { const c = COL[K.decision]; page.drawRectangle({x: M, y: y - 24, width: FW, height: 24, borderColor: c, borderWidth: 1.2, color: rgb(1, 1, 1)});
        TX(K.decision, M + 10, y - 17, 13, bold, c); TX(`Risk score ${K.score}${K.highs.length ? '  ·  HIGH: ' + K.highs.join(', ') : ''}`, M + 90, y - 16, 9.5, font, c); y -= 32; }
      row('Mission', $('plMission').value); row('Pilot', pilotName() + (X.profile && X.profile.cert ? '  ·  Part 107 #' + X.profile.cert : ''));
      row('Planned', `${X.usDate($('plDate').value)}  ${ampm($('plTime').value)} - ${ampm($('plEnd').value)}  ·  radius ${$('plRadius').selectedOptions[0].text}  ·  max ${$('plAlt').value} ft AGL${$('plLong').checked ? '  ·  long-line' : ''}`);
      row('Aircraft', S.aircraft ? S.aircraft.label + (S.aircraft.why ? '  ·  ' + S.aircraft.why : '') : 'Not selected');
      row('Location', (S.address ? S.address + '  ·  ' : '') + `${S.lat}, ${S.lon}`);
      const img = await mapImage();
      if (img) { try { const im = await doc.embedJpg(img), h = FW * im.height / im.width; need(h + 8); page.drawImage(im, {x: M, y: y - h, width: FW, height: h});
        page.drawRectangle({x: M, y: y - h, width: FW, height: h, borderColor: LINE, borderWidth: 0.6}); y -= h + 4; TX('Imagery: Esri, Maxar, Earthstar Geographics.', M, y - 8, 6.8, font, GREY); y -= 12; } catch (e) {} }
      section('AIRSPACE & RESTRICTIONS');
      row('Airspace', B.gridErr && B.clsErr ? 'Unavailable - verify in B4UFLY / LAANC app' : Z.airspace, Z.airspaceRisk === 3 ? RED : null);
      row('LAANC', Z.laanc);
      row('TFRs', B.tfrErr ? 'Check unavailable - verify at tfr.faa.gov' : !(B.tfr || []).length ? 'None within 30 mi' : (B.tfr || []).slice(0, 6).map(t => (t.inside ? 'INSIDE: ' : t.miles.toFixed(1) + ' mi: ') + t.title).join('\n'), (B.tfr || []).some(t => t.inside) ? RED : null);
      const apts = (B.apt || []).map(f => { const a = f.attributes, g = f.geometry || {}; const d = g.y !== undefined ? distMi(S.lat, S.lon, g.y, g.x) : null;
        return `${pick(a, /^IDENT$|ICAO_ID/i)} ${pick(a, /^NAME$/i)}${d === null ? '' : '  ' + d.toFixed(1) + ' mi ' + bearing(S.lat, S.lon, g.y, g.x)}`; });
      row('Airports / heliports', B.aptErr ? 'Unavailable' : apts.length ? apts.slice(0, 6).join('\n') : 'None within 5 mi');
      row('Special use airspace', B.suaErr ? 'Unavailable' : (B.sua || []).length ? (B.sua || []).map(a => `${pick(a, /^TYPE_CODE$/i)} ${pick(a, /^NAME$/i)}`).join('\n') : 'None within 3 mi');
      section('WEATHER & LIGHT');
      row('Forecast at start', T.wx || 'Not available for this date - check before flight');
      const av = B.avwx || {};
      if (av.metar) row('METAR', av.metar.raw, null, mono, 8.4);
      if (av.taf) row('TAF (' + av.taf.station + ')', av.taf.raw, null, mono, 8.4);
      if (Z.sun) row('Sun', `Civil dawn ${fmtT(Z.sun.dawn)}  ·  Sunrise ${fmtT(Z.sun.sunrise)}  ·  Sunset ${fmtT(Z.sun.sunset)}  ·  Civil dusk ${fmtT(Z.sun.dusk)}`);
      section('RISK ASSESSMENT');
      FACTORS.forEach(f => { const r = K.R[f.g]; row(f.name, (r.lv ? LV[r.lv] : 'Not rated') + (r.why ? '  ·  ' + r.why : ''), r.lv === 3 ? RED : null); });
      if ($('plMit').value.trim()) row('Mitigations', $('plMit').value);
      section('HAZARDS & NOTES');
      row('Pilot notes', $('plNotes').value || 'None entered');
      section('BEFORE FLIGHT');
      ['Airspace and TFRs re-checked in B4UFLY / LAANC app on flight day', 'LAANC authorization obtained (if controlled airspace)', 'OVH-205 Risk Assessment signed', 'OVH-201 Mission Sheet and OVH-101 Preflight Checklist'].forEach(t => {
        need(16); page.drawRectangle({x: M + 4, y: y - 12, width: 9, height: 9, borderColor: NAVY, borderWidth: 0.8}); TX(t, M + 20, y - 10.5, 9.2); y -= 16; });
      y -= 4; wrap('Planning aid only, compiled from FAA, National Weather Service, Open-Meteo, NOAA, and OpenStreetMap public data at the time shown. Data can change and may be incomplete. The remote pilot in command must verify airspace, TFRs, and NOTAMs with official sources before flight.', 7.4, FW).forEach(l => { need(10); TX(l, M, y - 8, 7.4, font, GREY); y -= 10; });
      footer();
      return doc.save();
    }

    // ---- actions
    const msg = (t, bad) => { $('plMsg').innerHTML = t; $('plMsg').className = 'plan-msg ' + (bad ? 'bad' : 'good'); };
    function offer(bytes, name, label) {
      const file = new File([bytes], name, {type: 'application/pdf'}), url = URL.createObjectURL(file);
      msg(`<b>&#10003; ${label} ready.</b> <a href="#" data-open>Open / print</a> · <a href="#" data-dl>Save to this device</a> · <a href="#" data-share>Share</a> <span class="note" data-drive></span>`);
      $('plMsg').querySelector('[data-open]').onclick = ev => { ev.preventDefault(); X.showFile ? X.showFile(bytes, name, 'application/pdf') : window.open(url, '_blank'); };
      $('plMsg').querySelector('[data-dl]').onclick = ev => { ev.preventDefault(); X.saveBlob(url, name); };
      $('plMsg').querySelector('[data-share]').onclick = async ev => { ev.preventDefault(); const r = await X.shareFile(file, 'Overhead UAS ' + label.toLowerCase()); if (r === false) X.saveBlob(url, name); };
      const am = X.activeMission && X.activeMission();
      if (X.submit && X.submit.url) fetch(X.submit.url, {method: 'POST', body: JSON.stringify({token: X.submit.token, filename: name, pdf: X.toB64(bytes), folder: 'Mission Plans', quiet: true,
        mission: am ? am.id : '', pilot: X.me,
        subject: label + ': ' + ($('plMission').value || S.address), lines: ['Form: OVH-208']})}).then(r => r.json())
        .then(j => { const d = $('plMsg').querySelector('[data-drive]'); if (d) d.textContent = j.ok ? (j.mission ? '· Filed in ' + j.mission : '· Saved to Overhead UAS records') : ''; }).catch(() => {});
    }
    async function run(btn, label, fn) {
      if (!ready()) return msg('Drop a pin and wait for the briefing first.', true);
      const t = btn.textContent; btn.disabled = true; btn.textContent = 'Creating…';
      try { await fn(); } catch (x) { msg('Could not create the PDF (' + esc(x.message) + ').', true); } finally { btn.disabled = false; btn.textContent = t; }
    }
    $('plKnee').onclick = e => run(e.currentTarget, 'Kneeboard pack', async () => {
      const K = ratings(); if (!K.complete) return msg(`Rate all 10 risk factors first (${K.rated} of 10 done).`, true);
      offer(await kneeboard(), `Kneeboard_OVH-201_OVH-205_${fileTag()}_${X.usDate($('plDate').value).replace(/\//g, '-')}.pdf`, 'Kneeboard pack');
    });
    $('plPdf').onclick = e => run(e.currentTarget, 'Mission plan', async () =>
      offer(await makePdf(), `OVH-208_Mission_Plan_${fileTag()}_${X.usDate($('plDate').value).replace(/\//g, '-')}.pdf`, 'Mission plan'));
    $('plSend').onclick = () => {
      if (!ready()) return msg('Drop a pin and wait for the briefing first.', true);
      const T = texts(), K = ratings();
      const plan = {created: Date.now(), mission: $('plMission').value, date: $('plDate').value, time: $('plTime').value, end: $('plEnd').value, lat: S.lat, lon: S.lon, address: S.address,
        airspace: T.air, sunset: T.Z.sun ? hhmm(T.Z.sun.sunset) : '', weather: T.wx, hazards: T.hz, mitigations: $('plMit').value,
        ratings: Object.fromEntries(FACTORS.map(f => [f.g, K.R[f.g].lv])), risk: {wind: K.R.f1.lv, precip: K.R.f3.lv, airspace: K.R.f4.lv}};
      try { localStorage.setItem('ouas_plan', JSON.stringify(plan)); } catch (e) {}
      msg('<b>&#10003; Sent.</b> Open <a href="#forms">Forms</a> → OVH-201 Mission Sheet or OVH-205 Risk Assessment and tap Fill out. Everything from this plan fills in, ready to sign and submit.');
    };
  }
})();
