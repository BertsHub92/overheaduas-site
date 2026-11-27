/* Overhead UAS - Mapping flight planner (Pilot Portal view #mapping).
 * Draw an area on satellite imagery, pick a drone, and get a lawnmower grid with photo spacing worked out from the
 * camera specs. Exports Litchi Mission Hub CSV (photo-by-distance, split at 99 waypoints) and DJI Pilot 2 KMZ (WPML)
 * for the Mavic 3 Thermal. Plans save to the Overhead UAS Pilot Records sheet through the portal script.
 * Loaded on first use, after Leaflet, like planner.js. */
(() => {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const FT = 0.3048, MPH = 0.44704, R_EARTH = 6378137, RAD = Math.PI / 180;
  // Camera presets. sw/sh = sensor width/height (mm), f = real focal length (mm), iw/ih = photo size (px),
  // minInt = shortest reliable time between photos (s), batt = planning minutes per battery (about 65% of rated).
  const DRONES = {
    mavicpro: {name: 'DJI Mavic Pro', sw: 6.17, sh: 4.55, f: 4.73, iw: 4000, ih: 3000, minInt: 2, batt: 18, rated: 27, kmz: false, litchi: true, note: '12 MP, 1/2.3" sensor'},
    air2: {name: 'DJI Mavic Air 2', sw: 6.4, sh: 4.8, f: 4.49, iw: 4000, ih: 3000, minInt: 2, batt: 22, rated: 34, kmz: false, litchi: true, note: '12 MP photo mode, 1/2" sensor'},
    m3t: {name: 'DJI Mavic 3 Thermal (wide camera)', sw: 6.4, sh: 4.8, f: 4.4, iw: 8000, ih: 6000, minInt: 0.7, batt: 30, rated: 45, kmz: true, litchi: false, note: '48 MP wide camera, 1/2" sensor'}
  };

  // ---------------- geometry (pure, testable) ----------------
  function camera(d, altM, front, side) {
    const across = d.sw * altM / d.f, along = d.sh * altM / d.f;   // footprint (m); image long side is across the flight line
    return {gsd: d.sw * altM / (d.f * d.iw) * 100, across, along, lineSp: across * (1 - side / 100), photoSp: along * (1 - front / 100)};
  }
  function projector(poly) {
    const lat0 = poly.reduce((s, p) => s + p[0], 0) / poly.length, lon0 = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const kx = R_EARTH * Math.cos(lat0 * RAD) * RAD, ky = R_EARTH * RAD;
    return {to: p => [(p[1] - lon0) * kx, (p[0] - lat0) * ky], from: xy => [lat0 + xy[1] / ky, lon0 + xy[0] / kx]};
  }
  function areaM2(poly) {
    if (!poly || poly.length < 3) return 0;
    const P = projector(poly), xy = poly.map(P.to); let a = 0;
    for (let i = 0; i < xy.length; i++) { const p = xy[i], q = xy[(i + 1) % xy.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  }
  // Bearing (0-180) of the polygon's longest edge: flying along it gives the fewest turns for most fields
  function longestEdgeDir(poly) {
    const P = projector(poly), xy = poly.map(P.to); let best = 0, dir = 0;
    for (let i = 0; i < xy.length; i++) { const p = xy[i], q = xy[(i + 1) % xy.length], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
      if (L > best) { best = L; dir = ((Math.atan2(dx, dy) / RAD) % 180 + 180) % 180; } }
    return Math.round(dir);
  }
  // Lawnmower lines across the polygon. dirDeg = compass direction of the flight lines (0 = north-south).
  // Returns segments in flight order as [[lat,lng],[lat,lng]], alternating direction line by line.
  function grid(poly, dirDeg, lineSp, maxLines = 3000) {
    if (!poly || poly.length < 3 || !(lineSp > 0.5)) return [];
    const P = projector(poly), th = dirDeg * RAD, s = Math.sin(th), c = Math.cos(th);
    const uv = poly.map(P.to).map(([x, y]) => [x * s + y * c, -x * c + y * s]);   // u along the lines, v across
    const vs = uv.map(p => p[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const n = Math.max(1, Math.ceil((vmax - vmin) / lineSp)); if (n > maxLines) throw new Error('too many lines');
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = vmin + lineSp / 2 + i * lineSp, xs = [];
      for (let k = 0; k < uv.length; k++) { const a = uv[k], b = uv[(k + 1) % uv.length];
        if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + (v - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); }
      xs.sort((p, q) => p - q);
      let segs = [];
      for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > 1) segs.push([xs[k], xs[k + 1]]);
      if (i % 2) segs = segs.reverse().map(([a, b]) => [b, a]);
      for (const [u1, u2] of segs) out.push([[u1, v], [u2, v]].map(([u, w]) => P.from([u * s - w * c, u * c + w * s])));
    }
    return out;
  }
  function distM(a, b) { const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD, x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2; return 2 * R_EARTH * Math.asin(Math.sqrt(x)); }
  function bearing(a, b) { const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD), x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; }
  const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  // Route = flight lines, each with waypoints (pts) and heights above takeoff (h, meters).
  // Flat: 2 waypoints per line at the set altitude. Terrain: extra waypoints every k photo spacings (so photos stay
  // evenly spaced), each set to altitude + (highest ground near it - ground at takeoff).
  function flatRoute(segs, altM) { return segs.map(s => ({pts: [s[0], s[1]], h: [altM, altM]})); }
  function lineStations(seg, photoSp, maxSpacing) {     // distances (m) along a line for waypoints
    const L = distM(seg[0], seg[1]), step = photoSp * Math.max(1, Math.floor(maxSpacing / photoSp)), d = [0];
    for (let x = step; x < L - step * 0.25; x += step) d.push(x);
    d.push(L); return {L, d};
  }
  function terrainSamples(segs, photoSp, maxSpacing, stepM) {   // every point we need ground elevation for
    const lines = segs.map(seg => { const st = lineStations(seg, photoSp, maxSpacing), t = new Set(st.d);
      for (let x = 0; x < st.L; x += stepM) t.add(x);
      const ts = [...t].sort((a, b) => a - b); return {seg, L: st.L, d: st.d, ts, sp: ts.map(x => lerp(seg[0], seg[1], st.L ? x / st.L : 0))}; });
    return lines;
  }
  function terrainRoute(lines, elevOf, altM, homeE) {
    let gMin = Infinity, gMax = -Infinity, hMin = Infinity, hMax = -Infinity;
    const route = lines.map(ln => {
      const e = ln.sp.map(elevOf); e.forEach(v => { gMin = Math.min(gMin, v); gMax = Math.max(gMax, v); });
      const h = ln.d.map((x, k) => { const lo = k ? ln.d[k - 1] : 0, hi = k < ln.d.length - 1 ? ln.d[k + 1] : ln.L; let m = -Infinity;
        ln.ts.forEach((t, j) => { if (t >= lo - 0.01 && t <= hi + 0.01) m = Math.max(m, e[j]); });
        const v = altM + m - homeE; hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); return v; });
      return {pts: ln.d.map(x => lerp(ln.seg[0], ln.seg[1], ln.L ? x / ln.L : 0)), h};
    });
    return {route, gMin, gMax, hMin, hMax};
  }
  function stats(route, cam, speedMs, d) {
    let lineDist = 0, transit = 0, photos = 0, wps = 0;
    route.forEach((ln, i) => { const L = distM(ln.pts[0], ln.pts[ln.pts.length - 1]); lineDist += L; photos += Math.ceil(L / cam.photoSp) + 1; wps += ln.pts.length;
      if (i) { const prev = route[i - 1].pts; transit += distM(prev[prev.length - 1], ln.pts[0]); } });
    const secs = (lineDist + transit) / speedMs + route.length * 6 + (wps - route.length * 2) * 0.5 + 90;   // ~3 s per stop at line ends, 90 s takeoff / climb / return
    return {lineDist, transit, dist: lineDist + transit, photos, wps, lines: route.length, secs, batteries: Math.max(1, Math.ceil(secs / 60 / d.batt)),
      interval: cam.photoSp / speedMs, maxSpeed: cam.photoSp / d.minInt};
  }

  // ---------------- exports ----------------
  const LITCHI_HEAD = ['latitude', 'longitude', 'altitude(m)', 'heading(deg)', 'curvesize(m)', 'rotationdir', 'gimbalmode', 'gimbalpitchangle']
    .concat(...Array.from({length: 15}, (_, i) => ['actiontype' + (i + 1), 'actionparam' + (i + 1)]))
    .concat(['altitudemode', 'speed(m/s)', 'poi_latitude', 'poi_longitude', 'poi_altitude(m)', 'poi_altitudemode', 'photo_timeinterval', 'photo_distinterval']).join(',');
  // First waypoint of a line tilts the camera and starts photos every photoSp meters; middle waypoints (terrain) keep
  // shooting and use curved turns so the drone flies through them; the last waypoint takes the final photo.
  // Lines are kept whole in one mission (a line longer than 99 waypoints is split), missions hold up to 99 waypoints.
  function litchiCsvs(route, speedMs, photoSp, maxWp = 99) {
    const pieces = [];
    route.forEach(ln => { for (let i = 0; i < ln.pts.length - 1; i += maxWp - 1) { const j = Math.min(ln.pts.length, i + maxWp); pieces.push({pts: ln.pts.slice(i, j), h: ln.h.slice(i, j)}); } });
    const parts = []; let cur = [], n = 0;
    pieces.forEach(pc => { if (n + pc.pts.length > maxWp && cur.length) { parts.push(cur); cur = []; n = 0; } cur.push(pc); n += pc.pts.length; });
    if (cur.length) parts.push(cur);
    return parts.map(part => {
      const rows = [LITCHI_HEAD]; let wps = 0;
      for (const ln of part) {
        const last = ln.pts.length - 1, hd = Math.round(bearing(ln.pts[0], ln.pts[last])) % 360, curve = last > 1 ? Math.min(20, distM(ln.pts[0], ln.pts[1]) * 0.3) : 0;
        ln.pts.forEach((p, k) => {
          const acts = k === 0 ? [[5, -90], [1, 0]] : k === last ? [[1, 0]] : [];
          const A = acts.concat(Array(15 - acts.length).fill([-1, 0])).flat();
          rows.push([p[0].toFixed(7), p[1].toFixed(7), ln.h[k].toFixed(1), hd, k > 0 && k < last ? curve.toFixed(1) : 0, 0, 2, -90].concat(A, [0, speedMs.toFixed(1), 0, 0, 0, 0, -1, k < last ? photoSp.toFixed(1) : -1]).join(','));
          wps++;
        });
      }
      return {text: rows.join('\n') + '\n', wps};
    });
  }
  const xmlEsc = t => String(t).replace(/[<>&'"]/g, ch => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'}[ch]));
  // DJI Pilot 2 waypoint route (WPML 1.0.2) for the Mavic 3 Thermal: drone 77 / sub 1, payload 67, wide lens.
  // Heights are per waypoint (relative to takeoff); photos fire every photoSp meters from the start to the end of each line.
  function djiKmz(route, speedMs, photoSp, name, st) {
    const now = Date.now(), v = speedMs.toFixed(1), pts = [], starts = [], ends = [];
    route.forEach(ln => { starts.push(pts.length); ln.pts.forEach((p, k) => pts.push({p, h: ln.h[k], mid: k > 0 && k < ln.pts.length - 1})); ends.push(pts.length - 1); });
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">\n<Document>\n`;
    const mission = `<wpml:missionConfig>
  <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
  <wpml:finishAction>goHome</wpml:finishAction>
  <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
  <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
  <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
  <wpml:globalTransitionalSpeed>${v}</wpml:globalTransitionalSpeed>
  <wpml:droneInfo><wpml:droneEnumValue>77</wpml:droneEnumValue><wpml:droneSubEnumValue>1</wpml:droneSubEnumValue></wpml:droneInfo>
  <wpml:payloadInfo><wpml:payloadEnumValue>67</wpml:payloadEnumValue><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:payloadInfo>
</wpml:missionConfig>\n`;
    let gid = 0;
    const gimbal = idx => `<wpml:actionGroup><wpml:actionGroupId>${gid++}</wpml:actionGroupId><wpml:actionGroupStartIndex>${idx}</wpml:actionGroupStartIndex><wpml:actionGroupEndIndex>${idx}</wpml:actionGroupEndIndex><wpml:actionGroupMode>sequence</wpml:actionGroupMode>
  <wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>
  <wpml:action><wpml:actionId>0</wpml:actionId><wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc><wpml:actionActuatorFuncParam>
    <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase><wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
    <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable><wpml:gimbalPitchRotateAngle>-90</wpml:gimbalPitchRotateAngle>
    <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable><wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
    <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable><wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
    <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable><wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
    <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:actionActuatorFuncParam></wpml:action>
</wpml:actionGroup>\n`;
    const shoot = (a, b) => `<wpml:actionGroup><wpml:actionGroupId>${gid++}</wpml:actionGroupId><wpml:actionGroupStartIndex>${a}</wpml:actionGroupStartIndex><wpml:actionGroupEndIndex>${b}</wpml:actionGroupEndIndex><wpml:actionGroupMode>sequence</wpml:actionGroupMode>
  <wpml:actionTrigger><wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType><wpml:actionTriggerParam>${photoSp.toFixed(2)}</wpml:actionTriggerParam></wpml:actionTrigger>
  <wpml:action><wpml:actionId>0</wpml:actionId><wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc><wpml:actionActuatorFuncParam>
    <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex><wpml:fileSuffix>${xmlEsc(String(name).replace(/[^\w-]+/g, '_').slice(0, 30))}</wpml:fileSuffix>
    <wpml:payloadLensIndex>wide</wpml:payloadLensIndex><wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex></wpml:actionActuatorFuncParam></wpml:action>
</wpml:actionGroup>\n`;
    const groups = i => (i === 0 ? gimbal(0) : '') + (starts.includes(i) ? shoot(i, ends[starts.indexOf(i)]) : '');
    const turn = mid => `<wpml:waypointTurnParam><wpml:waypointTurnMode>${mid ? 'toPointAndPassWithContinuityCurvature' : 'toPointAndStopWithDiscontinuityCurvature'}</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam>`;
    const coord = p => `${p[1].toFixed(8)},${p[0].toFixed(8)}`;
    let tpl = head + `<wpml:author>Overhead UAS</wpml:author>\n<wpml:createTime>${now}</wpml:createTime>\n<wpml:updateTime>${now}</wpml:updateTime>\n` + mission +
`<Folder>
<wpml:templateType>waypoint</wpml:templateType>
<wpml:templateId>0</wpml:templateId>
<wpml:waylineCoordinateSysParam><wpml:coordinateMode>WGS84</wpml:coordinateMode><wpml:heightMode>relativeToStartPoint</wpml:heightMode></wpml:waylineCoordinateSysParam>
<wpml:autoFlightSpeed>${v}</wpml:autoFlightSpeed>
<wpml:globalHeight>${pts[0].h.toFixed(1)}</wpml:globalHeight>
<wpml:caliFlightEnable>0</wpml:caliFlightEnable>
<wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
<wpml:globalWaypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint><wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex></wpml:globalWaypointHeadingParam>
<wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
<wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>\n`;
    gid = 0;
    pts.forEach((w, i) => { const h = w.h.toFixed(1); tpl += `<Placemark><Point><coordinates>${coord(w.p)}</coordinates></Point>
<wpml:index>${i}</wpml:index><wpml:ellipsoidHeight>${h}</wpml:ellipsoidHeight><wpml:height>${h}</wpml:height>
<wpml:useGlobalHeight>0</wpml:useGlobalHeight><wpml:useGlobalSpeed>1</wpml:useGlobalSpeed><wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>${w.mid ? '<wpml:useGlobalTurnParam>0</wpml:useGlobalTurnParam>' + turn(true) : '<wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>'}<wpml:useStraightLine>1</wpml:useStraightLine>
${groups(i)}</Placemark>\n`; });
    tpl += `</Folder>\n</Document>\n</kml>\n`;
    gid = 0;
    let wl = head + mission + `<Folder>
<wpml:templateId>0</wpml:templateId>
<wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
<wpml:waylineId>0</wpml:waylineId>
<wpml:distance>${st.dist.toFixed(1)}</wpml:distance>
<wpml:duration>${Math.round(st.secs)}</wpml:duration>
<wpml:autoFlightSpeed>${v}</wpml:autoFlightSpeed>\n`;
    pts.forEach((w, i) => { wl += `<Placemark><Point><coordinates>${coord(w.p)}</coordinates></Point>
<wpml:index>${i}</wpml:index><wpml:executeHeight>${w.h.toFixed(1)}</wpml:executeHeight><wpml:waypointSpeed>${v}</wpml:waypointSpeed>
<wpml:waypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint><wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode></wpml:waypointHeadingParam>
${turn(w.mid)}
<wpml:useStraightLine>1</wpml:useStraightLine>
${groups(i)}</Placemark>\n`; });
    wl += `</Folder>\n</Document>\n</kml>\n`;
    const enc = new TextEncoder();
    return zip([{name: 'wpmz/template.kml', data: enc.encode(tpl)}, {name: 'wpmz/waylines.wpml', data: enc.encode(wl)}]);
  }
  // Minimal ZIP writer (stored, no compression): enough for KMZ files and bundling CSV parts
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), now = new Date(), chunks = [], central = [];
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, s]) => s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true));
      chunks.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, n, 4], [24, n, 4], [28, name.length, 2],
       [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]].forEach(([o, v, s]) => s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true));
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + n;
    }
    const csize = central.reduce((s, c) => s + c.length, 0), end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, csize, 4], [16, off, 4], [20, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
    const all = chunks.concat(central, [new Uint8Array(end.buffer)]), out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------------- UI ----------------
  function mount(root, X) {
    if (root._mapping) { setTimeout(() => root._mapping.map.invalidateSize(), 50); return; }
    const esc = X.esc, $ = id => root.querySelector('#' + id);
    const S = {poly: [], drawing: false, planId: '', planMine: true, segs: [], route: null, cam: null, st: null, home: null, placingHome: false, tinfo: null, elevSrc: ''};
    const fmtFt = m => Math.round(m / FT).toLocaleString() + ' ft', fmtMi = m => (m / 1609.344).toFixed(m < 1609 ? 2 : 1) + ' mi';
    root.innerHTML = `
      <div class="view-head"><a href="#missions" class="back-btn">&lsaquo; Missions</a><h2>Mapping Flight Plan</h2></div>
      <div class="pcard plan-card">
        <div class="plan-search"><input type="search" id="mpSearch" placeholder="Search an address or place" autocomplete="off">
          <button class="btn btn-primary sm" id="mpGo">Search</button><button class="btn btn-ghost sm" id="mpMe" title="Use my location">&#9678; Me</button></div>
        <div class="plan-results" id="mpResults" hidden></div>
        <div class="mp-wrap" id="mpWrap">
          <div class="mp-tools">
            <button class="btn btn-primary sm" id="mpDraw">&#9998; Draw area</button>
            <button class="btn btn-ghost sm" id="mpUndo">&#8630; Undo point</button>
            <button class="btn btn-ghost sm" id="mpClear">Clear</button>
            <button class="btn btn-ghost sm" id="mpFull">&#10530; Full screen</button>
          </div>
          <div id="mpMap" class="mp-map"></div>
          <div class="mp-strip" id="mpStrip">Tap <b>Draw area</b>, then tap the map to outline the area to map.</div>
        </div>
        <p class="note">Tap <b>Draw area</b> and tap the corners of the area. Drag a corner to move it, or tap a small <b>+</b> on an edge to add a corner. Tap <b>Done</b> when finished.</p>
      </div>
      <div class="mp-cols">
      <div class="pcard"><h4>Drone &amp; flight settings</h4>
        <div class="grid2 plan-inputs mp-inputs">
          <div class="wide"><label>Drone / camera</label><select id="mpDrone">${Object.entries(DRONES).map(([k, d]) => `<option value="${k}">${esc(d.name)}</option>`).join('')}</select><small class="hint-last" id="mpDroneNote"></small></div>
          <div><label>Altitude (ft AGL)</label><input type="number" id="mpAlt" value="200" min="30" max="400" step="10" inputmode="numeric"></div>
          <div><label>Flight speed (mph)</label><input type="number" id="mpSpeed" value="11" min="2" max="30" step="0.5" inputmode="decimal"></div>
          <div><label>Front overlap (%)</label><input type="number" id="mpFront" value="75" min="50" max="90" step="1" inputmode="numeric"></div>
          <div><label>Side overlap (%)</label><input type="number" id="mpSide" value="70" min="40" max="90" step="1" inputmode="numeric"></div>
          <div class="wide"><label>Grid direction (&deg;, direction of the flight lines)</label>
            <div class="mp-dir"><input type="range" id="mpDirR" min="0" max="179" value="0"><input type="number" id="mpDir" value="0" min="0" max="179" inputmode="numeric"><button class="btn btn-ghost sm" id="mpAuto" type="button">Auto</button></div>
            <small class="hint-last">0&deg; = north&ndash;south lines, 90&deg; = east&ndash;west. <b>Auto</b> lines up with the longest edge for the fewest turns.</small></div>
          <div class="wide mp-terr"><label class="remember"><input type="checkbox" id="mpTerr">Terrain following: keep the same height above the ground on hills</label>
            <div id="mpTerrOpts" hidden>
              <div class="mp-dir"><button class="btn btn-ghost sm" type="button" id="mpHome">&#128205; Set takeoff point</button><span class="note" id="mpHomeTxt">Not set</span></div>
              <label>Max distance between waypoints (ft)</label><input type="number" id="mpWpFt" value="200" min="30" max="1500" step="10" inputmode="numeric">
              <small class="hint-last">Shorter follows the ground more closely but adds waypoints. Uses USGS elevation data (bare ground: it doesn't include trees or buildings).</small></div></div>
        </div></div>
      <div class="pcard"><h4>Plan</h4><div id="mpStats"><p class="note">Draw an area to see the flight plan.</p></div></div>
      </div>
      <div class="pcard"><h4>Export</h4>
        <div class="grid2 plan-inputs"><div class="wide"><label>Mission name</label><input type="text" id="mpName" maxlength="60" placeholder="e.g. Fallbrook grove north block"></div></div>
        <div id="mpExport"><p class="note">Draw an area first.</p></div>
        <details class="mp-help"><summary>How to load the files</summary><ul>
          <li><b>Litchi:</b> on a computer, open Litchi Mission Hub (flylitchi.com/hub) &rarr; <b>Missions &rarr; Import</b> &rarr; choose the CSV. Import each part if there's more than one. Check the mission is set to <b>Straight lines</b> and <b>Altitude above takeoff</b>, save, then open it in the Litchi app.</li>
          <li><b>DJI Pilot 2 (Mavic 3 Thermal):</b> copy the KMZ to the controller (USB or SD card), then in DJI Pilot 2 open <b>Flight Route &rarr; Import Route (KMZ/KML)</b>. Open the route and check the lines and photo settings before flying.</li>
          <li><b>Terrain following:</b> take off exactly at the <b>H</b> you set. Waypoint heights already include the rise and fall of the ground, so the drone holds your altitude above the ground. In Litchi, set <b>Path mode: Curved turns</b>.</li>
          <li>Heights are above the <b>takeoff point</b>. Take off from about the same ground level as the area, and check for trees, towers, and rising ground.</li></ul></details>
      </div>
      <div class="pcard"><div class="pcard-top"><h4>Saved plans</h4><button class="btn btn-primary sm" id="mpSave">Save plan</button></div>
        <span class="save-msg" id="mpSaveMsg"></span>
        <div id="mpSaved"><p class="note">Loading…</p></div></div>
      <p class="note">This is a planning aid. Check airspace (use Flight Briefing or your LAANC app), obstacles, and terrain before every flight. Heights are relative to takeoff and don't follow terrain.</p>`;

    // ---- map
    const sat = L.tileLayer(ESRI, {maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'});
    const streets = L.tileLayer(OSM, {maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors'});
    const map = L.map($('mpMap'), {layers: [sat], zoomControl: true, tap: true}).setView([33.1581, -117.3506], 12);
    L.control.layers({'Satellite': sat, 'Streets': streets}, null, {collapsed: true}).addTo(map);
    L.control.scale({imperial: true, metric: false}).addTo(map);
    root._mapping = {map};
    const shapeL = L.layerGroup().addTo(map), lineL = L.layerGroup().addTo(map), handleL = L.layerGroup().addTo(map);
    const vIcon = L.divIcon({className: 'mp-v', iconSize: [22, 22]}), mIcon = L.divIcon({className: 'mp-mid', html: '+', iconSize: [18, 18]});
    const tag = (t, cls) => L.divIcon({className: 'mp-tag ' + cls, html: t, iconSize: [22, 22]});

    function drawShape() {
      shapeL.clearLayers(); handleL.clearLayers();
      if (S.poly.length >= 2) (S.poly.length >= 3 ? L.polygon(S.poly, {color: '#ffd23f', weight: 2, fillOpacity: 0.12}) : L.polyline(S.poly, {color: '#ffd23f', weight: 2})).addTo(shapeL);
      S.poly.forEach((p, i) => {
        const m = L.marker(p, {icon: vIcon, draggable: true, keyboard: false}).addTo(handleL);
        m.on('drag', e => { const ll = e.target.getLatLng(); S.poly[i] = [ll.lat, ll.lng]; shapeL.clearLayers(); (S.poly.length >= 3 ? L.polygon(S.poly, {color: '#ffd23f', weight: 2, fillOpacity: 0.12}) : L.polyline(S.poly, {color: '#ffd23f', weight: 2})).addTo(shapeL); });
        m.on('dragend', () => { drawShape(); recalc(); });
      });
      if (S.poly.length >= 3) S.poly.forEach((p, i) => { const q = S.poly[(i + 1) % S.poly.length];
        L.marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], {icon: mIcon, keyboard: false}).addTo(handleL)
          .on('click', () => { S.poly.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]); drawShape(); recalc(); }); });
      $('mpUndo').disabled = !S.poly.length; $('mpClear').disabled = !S.poly.length;
    }
    function setDrawing(on) {
      S.drawing = on; $('mpDraw').innerHTML = on ? '&#10003; Done' : (S.poly.length ? '&#9998; Edit area' : '&#9998; Draw area');
      $('mpDraw').classList.toggle('btn-primary', !on || S.poly.length < 3); $('mpWrap').classList.toggle('drawing', on);
      if (on && S.poly.length < 3) $('mpStrip').innerHTML = 'Tap the map to add corners of the area.';
      if (!on) recalc();
    }
    const homeIcon = L.divIcon({className: 'mp-tag home', html: 'H', iconSize: [24, 24]}); let homeM = null;
    function drawHome() {
      if (homeM) { homeM.remove(); homeM = null; }
      $('mpHomeTxt').textContent = S.home ? `${S.home[0].toFixed(5)}, ${S.home[1].toFixed(5)} (drag the H to move it)` : 'Not set';
      $('mpHome').innerHTML = S.placingHome ? 'Tap the map&hellip;' : S.home ? '&#128205; Move takeoff point' : '&#128205; Set takeoff point';
      if (!S.home || !$('mpTerr').checked) return;
      homeM = L.marker(S.home, {icon: homeIcon, draggable: true, keyboard: false, zIndexOffset: 1000}).addTo(map);
      homeM.on('dragend', e => { const ll = e.target.getLatLng(); S.home = [ll.lat, ll.lng]; drawHome(); recalc(); });
    }
    $('mpHome').onclick = () => { S.placingHome = true; drawHome(); $('mpStrip').innerHTML = 'Tap the map where you will take off.'; $('mpWrap').scrollIntoView({behavior: 'smooth', block: 'start'}); };
    $('mpTerr').onchange = () => { drawHome(); recalc(); };
    $('mpWpFt').addEventListener('input', recalc);
    map.on('click', e => { if (S.placingHome) { S.placingHome = false; S.home = [e.latlng.lat, e.latlng.lng]; drawHome(); recalc(); return; }
      if (!S.drawing) return; S.poly.push([e.latlng.lat, e.latlng.lng]); drawShape(); if (S.poly.length >= 3) recalc(); else $('mpStrip').innerHTML = `${S.poly.length} corner${S.poly.length > 1 ? 's' : ''} &middot; add at least 3`; });
    $('mpDraw').onclick = () => setDrawing(!S.drawing);
    $('mpUndo').onclick = () => { S.poly.pop(); drawShape(); recalc(); };
    $('mpClear').onclick = () => { if (S.poly.length && !confirm('Clear the area?')) return; S.poly = []; S.planId = ''; S.home = null; drawHome(); drawShape(); recalc(); setDrawing(true); };
    const full = on => { $('mpWrap').classList.toggle('mp-full', on); document.body.style.overflow = on ? 'hidden' : ''; $('mpFull').innerHTML = on ? '&times; Exit full screen' : '&#10530; Full screen'; setTimeout(() => map.invalidateSize(), 60); };
    $('mpFull').onclick = () => full(!$('mpWrap').classList.contains('mp-full'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('mpWrap') && $('mpWrap').classList.contains('mp-full')) full(false); });
    window.addEventListener('hashchange', () => { if ($('mpWrap') && $('mpWrap').classList.contains('mp-full')) full(false); });

    // ---- search / locate
    const search = async () => {
      const q = $('mpSearch').value.trim(); if (!q) return; const box = $('mpResults'); box.hidden = false; box.innerHTML = '<p class="note">Searching…</p>';
      try { const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&q=' + encodeURIComponent(q))).json();
        if (!r.length) { box.innerHTML = '<p class="note">No matches. Try a fuller address.</p>'; return; }
        box.innerHTML = r.map((x, i) => `<button class="plan-hit" data-i="${i}">${esc(x.display_name)}</button>`).join('');
        box.querySelectorAll('.plan-hit').forEach(b => b.onclick = () => { const x = r[+b.dataset.i]; box.hidden = true; map.setView([+x.lat, +x.lon], 18); if (!S.poly.length) setDrawing(true); });
      } catch (e) { box.innerHTML = '<p class="note">Search isn\'t available right now. Pan the map instead.</p>'; }
    };
    $('mpGo').onclick = search; $('mpSearch').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    $('mpMe').onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 18), () => alert('Could not get your location. Check location permissions.'), {enableHighAccuracy: true, timeout: 10000}) : alert('Location is not available on this device.');

    // ---- settings
    const val = id => parseFloat($(id).value), drone = () => DRONES[$('mpDrone').value];
    const settings = () => ({drone: $('mpDrone').value, altFt: val('mpAlt'), front: val('mpFront'), side: val('mpSide'), speedMph: val('mpSpeed'), dir: val('mpDir'),
      terrain: $('mpTerr').checked, wpFt: val('mpWpFt'), home: S.home ? [+S.home[0].toFixed(7), +S.home[1].toFixed(7)] : null});
    const applySettings = st => { if (DRONES[st.drone]) $('mpDrone').value = st.drone; [['mpAlt', st.altFt], ['mpFront', st.front], ['mpSide', st.side], ['mpSpeed', st.speedMph], ['mpDir', st.dir]].forEach(([id, v]) => { if (v != null && !isNaN(v)) $(id).value = v; }); $('mpDirR').value = $('mpDir').value;
      $('mpTerr').checked = !!st.terrain; if (st.wpFt) $('mpWpFt').value = st.wpFt; S.home = st.home && st.home.length === 2 ? [+st.home[0], +st.home[1]] : null; S.placingHome = false; drawHome(); };
    $('mpDirR').oninput = () => { $('mpDir').value = $('mpDirR').value; recalc(); };
    $('mpDir').oninput = () => { $('mpDirR').value = $('mpDir').value; recalc(); };
    $('mpAuto').onclick = () => { if (S.poly.length < 3) return; $('mpDir').value = $('mpDirR').value = longestEdgeDir(S.poly); recalc(); };
    ['mpAlt', 'mpFront', 'mpSide', 'mpSpeed'].forEach(id => $(id).addEventListener('input', recalc));
    $('mpDrone').onchange = recalc;

    // ---- ground elevation (USGS 3DEP; Open-Meteo as a backup), cached by rounded coordinate
    // one source per plan: never mix USGS and backup values (different terrain models can differ by a few feet)
    const elevCache = {usgs: new Map(), om: new Map()}, ekey = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);
    const pickSrc = pts => pts.every(p => elevCache.usgs.has(ekey(p))) ? 'usgs' : pts.every(p => elevCache.om.has(ekey(p))) ? 'om' : '';
    async function fetchJSON(url, opt, ms = 20000) {
      const ac = typeof AbortController === 'function' ? new AbortController() : null, t = ac ? setTimeout(() => ac.abort(), ms) : 0;
      try { const r = await fetch(url, Object.assign({}, opt || {}, ac ? {signal: ac.signal} : {})); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
    }
    async function usgs(points) {
      const body = 'geometry=' + encodeURIComponent(JSON.stringify({points: points.map(p => [p[1], p[0]]), spatialReference: {wkid: 4326}})) +
        '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&interpolation=RSP_BilinearInterpolation&f=json';
      const j = await fetchJSON('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body});
      const out = new Array(points.length).fill(NaN);
      (j.samples || []).forEach(sm => { const v = parseFloat(sm.value); if (sm.locationId >= 0 && sm.locationId < points.length && isFinite(v) && v > -500) out[sm.locationId] = v; });
      if (out.some(v => !isFinite(v))) throw new Error('missing elevation values');
      return out;
    }
    async function openMeteo(points) {
      const j = await fetchJSON('https://api.open-meteo.com/v1/elevation?latitude=' + points.map(p => p[0].toFixed(6)).join(',') + '&longitude=' + points.map(p => p[1].toFixed(6)).join(','));
      if (!j.elevation || j.elevation.length !== points.length) throw new Error('elevation service error');
      return j.elevation.map(Number);
    }
    async function fill(src, points, onProgress) {
      const C = elevCache[src], need = [...new Map(points.filter(p => !C.has(ekey(p))).map(p => [ekey(p), p])).values()];
      for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100), vals = await (src === 'usgs' ? usgs(chunk) : openMeteo(chunk));
        chunk.forEach((p, k) => C.set(ekey(p), vals[k]));
        if (onProgress) onProgress(Math.min(need.length, i + 100), need.length);
      }
    }
    async function elevations(points, onProgress) {
      try { await fill('usgs', points, onProgress); } catch (e) { await fill('om', points, onProgress); }
    }

    // ---- calculate + draw
    let terrToken = 0;
    function recalc() {
      const d = drone(); $('mpDroneNote').textContent = `${d.note} · about ${d.batt} min usable per battery (${d.rated} min rated)`;
      lineL.clearLayers(); S.segs = []; S.route = null; S.cam = S.st = null; S.tinfo = null;
      const st = settings(), warn = [], myToken = ++terrToken;
      $('mpTerrOpts').hidden = !st.terrain;
      const bad = !(st.altFt >= 30 && st.altFt <= 1000) || !(st.front >= 30 && st.front < 95) || !(st.side >= 30 && st.side < 95) || !(st.speedMph > 0.5 && st.speedMph <= 45) || isNaN(st.dir) || (st.terrain && !(st.wpFt >= 30));
      if (S.poly.length < 3) { $('mpStats').innerHTML = '<p class="note">Draw an area (at least 3 corners) to see the flight plan.</p>'; drawExport(); if (!S.drawing) $('mpStrip').innerHTML = 'Tap <b>Draw area</b>, then tap the map to outline the area to map.'; return; }
      if (bad) { $('mpStats').innerHTML = '<p class="err-msg">Check the settings: altitude 30&ndash;400 ft, overlaps 30&ndash;94%, speed above 0, waypoint spacing at least 30 ft.</p>'; drawExport(); return; }
      const altM = st.altFt * FT, speed = st.speedMph * MPH, cam = camera(d, altM, st.front, st.side);
      let segs;
      try { segs = grid(S.poly, st.dir, cam.lineSp); } catch (e) { $('mpStats').innerHTML = '<p class="err-msg">This area is too large for one plan at these settings. Raise the altitude, lower the side overlap, or split the area.</p>'; drawExport(); return; }
      if (!segs.length) { $('mpStats').innerHTML = '<p class="err-msg">No flight lines fit in this area. Make the area larger or lower the altitude.</p>'; drawExport(); return; }
      Object.assign(S, {segs, cam});
      segs.forEach((sg, i) => { L.polyline(sg, {color: '#4fd1ff', weight: 2.5, opacity: 0.95, interactive: false}).addTo(lineL);
        if (i) L.polyline([segs[i - 1][1], sg[0]], {color: '#ffffff', weight: 1.5, dashArray: '4 5', opacity: 0.8, interactive: false}).addTo(lineL); });
      L.marker(segs[0][0], {icon: tag('S', 'start'), interactive: false}).addTo(lineL);
      L.marker(segs[segs.length - 1][1], {icon: tag('E', 'end'), interactive: false}).addTo(lineL);
      // route: flat, or terrain-following (needs the takeoff point and ground elevation)
      if (!st.terrain) S.route = flatRoute(segs, altM);
      else if (!S.home) { renderStats(st, d, cam, speed, warn, '<p class="mp-warn">&#9888; Terrain following: tap <b>Set takeoff point</b>, then tap the map where you\'ll take off.</p>'); drawExport(); return; }
      else {
        const maxSp = st.wpFt * FT, totalL = segs.reduce((a, sg) => a + distM(sg[0], sg[1]), 0), step = Math.max(10, Math.min(cam.photoSp, 25), totalL / 4000);
        const lines = terrainSamples(segs, cam.photoSp, maxSp, step), pts = [S.home].concat(...lines.map(l => l.sp));
        const src = pickSrc(pts);
        if (!src) {
          renderStats(st, d, cam, speed, warn, `<p class="note" id="mpTerrStatus">&#8987; Getting ground elevation for ${pts.length.toLocaleString()} points…</p>`); drawExport();
          elevations(pts, (n, of) => { const el = $('mpTerrStatus'); if (el && myToken === terrToken) el.innerHTML = `&#8987; Getting ground elevation… ${n.toLocaleString()} of ${of.toLocaleString()}`; })
            .then(() => { if (myToken === terrToken) recalc(); })
            .catch(e => { if (myToken !== terrToken) return; const el = $('mpTerrStatus'); if (el) el.outerHTML = `<p class="err-msg">Couldn't get ground elevation (${esc(e.message)}). Check your connection and try again, or turn off terrain following. <button class="btn btn-ghost sm" type="button" id="mpTerrRetry">Retry</button></p>`;
              const rb = $('mpTerrRetry'); if (rb) rb.onclick = recalc; });
          return;
        }
        const elevOf = p => elevCache[src].get(ekey(p)), homeE = elevOf(S.home), T = terrainRoute(lines, elevOf, altM, homeE);
        S.route = T.route; S.tinfo = Object.assign({homeE, src: src === 'usgs' ? 'USGS 3DEP' : 'Open-Meteo (backup)'}, T);
        if (T.hMax > 120) warn.push(`Waypoints go up to ${Math.round(T.hMax / FT)} ft above the takeoff point (still ${st.altFt} ft above the ground below the drone). Raise the max altitude limit in the flight app if it's set to 400 ft (120 m).`);
        if (T.hMin < 10) warn.push(`Some waypoints are ${T.hMin < 0 ? Math.round(-T.hMin / FT) + ' ft below' : 'only ' + Math.round(T.hMin / FT) + ' ft above'} the takeoff point because the ground drops away. Taking off from lower ground is safer, and some apps won't accept heights below takeoff.`);
      }
      const s = stats(S.route, cam, speed, d); S.st = s;
      renderStats(st, d, cam, speed, warn, '');
      drawExport();
    }
    function renderStats(st, d, cam, speed, warn, extra) {
      const s = S.st, acres = areaM2(S.poly) / 4046.856, T = S.tinfo;
      const tile = (k, v, sub) => `<div class="mp-stat"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
      if (s) {
        if (st.altFt > 400) warn.unshift('Above 400 ft AGL: Part 107 limits flights to 400 ft unless within 400 ft of a structure.');
        if (speed > s.maxSpeed) warn.unshift(`Too fast for the camera: photos would be ${s.interval.toFixed(1)} s apart, but the ${esc(d.name.replace(/ \(.*/, ''))} needs about ${d.minInt} s between photos. Slow to ${(s.maxSpeed / MPH).toFixed(1)} mph or less, or lower the front overlap.`);
        if (s.wps > 99 && d.litchi) warn.push(`${s.wps} waypoints: the Litchi export is split into ${litchiCsvs(S.route, speed, cam.photoSp).length} missions (Litchi allows 99 per mission).`);
        if (s.batteries > 1) warn.push(`Needs about ${s.batteries} batteries. Plan battery swaps; Litchi parts or DJI Pilot 2 breakpoint resume can help.`);
        if (acres > 300) warn.push('Large area: consider splitting it into smaller plans.');
      }
      const mins = s ? Math.round(s.secs / 60) : 0;
      $('mpStats').innerHTML = (s ? `<div class="mp-stats">
          ${tile('Photos', s.photos.toLocaleString())}${tile('Flight time', mins + ' min', 'estimated')}${tile('Batteries', s.batteries, `~${d.batt} min each`)}${tile('Distance', fmtMi(s.dist), s.lines + ' lines')}
          ${tile('Ground resolution', cam.gsd.toFixed(2) + ' cm/px', (cam.gsd / 2.54).toFixed(2) + ' in/px')}${tile('Line spacing', fmtFt(cam.lineSp), cam.lineSp.toFixed(1) + ' m')}
          ${tile('Photo spacing', fmtFt(cam.photoSp), cam.photoSp.toFixed(1) + ' m · ' + s.interval.toFixed(1) + ' s apart')}${tile('Area', acres.toFixed(acres < 10 ? 2 : 1) + ' acres', s.wps + ' waypoints')}
          ${T ? tile('Ground along route', `${Math.round(T.gMin / FT)}&ndash;${Math.round(T.gMax / FT)} ft`, `elevation · takeoff ${Math.round(T.homeE / FT)} ft`) + tile('Height above takeoff', `${Math.round(T.hMin / FT)} to ${Math.round(T.hMax / FT)} ft`, `holds ${st.altFt} ft above ground`) : ''}
        </div>
        <p class="note">Photo footprint ${fmtFt(cam.across)} &times; ${fmtFt(cam.along)} at ${st.altFt} ft. Time includes about 3 s per turn and 90 s for takeoff, climb, and return.${T ? ` Terrain from ${esc(T.src)}: bare ground only, so allow for trees and buildings.` : ''}</p>` : '') +
        extra + warn.map(w => `<p class="mp-warn">&#9888; ${w}</p>`).join('');
      $('mpStrip').innerHTML = s ? `<b>${s.photos.toLocaleString()}</b> photos &middot; <b>${fmtMi(s.dist)}</b> &middot; <b>${mins} min</b> &middot; <b>${s.batteries}</b> batter${s.batteries > 1 ? 'ies' : 'y'} &middot; ${cam.gsd.toFixed(2)} cm/px${T ? ' &middot; terrain on' : ''}`
        : (st.terrain && !S.home ? 'Set the takeoff point for terrain following.' : 'Getting ground elevation…');
    }

    // ---- export
    const baseName = () => ($('mpName').value.trim() || 'Overhead_UAS_mapping').replace(/[^\w-]+/g, '_').slice(0, 50);
    async function deliver(data, name, type) {
      const blob = new Blob([data], {type}), file = new File([blob], name, {type});
      if (/iP(hone|ad|od)|Android/i.test(navigator.userAgent)) { const r = await X.shareFile(file, name); if (r !== false) return; }
      X.saveBlob(URL.createObjectURL(blob), name);
    }
    function drawExport() {
      const box = $('mpExport'), d = drone();
      if (!S.route || !S.st) { box.innerHTML = `<p class="note">${S.segs.length && settings().terrain ? 'Finish the terrain setup above to export.' : 'Draw an area first.'}</p>`; return; }
      const st = settings(), speed = st.speedMph * MPH, parts = litchiCsvs(S.route, speed, S.cam.photoSp), terr = !!S.tinfo;
      box.innerHTML = `<div class="mp-exp">
        <div><b>Litchi Mission Hub (CSV)</b><p class="note">${parts.length > 1 ? `${parts.length} missions (${parts.map(p => p.wps).join(' + ')} waypoints), because Litchi allows 99 per mission.` : `1 mission, ${parts[0].wps} waypoints.`} Photos every ${S.cam.photoSp.toFixed(1)} m along each line.${terr ? ' <b>Terrain following:</b> in Mission Hub set <b>Path mode: Curved turns</b> so the drone flies through the middle waypoints.' : ''}${d.litchi ? '' : ' <span class="warn-inline">Litchi doesn\'t support the Mavic 3 Thermal; use the KMZ.</span>'}</p>
          <div class="fill-actions">${parts.length > 1 ? parts.map((p, i) => `<button class="btn btn-ghost sm" data-csv="${i}">Part ${i + 1} of ${parts.length}</button>`).join('') + '<button class="btn btn-primary sm" data-csv="all">All parts (.zip)</button>' : '<button class="btn btn-primary sm" data-csv="0">Download CSV</button>'}</div></div>
        <div><b>DJI Pilot 2 (KMZ)</b><p class="note">${d.kmz ? `Waypoint route for the Mavic 3 Thermal, ${S.st.wps} waypoints${terr ? ' with heights following the terrain' : ''}, wide-camera photos every ${S.cam.photoSp.toFixed(1)} m.` : 'Available when the Mavic 3 Thermal is selected.'}</p>
          <div class="fill-actions"><button class="btn ${d.kmz ? 'btn-primary' : 'btn-ghost'} sm" data-kmz${d.kmz ? '' : ' disabled'}>Download KMZ</button></div></div></div>`;
      box.querySelectorAll('[data-csv]').forEach(b => b.onclick = () => {
        const nm = baseName(), k = b.dataset.csv;
        if (k === 'all') deliver(zip(parts.map((p, i) => ({name: `${nm}_part${i + 1}of${parts.length}.csv`, data: new TextEncoder().encode(p.text)}))), nm + '_litchi.zip', 'application/zip');
        else deliver(parts[+k].text, parts.length > 1 ? `${nm}_part${+k + 1}of${parts.length}.csv` : nm + '.csv', 'text/csv');
      });
      const kb = box.querySelector('[data-kmz]');
      if (kb && d.kmz) kb.onclick = () => deliver(djiKmz(S.route, speed, S.cam.photoSp, baseName(), S.st), baseName() + '.kmz', 'application/vnd.google-earth.kmz');
    }

    // ---- save / load (Overhead UAS records via the portal script; this device as a fallback)
    const LOCAL = 'ouas_mapplans_local';
    const localPlans = () => { try { return JSON.parse(localStorage.getItem(LOCAL) || '[]'); } catch (e) { return []; } };
    const setLocal = a => { try { localStorage.setItem(LOCAL, JSON.stringify(a)); } catch (e) {} };
    const msg = (t, bad) => { const m = $('mpSaveMsg'); m.textContent = t; m.className = 'save-msg ' + (bad ? 'bad' : 'good'); };
    async function drawSaved() {
      const box = $('mpSaved'); let server = [], err = '';
      try { server = (await X.papi('mapplan.list')).plans || []; } catch (e) { err = e.message; }
      const local = localPlans();
      box.innerHTML = (server.length || local.length) ? `<div class="mlist">${server.map(p => `<div class="prow"><div class="prow-main"><b>${esc(p.name)}</b>
          <div class="note">${esc(p.id)} · ${esc(DRONES[p.drone] ? DRONES[p.drone].name.replace(/ \(.*/, '') : p.drone)} · ${esc(p.acres)} acres · ${esc(p.pilot || '')} · ${esc(p.updated || '')}</div></div>
          <div class="qbtns"><button class="btn btn-ghost sm" data-load="${esc(p.id)}">Open</button>${p.mine || (X.me && X.me.role === 'admin') ? `<button class="btn btn-ghost sm" data-del="${esc(p.id)}">Delete</button>` : ''}</div></div>`).join('')}
        ${local.map((p, i) => `<div class="prow"><div class="prow-main"><b>${esc(p.name)}</b><div class="note">Saved on this device only · ${esc(p.saved || '')}</div></div>
          <div class="qbtns"><button class="btn btn-ghost sm" data-lload="${i}">Open</button><button class="btn btn-ghost sm" data-ldel="${i}">Delete</button></div></div>`).join('')}</div>`
        : `<p class="note">${err ? 'Couldn\'t load saved plans (' + esc(err) + ').' : 'No saved plans yet.'}</p>`;
      box.querySelectorAll('[data-load]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await X.papi('mapplan.get', {id: b.dataset.load}); openPlan(r.plan.polygon, r.plan.settings, r.plan.name, r.plan.id, r.plan.mine); } catch (e) { alert('Could not open the plan (' + e.message + ')'); } finally { b.disabled = false; } });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete this saved plan?')) return; try { await X.papi('mapplan.delete', {id: b.dataset.del}); if (S.planId === b.dataset.del) S.planId = ''; drawSaved(); } catch (e) { alert('Could not delete (' + e.message + ')'); } });
      box.querySelectorAll('[data-lload]').forEach(b => b.onclick = () => { const p = localPlans()[+b.dataset.lload]; openPlan(p.polygon, p.settings, p.name, '', true); });
      box.querySelectorAll('[data-ldel]').forEach(b => b.onclick = () => { if (!confirm('Delete this plan from this device?')) return; const a = localPlans(); a.splice(+b.dataset.ldel, 1); setLocal(a); drawSaved(); });
    }
    function openPlan(poly, st, name, id, mine) {
      S.poly = poly.map(p => [+p[0], +p[1]]); S.planId = mine ? id : ''; applySettings(st || {}); $('mpName').value = name || '';
      setDrawing(false); drawShape(); recalc(); map.fitBounds(L.latLngBounds(S.poly).pad(0.25));
      msg(mine || !id ? `Opened "${name}".` : `Opened "${name}". Saving makes your own copy.`);
      $('mpWrap').scrollIntoView({behavior: 'smooth', block: 'start'});
    }
    $('mpSave').onclick = async e => {
      if (S.poly.length < 3) return msg('Draw an area first.', true);
      const name = $('mpName').value.trim(); if (!name) { $('mpName').focus(); return msg('Enter a mission name (Export section).', true); }
      const plan = {id: S.planId, name, drone: $('mpDrone').value, settings: settings(), polygon: S.poly.map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]), acres: +(areaM2(S.poly) / 4046.856).toFixed(2)};
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Saving…';
      try { const r = await X.papi('mapplan.save', {plan}); S.planId = r.id; msg(`Saved as ${r.id} ✓`); drawSaved(); }
      catch (x) { const a = localPlans(); a.unshift({name, settings: plan.settings, polygon: plan.polygon, saved: X.nowStamp ? X.nowStamp() : new Date().toLocaleString()}); setLocal(a.slice(0, 30));
        msg('Saved on this device only (couldn\'t reach Overhead UAS records: ' + x.message + ').', true); drawSaved(); }
      finally { b.disabled = false; b.textContent = 'Save plan'; }
    };

    const am = X.activeMission && X.activeMission(); if (am && am.name) $('mpName').value = (am.id ? am.id + ' ' : '') + am.name;
    drawShape(); recalc(); drawSaved();
  }

  window.OUAS_MAPPING = {mount, _t: {DRONES, camera, grid, stats, areaM2, longestEdgeDir, litchiCsvs, djiKmz, zip, distM, flatRoute, lineStations, terrainSamples, terrainRoute}};
})();
