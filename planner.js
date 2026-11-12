/* Overhead UAS Pilot Portal – Mission Planning (OVH-208)
 * Map (OpenStreetMap / Esri imagery via Leaflet), address search (Nominatim),
 * FAA airspace, LAANC grid, airports, special use airspace (FAA ArcGIS open data),
 * TFRs (FAA, fetched by the Overhead UAS Google script), NWS weather, sun times.
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

  // ---------------- helpers ----------------
  const rad = Math.PI / 180;
  function distMi(a, b, c, d) { const R = 3958.8, dLat = (c - a) * rad, dLon = (d - b) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  function bearing(a, b, c, d) { const y = Math.sin((d - b) * rad) * Math.cos(c * rad), x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad);
    const deg = (Math.atan2(y, x) / rad + 360) % 360; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]; }
  async function getJSON(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (j && j.error) throw new Error(j.error.message || 'service error'); return j; }
  const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  function arcgis(layer, p) { return getJSON(layer + '/query?' + qs(Object.assign({f: 'json', outFields: '*', returnGeometry: false, inSR: 4326, outSR: 4326}, p))); }
  function arcPoint(layer, lat, lon, extra) { return arcgis(layer, Object.assign({geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects'}, extra || {})); }
  function arcBox(layer, lat, lon, d, extra) { return getJSON(layer + '/query?' + qs(Object.assign({f: 'geojson', outFields: '*', returnGeometry: true, inSR: 4326, outSR: 4326,
    geometry: [lon - d, lat - d, lon + d, lat + d].join(','), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', geometryPrecision: 5}, extra || {}))); }
  const pick = (o, re) => { for (const k of Object.keys(o || {})) if (re.test(k) && o[k] !== null && o[k] !== '') return o[k]; return ''; };
  const altTxt = (v, u, c) => (v === null || v === undefined || v === '') ? '' : (String(c || '').toUpperCase() === 'SFC' || (+v === 0 && !c) ? 'SFC' : `${v} ${u || 'ft'} ${c || ''}`.trim());

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

  window.OUAS_PLANNER = {mount};

  function mount(root, X) {
    if (root._planner) { root._planner.map.invalidateSize(); return; }
    const esc = X.esc;
    const S = {lat: null, lon: null, address: '', tz: undefined, brief: null};
    root.innerHTML = `
      <div class="view-head"><a href="#" class="back-btn">&lsaquo; Portal</a><h2>Mission Planning</h2></div>
      <div class="pcard plan-card">
        <div class="plan-search"><input type="search" id="plSearch" placeholder="Search an address or place" autocomplete="off">
          <button class="btn btn-primary sm" id="plGo">Search</button><button class="btn btn-ghost sm" id="plMe" title="Use my location">&#9678; Me</button></div>
        <div class="plan-results" id="plResults" hidden></div>
        <div id="plMap" class="plan-map"></div>
        <p class="note">Tap or click the map to drop a pin. Toggle satellite / streets and FAA layers with the layer button.</p>
        <div class="grid2 plan-inputs">
          <div class="wide"><label>Mission</label><input type="text" id="plMission" placeholder="e.g. Smith Realty listing shoot"></div>
          <div><label>Flight date</label><input type="date" id="plDate"></div><div><label>Start time</label><input type="time" id="plTime" value="10:00"></div>
          <div><label>Flight radius</label><select id="plRadius"><option value="200">200 ft</option><option value="400" selected>400 ft</option><option value="800">800 ft</option><option value="1500">1,500 ft</option><option value="2640">0.5 mi</option></select></div>
          <div><label>Max altitude (ft AGL)</label><input type="number" id="plAlt" value="400" min="0" max="400" step="10" inputmode="numeric"></div>
        </div>
      </div>
      <div id="plBrief"></div>
      <div class="pcard" id="plNotesCard" hidden>
        <h4>Hazards &amp; notes</h4>
        <p class="note">Add anything you see on the satellite map or know about the site: trees, power lines, towers, roads, people, launch / landing spot.</p>
        <textarea id="plNotes" rows="4" placeholder="e.g. Power lines along the street on the south side. Launch from the driveway."></textarea>
        <div class="fill-actions">
          <button class="btn btn-primary" id="plPdf">Create mission plan (PDF)</button>
          <button class="btn btn-ghost" id="plSend">Use in Mission Sheet &amp; Risk Assessment</button>
        </div>
        <p class="plan-msg" id="plMsg"></p>
        <p class="note">Planning aid only. Always verify airspace and TFRs with B4UFLY or an FAA-approved LAANC app (e.g. Aloft) and get LAANC authorization before flying in controlled airspace.</p>
      </div>`;
    const $ = id => root.querySelector('#' + id);
    const today = new Date(); $('plDate').value = new Date(today - today.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

    // ---- map
    const sat = L.tileLayer(ESRI, {maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'});
    const streets = L.tileLayer(OSM, {maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'});
    const airLayer = L.layerGroup(), gridLayer = L.layerGroup(), tfrLayer = L.layerGroup();
    const map = L.map($('plMap'), {layers: [sat, airLayer, gridLayer, tfrLayer], zoomControl: true}).setView([33.1581, -117.3506], 11);
    L.control.layers({'Satellite': sat, 'Streets': streets}, {'Airspace boundaries': airLayer, 'LAANC grid ceilings': gridLayer, 'TFRs': tfrLayer}, {collapsed: true}).addTo(map);
    L.control.scale({imperial: true, metric: false}).addTo(map);
    let pin = null, ring = null;
    root._planner = {map};
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
    $('plRadius').onchange = () => { if (S.lat !== null) { if (ring) ring.setRadius(+$('plRadius').value * 0.3048); } };
    $('plDate').onchange = $('plTime').onchange = $('plAlt').onchange = () => { if (S.brief && !S.brief.loading) drawBrief(); };

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

    // ---- briefing
    async function briefing() {
      const lat = S.lat, lon = S.lon;
      S.brief = {loading: true};
      $('plNotesCard').hidden = false;
      drawBrief();
      const B = {lat, lon};
      const jobs = {
        grid: arcPoint(L_GRID, lat, lon).then(r => r.features.map(f => f.attributes)),
        cls: arcPoint(L_CLASS, lat, lon).then(r => r.features.map(f => f.attributes)),
        sua: arcgis(L_SUA, {geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', distance: 3, units: 'esriSRUnit_StatuteMile'}).then(r => r.features.map(f => f.attributes)),
        apt: arcgis(L_APT, {geometry: lon + ',' + lat, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', distance: 5, units: 'esriSRUnit_StatuteMile', returnGeometry: true}).then(r => r.features),
        tfr: X.submit && X.submit.url ? fetch(X.submit.url, {method: 'POST', body: JSON.stringify({token: X.submit.token, action: 'plan.tfr', lat, lon, miles: 30})}).then(r => r.json()).then(j => { if (!j.ok) throw new Error(j.error || 'TFR lookup failed'); return j.tfrs; }) : Promise.reject(new Error('not connected')),
        wx: weatherFor(lat, lon)
      };
      const keys = Object.keys(jobs), res = await Promise.allSettled(Object.values(jobs));
      if (S.lat !== lat || S.lon !== lon) return;   // pin moved while loading
      keys.forEach((k, i) => { B[k] = res[i].status === 'fulfilled' ? res[i].value : null; B[k + 'Err'] = res[i].status === 'rejected' ? (res[i].reason && res[i].reason.message) || 'unavailable' : ''; });
      S.brief = B; S.tz = B.wx && B.wx.tz;
      drawBrief(); drawOverlays(lat, lon);
    }

    async function weatherFor(lat, lon) {
      const pt = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {headers: {Accept: 'application/geo+json'}});
      const P = pt.properties, out = {tz: P.timeZone, place: P.relativeLocation && P.relativeLocation.properties ? P.relativeLocation.properties.city + ', ' + P.relativeLocation.properties.state : ''};
      const [hourly, obs] = await Promise.allSettled([
        getJSON(P.forecastHourly, {headers: {Accept: 'application/geo+json'}}),
        getJSON(P.observationStations, {headers: {Accept: 'application/geo+json'}}).then(st => {
          const id = st.features[0].properties.stationIdentifier;
          return getJSON(`https://api.weather.gov/stations/${id}/observations/latest`, {headers: {Accept: 'application/geo+json'}}).then(o => Object.assign({station: id}, o.properties)); })]);
      out.periods = hourly.status === 'fulfilled' ? hourly.value.properties.periods : null;
      out.obs = obs.status === 'fulfilled' ? obs.value : null;
      return out;
    }

    function planDate() { const d = $('plDate').value, t = $('plTime').value || '10:00'; return d ? new Date(d + 'T' + t + ':00') : new Date(); }
    const fmtT = d => d && !isNaN(d) ? d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: S.tz}) : '–';
    const hhmm = d => { if (!d || isNaN(d)) return ''; const s = d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: S.tz}); return s; };

    function forecastAt() {
      const B = S.brief; if (!B || !B.wx || !B.wx.periods) return null;
      const t = planDate().getTime();
      const ps = B.wx.periods;
      return ps.find(p => new Date(p.startTime).getTime() <= t && new Date(p.endTime).getTime() > t) ||
        (ps.length && t < new Date(ps[0].startTime).getTime() ? ps[0] : null);   // planned time already passed today: use the current hour
    }
    const mphToKt = m => Math.round(m * 0.869);
    function windMax(p) { const n = String((p && p.windSpeed) || '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; }

    function summarize() {
      const B = S.brief || {}, grid = B.grid || [], cls = B.cls || [];
      const surface = cls.filter(a => String(pick(a, /^LOWER_CODE$/i)).toUpperCase() === 'SFC' || /E2|E4/i.test(pick(a, /^LOCAL_TYPE$/i)) || +pick(a, /^LOWER_VAL$/i) === 0);
      const top = surface.sort((a, b) => (RANK[String(pick(b, /^CLASS$/i)).toUpperCase()] || 0) - (RANK[String(pick(a, /^CLASS$/i)).toUpperCase()] || 0))[0];
      const ceilings = grid.map(g => +pick(g, /^CEILING$/i)).filter(x => !isNaN(x));
      const ceiling = ceilings.length ? Math.min(...ceilings) : null;
      const gAirport = grid.length ? (pick(grid[0], /APT1_ICAO|APT1_FAAID|APT1_LAANC|ARPT_ID|AIRPORT/i) || '') : '';
      let airspace, risk = 1, laanc = '';
      if (B.gridErr && B.clsErr) { airspace = 'Could not load airspace data'; risk = 2; }
      else if (grid.length || top) {
        const c = top ? String(pick(top, /^CLASS$/i)).toUpperCase() : '';
        airspace = (c ? 'Class ' + c : 'Controlled airspace') + (top && pick(top, /^NAME$/i) ? ' (' + pick(top, /^NAME$/i) + ')' : '');
        laanc = ceiling === null ? 'No LAANC grid here: requires FAA DroneZone authorization' : ceiling === 0 ? 'LAANC ceiling 0 ft: no LAANC, FAA DroneZone authorization needed' : `LAANC grid ceiling ${ceiling} ft AGL${gAirport ? ' (' + gAirport + ')' : ''}`;
        risk = (c === 'B' || c === 'C' || ceiling === 0 || ceiling === null) ? 3 : 2;
      } else { airspace = 'Class G (uncontrolled) at 400 ft AGL and below'; laanc = 'No LAANC authorization needed'; }
      const alt = +$('plAlt').value || 400;
      if (ceiling !== null && ceiling > 0 && alt > ceiling) laanc += ` · planned ${alt} ft is ABOVE the grid ceiling`;
      const tfrs = (B.tfr || []).filter(t => t.inside || t.miles <= 5);
      if (tfrs.some(t => t.inside)) risk = 3;
      const f = forecastAt(), wmph = windMax(f), pop = f && f.probabilityOfPrecipitation ? f.probabilityOfPrecipitation.value : null;
      const sun = S.lat !== null ? sunTimes(planDate(), S.lat, S.lon) : null;
      return {airspace, laanc, ceiling, airspaceRisk: risk, tfrs, f, wmph, wkt: wmph === null ? null : mphToKt(wmph), pop, sun};
    }

    function drawBrief() {
      const box = $('plBrief'), B = S.brief;
      if (!B) { box.innerHTML = ''; return; }
      if (B.loading) { box.innerHTML = `<div class="pcard"><h4>Briefing</h4><p class="note">Checking airspace, TFRs, airports, and weather for ${S.lat}, ${S.lon}…</p></div>`; return; }
      const Z = summarize(), err = m => `<span class="badge grey">${esc(m || 'unavailable')}</span>`;
      const apts = (B.apt || []).map(f => { const a = f.attributes, g = f.geometry || {}; const y = g.y, x = g.x;
        const d = (y !== undefined) ? distMi(S.lat, S.lon, y, x) : null;
        const type = String(pick(a, /^TYPE_CODE$/i)).toUpperCase(); return {name: pick(a, /^NAME$/i), id: pick(a, /^IDENT$|ICAO_ID/i), heli: type === 'HP' || /HELI/i.test(pick(a, /^NAME$/i)), priv: +pick(a, /PRIVATE/i) === 1, d, dir: d === null ? '' : bearing(S.lat, S.lon, y, x)}; })
        .sort((a, b) => (a.d || 99) - (b.d || 99));
      const sua = B.sua || [];
      const f = Z.f, o = B.wx && B.wx.obs;
      const obsTxt = o ? [o.textDescription, o.temperature && o.temperature.value !== null ? Math.round(o.temperature.value * 9 / 5 + 32) + '°F' : '',
        o.windSpeed && o.windSpeed.value !== null ? 'wind ' + Math.round(o.windSpeed.value * 0.54) + ' kt' : '', o.windGust && o.windGust.value !== null ? 'gusts ' + Math.round(o.windGust.value * 0.54) + ' kt' : '',
        o.visibility && o.visibility.value !== null ? 'vis ' + Math.round(o.visibility.value / 1609) + ' SM' : ''].filter(Boolean).join(', ') + ` (${o.station})` : '';
      const rk = Z.airspaceRisk === 3 ? 'red' : Z.airspaceRisk === 2 ? 'amber' : 'green';
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
        <div class="brow"><div class="bl">Forecast (${esc($('plDate').value)} ${esc($('plTime').value)})</div><div>${B.wxErr ? err(B.wxErr) : f ? `${esc(f.shortForecast)}, ${f.temperature}°${f.temperatureUnit}, wind ${esc(f.windDirection)} ${esc(f.windSpeed)}${Z.wkt !== null ? ' (~' + Z.wkt + ' kt)' : ''}${Z.pop !== null ? ', precip ' + Z.pop + '%' : ''}`
          : '<span class="note">Hourly forecast covers about the next 7 days.</span>'}${obsTxt ? `<div class="note">Now: ${esc(obsTxt)}</div>` : ''}</div></div>
        <div class="brow"><div class="bl">Sun</div><div>${Z.sun ? `Civil dawn ${fmtT(Z.sun.dawn)} · Sunrise ${fmtT(Z.sun.sunrise)} · Sunset ${fmtT(Z.sun.sunset)} · Civil dusk ${fmtT(Z.sun.dusk)}` : ''}<div class="note">Flying before civil dawn or after civil dusk is night operations (anti-collision lighting and night training required).</div></div></div>
      </div>`;
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

    // ---- static map image for the PDF (satellite tiles drawn onto a canvas)
    async function mapImage() {
      const W = 768, H = 432, rM = +$('plRadius').value * 0.3048;
      const z = Math.max(12, Math.min(18, Math.floor(Math.log2(156543.034 * Math.cos(S.lat * rad) / (rM / 140)))));
      const n = 2 ** z, px = (S.lon + 180) / 360 * n * 256, py = (1 - Math.log(Math.tan(S.lat * rad) + 1 / Math.cos(S.lat * rad)) / Math.PI) / 2 * n * 256;
      const x0 = px - W / 2, y0 = py - H / 2, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
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
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(W - 34, 8, 26, 30); ctx.fillStyle = '#0b1f33'; ctx.font = 'bold 13px Helvetica'; ctx.fillText('N', W - 25, 22);
      ctx.beginPath(); ctx.moveTo(W - 21, 26); ctx.lineTo(W - 26, 35); ctx.lineTo(W - 16, 35); ctx.fill();
      try { const b = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.85)); return b ? new Uint8Array(await b.arrayBuffer()) : null; } catch (e) { return null; }
    }

    // ---- PDF
    async function makePdf() {
      const {PDFDocument, StandardFonts, rgb} = await X.loadPdfLib();
      const Z = summarize(), B = S.brief, doc = await PDFDocument.create();
      doc.setTitle('OVH-208 Mission Plan'); doc.setAuthor('Overhead UAS');
      const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const NAVY = rgb(0.043, 0.122, 0.2), GREY = rgb(0.36, 0.42, 0.48), RED = rgb(0.78, 0.06, 0.18), LINE = rgb(0.6, 0.65, 0.7);
      const Wp = 612, Hp = 792, M = 44, FW = Wp - 2 * M; let page = doc.addPage([Wp, Hp]), y = Hp - M;
      let logo = null; try { logo = await doc.embedPng(await X.fetchBytes('logo.png')); } catch (e) {}
      const T = (t, x, yy, s = 9.5, f = font, c = rgb(0, 0, 0)) => page.drawText(String(t), {x, y: yy, size: s, font: f, color: c});
      const wrap = (t, s, w, f = font) => { const out = []; for (const para of String(t || '').split(/\n/)) { let line = ''; for (const wd of para.split(/\s+/)) { const tt = line ? line + ' ' + wd : wd; if (f.widthOfTextAtSize(tt, s) > w && line) { out.push(line); line = wd; } else line = tt; } out.push(line); } return out; };
      const clean = t => String(t).replace(/[^\n\x20-\x7E\u00A0-\u00FF]/g, '').replace(/[^\S\n]+/g, ' ').trim();
      const footer = () => { page.drawLine({start: {x: M, y: 40}, end: {x: Wp - M, y: 40}, thickness: 0.5, color: LINE});
        T('Overhead UAS  ·  www.overheaduas.com  ·  (760) 527-3267', M, 28, 7.5, font, GREY); const r = 'OVH-208  ·  Rev. 11/2026'; T(r, Wp - M - font.widthOfTextAtSize(r, 7.5), 28, 7.5, font, GREY); };
      const need = h => { if (y - h < 56) { footer(); page = doc.addPage([Wp, Hp]); y = Hp - M; } };
      const section = t => { need(60); y -= 6; page.drawRectangle({x: M, y: y - 15, width: FW, height: 15, color: NAVY}); T(t, M + 6, y - 11, 8.5, bold, rgb(1, 1, 1)); y -= 19; };
      const row = (label, text, color) => { const lines = wrap(clean(text || '-'), 9.3, FW - 140); need(lines.length * 12 + 6);
        T(label.toUpperCase(), M + 4, y - 10, 7, bold, NAVY); lines.forEach((l, i) => T(l, M + 136, y - 10 - i * 12, 9.3, font, color || rgb(0, 0, 0)));
        y -= lines.length * 12 + 6; page.drawLine({start: {x: M, y: y + 2}, end: {x: Wp - M, y: y + 2}, thickness: 0.3, color: LINE}); };
      if (logo) page.drawImage(logo, {x: Wp - M - 58, y: Hp - M - 54, width: 58, height: 58});
      T('MISSION PLAN', M, y - 18, 20, bold, NAVY); T('OVERHEAD UAS', M, y - 32, 9, bold, RED); T('OVH-208  ·  Rev. 11/2026  ·  Created ' + X.nowStamp(), M, y - 44, 7.5, font, GREY);
      y -= 64;
      const pilot = (X.profile && X.profile.name) || (X.me && X.me.name) || '';
      row('Mission', $('plMission').value); row('Pilot', pilot + (X.profile && X.profile.cert ? '  ·  Part 107 #' + X.profile.cert : ''));
      row('Planned', `${X.usDate($('plDate').value)} at ${$('plTime').value}  ·  radius ${$('plRadius').selectedOptions[0].text}  ·  max ${$('plAlt').value} ft AGL`);
      row('Location', (S.address ? S.address + '  ·  ' : '') + `${S.lat}, ${S.lon}`);
      const img = await mapImage();
      if (img) { try { const im = await doc.embedJpg(img), h = FW * im.height / im.width; need(h + 8); page.drawImage(im, {x: M, y: y - h, width: FW, height: h});
        page.drawRectangle({x: M, y: y - h, width: FW, height: h, borderColor: LINE, borderWidth: 0.6}); y -= h + 4; T('Imagery: Esri, Maxar, Earthstar Geographics. Red circle = planned flight radius.', M, y - 8, 6.8, font, GREY); y -= 12; } catch (e) {} }
      section('AIRSPACE & RESTRICTIONS');
      row('Airspace', B.gridErr && B.clsErr ? 'Unavailable - verify in B4UFLY / LAANC app' : Z.airspace, Z.airspaceRisk === 3 ? RED : null);
      row('LAANC', Z.laanc);
      row('TFRs', B.tfrErr ? 'Check unavailable - verify at tfr.faa.gov' : !(B.tfr || []).length ? 'None within 30 mi' : (B.tfr || []).slice(0, 6).map(t => (t.inside ? 'INSIDE: ' : t.miles.toFixed(1) + ' mi: ') + t.title).join('\n'), (B.tfr || []).some(t => t.inside) ? RED : null);
      const apts = (B.apt || []).map(f => { const a = f.attributes, g = f.geometry || {}; const d = g.y !== undefined ? distMi(S.lat, S.lon, g.y, g.x) : null;
        return `${pick(a, /^IDENT$|ICAO_ID/i)} ${pick(a, /^NAME$/i)}${d === null ? '' : '  ' + d.toFixed(1) + ' mi ' + bearing(S.lat, S.lon, g.y, g.x)}`; });
      row('Airports / heliports', B.aptErr ? 'Unavailable' : apts.length ? apts.slice(0, 6).join('\n') : 'None within 5 mi');
      row('Special use airspace', B.suaErr ? 'Unavailable' : (B.sua || []).length ? (B.sua || []).map(a => `${pick(a, /^TYPE_CODE$/i)} ${pick(a, /^NAME$/i)}`).join('\n') : 'None within 3 mi');
      section('WEATHER & LIGHT');
      row('Forecast', Z.f ? `${Z.f.shortForecast}, ${Z.f.temperature}°${Z.f.temperatureUnit}, wind ${Z.f.windDirection} ${Z.f.windSpeed}${Z.wkt !== null ? ' (~' + Z.wkt + ' kt)' : ''}${Z.pop !== null ? ', precipitation ' + Z.pop + '%' : ''}` : 'Not available for this date - check before flight');
      if (Z.sun) row('Sun', `Civil dawn ${fmtT(Z.sun.dawn)}  ·  Sunrise ${fmtT(Z.sun.sunrise)}  ·  Sunset ${fmtT(Z.sun.sunset)}  ·  Civil dusk ${fmtT(Z.sun.dusk)}`);
      section('HAZARDS & NOTES');
      row('Pilot notes', $('plNotes').value || 'None entered');
      section('BEFORE FLIGHT');
      ['Airspace and TFRs re-checked in B4UFLY / LAANC app on flight day', 'LAANC authorization obtained (if controlled airspace)', 'OVH-205 Risk Assessment completed', 'OVH-201 Mission Sheet and OVH-101 Preflight Checklist'].forEach(t => {
        need(16); page.drawRectangle({x: M + 4, y: y - 12, width: 9, height: 9, borderColor: NAVY, borderWidth: 0.8}); T(t, M + 20, y - 10.5, 9.2); y -= 16; });
      y -= 4; wrap('Planning aid only, compiled from FAA, National Weather Service, and OpenStreetMap public data at the time shown. Data can change and may be incomplete. The remote pilot in command must verify airspace, TFRs, and NOTAMs with official sources before flight.', 7.4, FW).forEach(l => { need(10); T(l, M, y - 8, 7.4, font, GREY); y -= 10; });
      footer();
      return doc.save();
    }

    const msg = (t, bad) => { $('plMsg').innerHTML = t; $('plMsg').className = 'plan-msg ' + (bad ? 'bad' : 'good'); };
    $('plPdf').onclick = async e => {
      if (!S.brief || S.brief.loading) return msg('Drop a pin and wait for the briefing first.', true);
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Creating…';
      try {
        const bytes = await makePdf(), tag = ($('plMission').value || S.address.split(',')[0] || 'Plan').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
        const name = `OVH-208_Mission_Plan_${tag}_${X.usDate($('plDate').value).replace(/\//g, '-')}.pdf`;
        const file = new File([bytes], name, {type: 'application/pdf'}), url = URL.createObjectURL(file);
        msg(`<b>&#10003; Mission plan ready.</b> <a href="${url}" target="_blank" rel="noopener">Open / print</a> · <a href="#" data-dl>Save to this device</a> · <a href="#" data-share>Share</a> <span class="note" data-drive></span>`);
        $('plMsg').querySelector('[data-dl]').onclick = ev => { ev.preventDefault(); X.saveBlob(url, name); };
        $('plMsg').querySelector('[data-share]').onclick = async ev => { ev.preventDefault(); const r = await X.shareFile(file, 'Overhead UAS mission plan'); if (r === false) X.saveBlob(url, name); };
        if (X.submit && X.submit.url) {
          fetch(X.submit.url, {method: 'POST', body: JSON.stringify({token: X.submit.token, filename: name, pdf: X.toB64(bytes), folder: 'Mission Plans', quiet: true,
            subject: 'Mission plan: ' + ($('plMission').value || S.address), lines: ['Form: OVH-208']})}).then(r => r.json())
            .then(j => { const d = $('plMsg').querySelector('[data-drive]'); if (d) d.textContent = j.ok ? '· Saved to Overhead UAS records' : ''; }).catch(() => {});
        }
      } catch (x) { msg('Could not create the PDF (' + esc(x.message) + ').', true); }
      finally { b.disabled = false; b.textContent = 'Create mission plan (PDF)'; }
    };
    $('plSend').onclick = () => {
      if (!S.brief || S.brief.loading) return msg('Drop a pin and wait for the briefing first.', true);
      const Z = summarize(), f = Z.f;
      const plan = {created: Date.now(), mission: $('plMission').value, date: $('plDate').value, time: $('plTime').value, lat: S.lat, lon: S.lon, address: S.address,
        airspace: Z.airspace + (Z.laanc ? ' · ' + Z.laanc : ''), sunset: Z.sun ? hhmm(Z.sun.sunset) : '',
        weather: f ? `${f.shortForecast}, ${f.temperature}°${f.temperatureUnit}, wind ${f.windDirection} ${f.windSpeed}${Z.pop !== null ? ', precip ' + Z.pop + '%' : ''}` : '',
        hazards: [$('plNotes').value, ...Z.tfrs.map(t => 'TFR: ' + t.title)].filter(Boolean).join('; '),
        risk: {wind: Z.wkt === null ? 0 : Z.wkt < 10 ? 1 : Z.wkt <= 20 ? 2 : 3, precip: Z.pop === null ? 0 : Z.pop >= 60 ? 3 : Z.pop >= 25 ? 2 : 1, airspace: Z.airspaceRisk}};
      try { localStorage.setItem('ouas_plan', JSON.stringify(plan)); } catch (e) {}
      msg('<b>&#10003; Sent.</b> Open <a href="#forms">Forms</a> → OVH-201 Mission Sheet or OVH-205 Risk Assessment and tap Fill out. The plan details fill in automatically.');
    };
  }
})();
