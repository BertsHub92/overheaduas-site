/**
 * Overhead UAS - signed agreement receiver (Google Apps Script web app)
 *
 * Receives signed forms from the Pilot Portal (service agreements, mission
 * sheets, incident reports), then:
 *   1. saves the PDF to Google Drive: "Overhead UAS Records/<form type>/<YYYY-MM>/"
 *   2. emails it to Overhead UAS
 *   3. emails a copy to the client / signer if an email was entered
 *
 * Also runs the OVH-204 Maintenance & Repair Log (Google Sheet
 * "Overhead UAS Maintenance Log"): aircraft list, log entries, battery
 * checks, and history for printing. Only failed / grounded entries email.
 *
 * Also keeps Pilot Records (Google Sheet "Overhead UAS Pilot Records" and
 * Drive folder Overhead UAS Records/Pilots/<name>): each pilot's profile,
 * FAA certificate, drone registrations, and other certificates. Pilots see
 * only their own folder; admins see all.
 *
 * Mission Planning: looks up FAA TFRs (plan.tfr) and METAR / TAF / Kp (plan.wx).
 *
 * Missions: numbered missions (starting at 002) with their own Drive folder
 * (Overhead UAS Records/Missions/Mission 002 - name). Forms submitted while a
 * mission is active are filed there and listed in the Missions sheet.
 *
 * Training: admins create courses (slides PDF, video / link, quiz); pilots
 * study, take the quiz (graded here), and sign; a certificate is filed in the
 * pilot's folder. Optional AI quiz writer uses the Claude API with an
 * ANTHROPIC_API_KEY saved in Script Properties (never in this code).
 *
 * Setup: see the instructions Claude provided. Deploy as a Web app,
 * "Execute as: Me", "Who has access: Anyone".
 */
var TOKEN = 'PASTE_TOKEN_HERE';          // must match the Pilot Portal
var OFFICE_EMAIL = 'overheaduas@gmail.com';
var ROOT_FOLDER = 'Overhead UAS Records';
var PILOT_KEY = 'PASTE_PILOT_KEY_HERE';  // must match the Pilot Portal build

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.token !== TOKEN) return reply({ok: false, error: 'unauthorized'});
    if (data.action) return reply(handleAction(data));
    var bytes = Utilities.base64Decode(data.pdf);
    if (bytes.length > 15 * 1024 * 1024) return reply({ok: false, error: 'file too large'});
    var name = String(data.filename || 'Signed_Agreement.pdf').replace(/[^\w.\- ]+/g, '_');
    var blob = Utilities.newBlob(bytes, 'application/pdf', name);

    // 1. Save to Drive
    var month = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM');
    var type = String(data.folder || 'Service Agreements').replace(/[\/\\]+/g, '-').slice(0, 80);
    var mission = missionFor(data);   // file into the pilot's active mission folder when one is set
    var file = (mission ? mission.folder : folder(folder(folder(null, ROOT_FOLDER), type), month)).createFile(blob);
    if (mission) logMissionFile(mission, data, file, name);

    // 2. Email Overhead UAS
    var s = data.summary || {};
    var lines = data.lines && data.lines.length ? [
      (data.intro || 'A new form was submitted through the Pilot Portal.'), ''
    ].concat(mission ? ['Mission: ' + mission.label] : [], data.lines.map(String), ['', 'Document ID: ' + (data.docId || '-'), 'Saved to Google Drive: ' + file.getUrl()]) : [
      'A new agreement was signed through the Pilot Portal.', '',
      'Client: ' + (s.client || '-'),
      'Site: ' + (s.site || '-'),
      'Flight date(s): ' + (s.dates || '-'),
      'Services: ' + (s.services || '-'),
      'Job cost: $' + (s.cost || '-'),
      'Pilot: ' + (s.pilot || '-'),
      'Client email: ' + (data.clientEmail || '(none)'), '',
      'Saved to Google Drive: ' + file.getUrl()
    ];
    var subject = data.subject ? String(data.subject).slice(0, 200) : 'Signed agreement: ' + (s.client || name);
    if (!data.quiet) GmailApp.sendEmail(OFFICE_EMAIL, subject, lines.join('\n'),
      {attachments: [blob], name: 'Overhead UAS Pilot Portal'});

    // 3. Copy to client
    var sentClient = false;
    var to = String(data.clientEmail || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      GmailApp.sendEmail(to, 'Your Overhead UAS service agreement',
        'Hi ' + (s.clientName || '') + ',\n\n' +
        'Thank you for choosing Overhead UAS. Attached is a copy of your signed Drone Services Agreement for your records.\n\n' +
        'Questions? Call or text (760) 527-3267 or reply to this email.\n\n' +
        'Respectfully,\nOverhead UAS\nwww.overheaduas.com',
        {attachments: [blob], name: 'Overhead UAS', replyTo: OFFICE_EMAIL});
      sentClient = true;
    }
    // 4. Copy to the person who signed (property permission, releases, quotes)
    var copyTo = String(data.copyTo || '').trim();
    if (!sentClient && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(copyTo)) {
      var msg = String(data.copyMessage || 'Attached is a copy of your signed document from Overhead UAS for your records.').slice(0, 3000);
      GmailApp.sendEmail(copyTo, String(data.copySubject || 'Your Overhead UAS document').slice(0, 200),
        msg + '\n\nQuestions? Call or text (760) 527-3267 or reply to this email.\n\nRespectfully,\nOverhead UAS\nwww.overheaduas.com',
        {attachments: [blob], name: 'Overhead UAS', replyTo: OFFICE_EMAIL});
      sentClient = true;
    }
    return reply({ok: true, sentClient: sentClient, quiet: !!data.quiet, mission: mission ? mission.label : ''});
  } catch (err) {
    return reply({ok: false, error: String(err)});
  }
}

function doGet() { return reply({ok: true, status: 'Overhead UAS receiver is running'}); }

function folder(parent, name) {
  var it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : (parent ? parent.createFolder(name) : DriveApp.createFolder(name));
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to grant permissions (Drive + Gmail + Sheets). */
function authorize() {
  DriveApp.getRootFolder();
  GmailApp.getAliases();
  maintBook();
  pilotBook();
}

// ===================== OVH-204 Maintenance & Repair Log =====================
var MAINT_BOOK = 'Overhead UAS Maintenance Log';
var TABS = {
  Aircraft: ['Aircraft ID', 'Nickname', 'Make / model', 'Serial #', 'FAA registration #', 'Status', 'Added', 'Added by'],
  'Log Entries': ['Logged', 'Entry date', 'Aircraft ID', 'Aircraft', 'Entry type', 'Pilot', 'Result', 'Failed items', 'Total flight time (hrs)',
                  'Firmware', 'Work performed / parts replaced', 'Notes', 'Batteries checked', 'Document ID', 'PDF'],
  'Battery Checks': ['Logged', 'Entry date', 'Aircraft ID', 'Aircraft', 'Battery ID', 'Cycle count', 'Health %', 'Condition', 'Notes', 'Pilot', 'Document ID']
};

function book(prop, title, tabs, sub) {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty(prop), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(title);
    props.setProperty(prop, ss.getId());
    try { DriveApp.getFileById(ss.getId()).moveTo(folder(folder(null, ROOT_FOLDER), sub)); } catch (e) {}
  }
  Object.keys(tabs).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(tabs[name]); sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, tabs[name].length).setFontWeight('bold').setBackground('#0b1f33').setFontColor('#ffffff');
    }
  });
  var def = ss.getSheetByName('Sheet1'); if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss;
}
function maintBook() { return book('MAINT_BOOK_ID', MAINT_BOOK, TABS, 'Maintenance'); }

function rows(sh) {
  var v = sh.getDataRange().getValues(), head = v.shift();
  return v.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? Utilities.formatDate(r[i], 'America/Los_Angeles', 'MM/dd/yyyy') : r[i]; }); return o; });
}

function clean(x, n) { return String(x == null ? '' : x).replace(/^[=+\-@]/, "'$&").slice(0, n || 500); }

function aircraftList(ss) {
  return rows(ss.getSheetByName('Aircraft')).filter(function (a) { return a['Status'] !== 'Retired'; }).map(function (a) {
    return {id: a['Aircraft ID'], nickname: a['Nickname'], model: a['Make / model'], serial: a['Serial #'], reg: a['FAA registration #']};
  });
}

function addAircraft(ss, a, by) {
  var sh = ss.getSheetByName('Aircraft');
  var id = clean(a.nickname || a.model, 40).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'AIRCRAFT';
  var taken = rows(sh).map(function (r) { return String(r['Aircraft ID']); }), base = id, n = 2;
  while (taken.indexOf(id) >= 0) id = base + '-' + (n++);
  sh.appendRow([id, clean(a.nickname, 60), clean(a.model, 80), clean(a.serial, 60), clean(a.reg, 40), 'Active', new Date(), clean(by, 60)]);
  return id;
}

function handleAction(d) {
  if (/^mission\./.test(d.action)) return missionAction(d);
  if (/^train\./.test(d.action)) return trainAction(d);
  if (/^(me|pilot|pilots|doc)\./.test(d.action)) return pilotAction(d);
  if (d.action === 'plan.tfr') return planTfr(d);
  if (d.action === 'plan.wx') return planWx(d);
  var ss = maintBook(), lock = LockService.getScriptLock();
  if (d.action === 'aircraft.list') return {ok: true, aircraft: aircraftList(ss)};
  if (d.action === 'aircraft.add') {
    lock.waitLock(20000);
    try { var id = addAircraft(ss, d.aircraft || {}, d.by); return {ok: true, id: id, aircraft: aircraftList(ss)}; } finally { lock.releaseLock(); }
  }
  if (d.action === 'maint.submit') {
    lock.waitLock(20000);
    try {
      var e = d.entry || {}, ac = e.aircraft || {};
      if (ac.isNew && ac.save) ac.id = addAircraft(ss, ac, e.pilot);
      var acName = [ac.nickname, ac.model].filter(String).join(' - ') || ac.id || 'Other aircraft';
      var acId = ac.id || 'OTHER';
      var url = '';
      if (d.pdf) {
        var blob = Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', String(d.filename || 'Maintenance.pdf').replace(/[^\w.\- ]+/g, '_'));
        var f = folder(folder(folder(null, ROOT_FOLDER), 'Maintenance'), acId.replace(/[\/\\]/g, '-')).createFile(blob);
        url = f.getUrl();
      }
      var now = new Date(), bats = e.batteries || [];
      ss.getSheetByName('Log Entries').appendRow([now, clean(e.date, 20), clean(acId, 40), clean(acName, 120), clean(e.type, 40), clean(e.pilot, 60),
        clean(e.result, 40), clean((e.failed || []).join('; '), 1000), clean(e.hours, 20), clean(e.firmware, 60), clean(e.work, 2000),
        clean(e.notes, 2000), bats.length, clean(d.docId, 40), url]);
      var bsh = ss.getSheetByName('Battery Checks');
      bats.forEach(function (b) {
        bsh.appendRow([now, clean(e.date, 20), clean(acId, 40), clean(acName, 120), clean(b.id, 40), clean(b.cycles, 10), clean(b.health, 10), clean(b.condition, 40), clean(b.notes, 500), clean(e.pilot, 60), clean(d.docId, 40)]);
      });
      var emailed = false;
      if (e.alert) {
        var body = ['A maintenance entry needs attention.', '', 'Aircraft: ' + acName + ' (' + acId + ')', 'Result: ' + e.result, 'Entry: ' + e.type + ' on ' + e.date,
          'Pilot: ' + e.pilot, '', 'Problems found:'].concat((e.alerts || []).map(function (x) { return ' - ' + x; }),
          ['', 'Notes: ' + (e.notes || '-'), '', 'Record: ' + (url || '(no PDF)'), 'Document ID: ' + (d.docId || '-')]).join('\n');
        var opts = {name: 'Overhead UAS Maintenance Log'};
        if (d.pdf) opts.attachments = [Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', String(d.filename || 'Maintenance.pdf'))];
        GmailApp.sendEmail(OFFICE_EMAIL, (e.result === 'GROUNDED' ? 'GROUNDED: ' : 'Maintenance alert: ') + acName, body, opts);
        emailed = true;
      }
      return {ok: true, emailed: emailed, aircraftId: acId};
    } finally { lock.releaseLock(); }
  }
  if (d.action === 'maint.history') {
    var id = String(d.aircraftId || ''), from = d.from ? new Date(d.from + 'T00:00:00') : null, to = d.to ? new Date(d.to + 'T23:59:59') : null;
    var inRange = function (r) {
      if (id && String(r['Aircraft ID']) !== id) return false;
      var p = String(r['Entry date']).split('/'), dt = p.length === 3 ? new Date(+p[2], +p[0] - 1, +p[1]) : null;
      return !dt || ((!from || dt >= from) && (!to || dt <= to));
    };
    var all = rows(ss.getSheetByName('Aircraft')).filter(function (a) { return String(a['Aircraft ID']) === id; })[0] || null;
    return {ok: true, aircraft: all, entries: rows(ss.getSheetByName('Log Entries')).filter(inRange), batteries: rows(ss.getSheetByName('Battery Checks')).filter(inRange)};
  }
  return {ok: false, error: 'unknown action'};
}


// ===================== Pilot Records =====================
var PILOT_BOOK = 'Overhead UAS Pilot Records';
var PTABS = {
  Pilots: ['Pilot ID', 'Name', 'Phone', 'Email', 'Part 107 cert #', 'Original issue date', 'Last recurrent / test date', 'Recurrent due',
           'Other certs & ratings', 'Role', 'Status', 'Updated', 'Updated by'],
  Documents: ['Doc ID', 'Pilot ID', 'Type', 'Title', 'Aircraft', 'Registration #', 'Expires', 'File name', 'Uploaded', 'Uploaded by', 'Status'],
  Missions: ['Mission #', 'Name', 'Client', 'Planned date', 'Location', 'Pilot ID', 'Pilot', 'Status', 'Folder ID', 'Created', 'Closed'],
  'Mission Files': ['Mission #', 'Form', 'File name', 'File ID', 'Saved', 'Saved by'],
  Courses: ['Course ID', 'Title', 'Category', 'Description', 'Video / link', 'Slides file ID', 'Slides name', 'Quiz JSON', 'Pass %', 'Required', 'Assigned to',
            'Due date', 'Repeat', 'Status', 'Created', 'Updated by'],
  Completions: ['Course ID', 'Course', 'Pilot ID', 'Pilot', 'Score %', 'Passed', 'Completed', 'Valid until', 'Certificate file ID']
};
var PFIELDS = ['name', 'phone', 'email', 'cert', 'issued', 'recurrent', 'due', 'other'];

function pilotBook() { return book('PILOT_BOOK_ID', PILOT_BOOK, PTABS, 'Pilots'); }

function findRow(sh, col, val) {
  var v = sh.getDataRange().getValues(), head = v[0], c = head.indexOf(col);
  for (var i = 1; i < v.length; i++) if (String(v[i][c]) === String(val)) {
    var o = {}; head.forEach(function (h, k) { o[h] = v[i][k] instanceof Date ? Utilities.formatDate(v[i][k], 'America/Los_Angeles', 'MM/dd/yyyy') : v[i][k]; });
    return {i: i + 1, obj: o};
  }
  return null;
}

function pilotAuth(d, ss) {
  var p = d.pilot || {};
  if (!p.id || !p.sec || PILOT_KEY.indexOf('PASTE') === 0) throw new Error('not signed in as a pilot');
  var sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(String(p.id) + '|' + String(p.role), PILOT_KEY, Utilities.Charset.UTF_8));
  if (sig !== p.sec) throw new Error('pilot not recognized');
  var me = {id: String(p.id), name: String(p.name || p.id), admin: p.role === 'admin'};
  var r = findRow(ss.getSheetByName('Pilots'), 'Pilot ID', me.id);
  if (r && r.obj['Status'] === 'Inactive' && !me.admin) throw new Error('this pilot is inactive');
  return me;
}

function profileOf(o) {
  return {id: o['Pilot ID'], name: o['Name'], phone: o['Phone'], email: o['Email'], cert: o['Part 107 cert #'], issued: o['Original issue date'],
          recurrent: o['Last recurrent / test date'], due: o['Recurrent due'], other: o['Other certs & ratings'], role: o['Role'], status: o['Status'], updated: o['Updated']};
}

function ensurePilot(ss, id, name, role) {
  var sh = ss.getSheetByName('Pilots'), r = findRow(sh, 'Pilot ID', id);
  if (!r) { sh.appendRow([id, clean(name, 80), '', '', '', '', '', '', '', role, 'Active', new Date(), 'portal']); r = findRow(sh, 'Pilot ID', id); }
  return r;
}

function docsOf(ss, id) {
  return rows(ss.getSheetByName('Documents')).filter(function (x) { return String(x['Pilot ID']) === id && x['Status'] !== 'Deleted'; }).map(function (x) {
    return {id: x['Doc ID'], type: x['Type'], title: x['Title'], aircraft: x['Aircraft'], reg: x['Registration #'], expires: x['Expires'], file: x['File name'], uploaded: x['Uploaded']};
  });
}

function pilotFolder(name, id) { return folder(folder(folder(null, ROOT_FOLDER), 'Pilots'), String(name || id).replace(/[\/\\]+/g, '-')); }

function pilotAction(d) {
  var ss = pilotBook(), me = pilotAuth(d, ss), lock = LockService.getScriptLock();
  var target = String(d.target || me.id);
  if (target !== me.id && !me.admin) return {ok: false, error: 'not allowed'};
  var P = ss.getSheetByName('Pilots'), D = ss.getSheetByName('Documents');

  if (d.action === 'me.get' || d.action === 'pilot.get') {
    var r = target === me.id ? ensurePilot(ss, me.id, me.name, me.admin ? 'admin' : 'pilot') : findRow(P, 'Pilot ID', target);
    if (!r) return {ok: false, error: 'pilot not found'};
    return {ok: true, profile: profileOf(r.obj), docs: docsOf(ss, target), admin: me.admin};
  }
  if (d.action === 'pilot.save') {
    lock.waitLock(20000);
    try {
      var r2 = target === me.id ? ensurePilot(ss, me.id, me.name, me.admin ? 'admin' : 'pilot') : findRow(P, 'Pilot ID', target);
      if (!r2) return {ok: false, error: 'pilot not found'};
      var f = d.profile || {}, o = r2.obj;
      var vals = [target, clean(f.name || o['Name'], 80), clean(f.phone, 40), clean(f.email, 120), clean(f.cert, 40), clean(f.issued, 20), clean(f.recurrent, 20),
                  clean(f.due, 20), clean(f.other, 500), o['Role'] || 'pilot', o['Status'] || 'Active', new Date(), clean(me.name, 80)];
      P.getRange(r2.i, 1, 1, vals.length).setValues([vals]);
      return {ok: true, profile: profileOf(findRow(P, 'Pilot ID', target).obj)};
    } finally { lock.releaseLock(); }
  }
  if (d.action === 'doc.upload') {
    var bytes = Utilities.base64Decode(d.data || '');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return {ok: false, error: 'file missing or larger than 10 MB'};
    var mime = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(d.mime) ? d.mime : 'application/octet-stream';
    var pr = findRow(P, 'Pilot ID', target) || ensurePilot(ss, target, target, 'pilot');
    var fname = String(d.filename || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    var file = pilotFolder(pr.obj['Name'], target).createFile(Utilities.newBlob(bytes, mime, fname));
    D.appendRow([file.getId(), target, clean(d.type, 60), clean(d.title, 120), clean(d.aircraft, 120), clean(d.reg, 40), clean(d.expires, 20), fname, new Date(), clean(me.name, 80), 'Active']);
    return {ok: true, docs: docsOf(ss, target)};
  }
  if (d.action === 'doc.get' || d.action === 'doc.delete') {
    var dr = findRow(D, 'Doc ID', d.docId);
    if (!dr || dr.obj['Status'] === 'Deleted') return {ok: false, error: 'document not found'};
    if (String(dr.obj['Pilot ID']) !== me.id && !me.admin) return {ok: false, error: 'not allowed'};
    var fl = DriveApp.getFileById(String(d.docId));
    if (d.action === 'doc.get') { var bl = fl.getBlob(); return {ok: true, mime: bl.getContentType(), name: dr.obj['File name'], data: Utilities.base64Encode(bl.getBytes())}; }
    D.getRange(dr.i, PTABS.Documents.indexOf('Status') + 1).setValue('Deleted');
    try { fl.setTrashed(true); } catch (e) {}
    return {ok: true, docs: docsOf(ss, String(dr.obj['Pilot ID']))};
  }
  if (d.action === 'pilots.list') {
    if (!me.admin) return {ok: false, error: 'admins only'};
    var docs = rows(D).filter(function (x) { return x['Status'] !== 'Deleted'; });
    return {ok: true, pilots: rows(P).map(function (o) {
      var p = profileOf(o), mine = docs.filter(function (x) { return String(x['Pilot ID']) === String(p.id); });
      p.docCount = mine.length; p.hasCert = mine.some(function (x) { return x['Type'] === 'Part 107 certificate'; });
      p.types = mine.map(function (x) { return String(x['Type']); }).filter(function (x, i, arr) { return arr.indexOf(x) === i; });
      return p;
    })};
  }
  if (d.action === 'pilot.status') {
    if (!me.admin) return {ok: false, error: 'admins only'};
    var sr = findRow(P, 'Pilot ID', target); if (!sr) return {ok: false, error: 'pilot not found'};
    P.getRange(sr.i, PTABS.Pilots.indexOf('Status') + 1).setValue(d.status === 'Inactive' ? 'Inactive' : 'Active');
    return {ok: true};
  }
  return {ok: false, error: 'unknown action'};
}


// ===================== Mission Planning: TFRs near a point =====================
var TFR_WFS = 'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsName=EPSG:3857';

function planTfr(d) {
  var lat = Number(d.lat), lon = Number(d.lon), miles = Math.min(Number(d.miles) || 30, 100);
  if (!isFinite(lat) || !isFinite(lon)) return {ok: false, error: 'bad location'};
  var cache = CacheService.getScriptCache(), raw = cache.get('tfr_wfs');
  if (!raw) {
    var res = UrlFetchApp.fetch(TFR_WFS, {muteHttpExceptions: true, headers: {Accept: 'application/json'}});
    if (res.getResponseCode() !== 200) return {ok: false, error: 'FAA TFR service returned ' + res.getResponseCode()};
    raw = res.getContentText();
    if (raw.length < 95000) cache.put('tfr_wfs', raw, 900);
  }
  var fc = JSON.parse(raw), out = [];
  (fc.features || []).forEach(function (f) {
    var g = toLonLat(f.geometry);
    if (!g) return;
    var rings = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    var inside = false, best = 1e9;
    rings.forEach(function (poly) {
      if (pointInRing(lon, lat, poly[0])) inside = true;
      poly[0].forEach(function (c) { best = Math.min(best, haversineMi(lat, lon, c[1], c[0])); });
    });
    if (inside) best = 0;
    if (best > miles) return;
    var p = f.properties || {};
    var title = p.TITLE || p.title || p.NAME || p.LEGAL || p.NOTAM_KEY || 'TFR';
    out.push({title: String(title).slice(0, 200), notam: String(p.NOTAM_KEY || p.notam_key || ''), state: String(p.STATE || ''), inside: inside, miles: Math.round(best * 10) / 10, geometry: g});
  });
  out.sort(function (a, b) { return a.miles - b.miles; });
  return {ok: true, tfrs: out.slice(0, 20)};
}

function toLonLat(g) {
  if (!g) return null;
  var conv = function (c) { return [c[0] / 6378137 * 180 / Math.PI, Math.atan(Math.sinh(c[1] / 6378137)) * 180 / Math.PI]; };
  var mapRing = function (r) { return r.map(conv); };
  if (g.type === 'Polygon') return {type: 'Polygon', coordinates: g.coordinates.map(mapRing)};
  if (g.type === 'MultiPolygon') return {type: 'MultiPolygon', coordinates: g.coordinates.map(function (p) { return p.map(mapRing); })};
  return null;
}
function pointInRing(x, y, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function haversineMi(a, b, c, d) {
  var r = Math.PI / 180, x = Math.pow(Math.sin((c - a) * r / 2), 2) + Math.cos(a * r) * Math.cos(c * r) * Math.pow(Math.sin((d - b) * r / 2), 2);
  return 7917.6 * Math.asin(Math.sqrt(x));
}


// ===================== Mission Planning: METAR, TAF, Kp =====================
function fetchJson(url, cacheKey, secs) {
  var cache = CacheService.getScriptCache(), hit = cacheKey ? cache.get(cacheKey) : null;
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: {Accept: 'application/json'}});
  if (res.getResponseCode() !== 200) return null;
  var txt = res.getContentText(); if (!txt) return null;
  var data = JSON.parse(txt);
  if (cacheKey && txt.length < 95000) cache.put(cacheKey, txt, secs || 600);
  return data;
}
function planWx(d) {
  var lat = Number(d.lat), lon = Number(d.lon), st = String(d.station || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(), out = {ok: true};
  if (!isFinite(lat) || !isFinite(lon)) return {ok: false, error: 'bad location'};
  try {
    var m = st ? fetchJson('https://aviationweather.gov/api/data/metar?format=json&hours=2&ids=' + st, 'metar_' + st, 600) : null;
    if (m && m.length) out.metar = {station: m[0].icaoId || st, raw: m[0].rawOb || m[0].raw_text || ''};
  } catch (e) {}
  try {
    var b = [(lat - 0.6).toFixed(2), (lon - 0.7).toFixed(2), (lat + 0.6).toFixed(2), (lon + 0.7).toFixed(2)].join(',');
    var tafs = fetchJson('https://aviationweather.gov/api/data/taf?format=json&bbox=' + b, 'taf_' + b, 1200) || [];
    var best = null;
    tafs.forEach(function (x) { var dm = haversineMi(lat, lon, Number(x.lat), Number(x.lon)); if (isFinite(dm) && (!best || dm < best.miles)) best = {station: x.icaoId, raw: x.rawTAF || x.raw_text || '', miles: Math.round(dm)}; });
    if (best) out.taf = best;
  } catch (e) {}
  try {
    var kp = fetchJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', 'kp', 1800) || [];
    out.kp = kp.slice(1).map(function (r) { return {time: String(r[0]).replace(' ', 'T') + 'Z', kp: Math.round(Number(r[1]) * 10) / 10, kind: r[2]}; })
      .filter(function (r) { return new Date(r.time) > new Date(Date.now() - 6 * 36e5); }).slice(0, 30);
  } catch (e) {}
  return out;
}


// ===================== Missions =====================
var MISSION_START = 2;   // the first portal mission is 002 (001 was done before the portal)

function missionLabel(o) { return 'Mission ' + o['Mission #'] + (o['Name'] ? ' - ' + o['Name'] : ''); }

function missionFor(data) {
  if (!data.mission || !data.pilot) return null;
  try {
    var ss = pilotBook(), me = pilotAuth(data, ss);
    var r = findRow(ss.getSheetByName('Missions'), 'Mission #', String(data.mission));
    if (!r || (String(r.obj['Pilot ID']) !== me.id && !me.admin)) return null;
    return {ss: ss, me: me, row: r, label: missionLabel(r.obj), folder: DriveApp.getFolderById(String(r.obj['Folder ID']))};
  } catch (e) { return null; }
}

function logMissionFile(m, data, file, name) {
  m.ss.getSheetByName('Mission Files').appendRow([m.row.obj['Mission #'], clean(String(data.folder || data.subject || 'Form').slice(0, 60), 60), clean(name, 150), file.getId(), new Date(), clean(m.me.name, 80)]);
}

function missionInfo(o) {
  return {id: String(o['Mission #']), name: o['Name'], client: o['Client'], date: o['Planned date'], location: o['Location'], pilotId: o['Pilot ID'], pilot: o['Pilot'],
          status: o['Status'], created: o['Created'], closed: o['Closed']};
}

function missionAction(d) {
  var ss = pilotBook(), me = pilotAuth(d, ss), lock = LockService.getScriptLock();
  var M = ss.getSheetByName('Missions'), F = ss.getSheetByName('Mission Files');
  var mine = function (o) { return me.admin || String(o['Pilot ID']) === me.id; };

  if (d.action === 'mission.new') {
    lock.waitLock(20000);
    try {
      var props = PropertiesService.getScriptProperties(), n = Number(props.getProperty('MISSION_NEXT') || MISSION_START);
      var id = ('00' + n).slice(-3); props.setProperty('MISSION_NEXT', String(n + 1));
      var name = clean(d.name, 80) || 'Untitled';
      var f = folder(folder(null, ROOT_FOLDER), 'Missions').createFolder('Mission ' + id + ' - ' + String(name).replace(/[\/\\]+/g, '-'));
      M.appendRow([id, name, clean(d.client, 80), clean(d.date, 20), clean(d.location, 150), me.id, clean(me.name, 80), 'Open', f.getId(), new Date(), '']);
      return {ok: true, mission: missionInfo(findRow(M, 'Mission #', id).obj)};
    } finally { lock.releaseLock(); }
  }
  if (d.action === 'mission.list') {
    return {ok: true, missions: rows(M).filter(mine).map(function (o) {
      var m = missionInfo(o); m.files = rows(F).filter(function (x) { return String(x['Mission #']) === m.id; }).length; return m;
    }).reverse()};
  }
  var r = findRow(M, 'Mission #', String(d.mission || ''));
  if (!r || !mine(r.obj)) return {ok: false, error: 'mission not found'};
  if (d.action === 'mission.get') {
    var files = rows(F).filter(function (x) { return String(x['Mission #']) === String(r.obj['Mission #']); }).map(function (x) {
      return {form: x['Form'], name: x['File name'], id: x['File ID'], saved: x['Saved'], by: x['Saved by']}; });
    return {ok: true, mission: missionInfo(r.obj), files: files};
  }
  if (d.action === 'mission.update') {
    var o = r.obj, st = d.status === 'Closed' ? 'Closed' : d.status === 'Open' ? 'Open' : o['Status'];
    var vals = [o['Mission #'], clean(d.name || o['Name'], 80), clean(d.client !== undefined ? d.client : o['Client'], 80), clean(d.date !== undefined ? d.date : o['Planned date'], 20),
                clean(d.location !== undefined ? d.location : o['Location'], 150), o['Pilot ID'], o['Pilot'], st, o['Folder ID'], o['Created'], st === 'Closed' ? new Date() : ''];
    M.getRange(r.i, 1, 1, vals.length).setValues([vals]);
    return {ok: true, mission: missionInfo(findRow(M, 'Mission #', String(o['Mission #'])).obj)};
  }
  if (d.action === 'mission.file') {
    var fr = rows(F).filter(function (x) { return String(x['Mission #']) === String(r.obj['Mission #']) && String(x['File ID']) === String(d.fileId); })[0];
    if (!fr) return {ok: false, error: 'file not found'};
    var bl = DriveApp.getFileById(String(d.fileId)).getBlob();
    return {ok: true, mime: bl.getContentType(), name: fr['File name'], data: Utilities.base64Encode(bl.getBytes())};
  }
  return {ok: false, error: 'unknown action'};
}


// ===================== Training =====================
function trainCourses(ss) { return rows(ss.getSheetByName('Courses')).filter(function (c) { return c['Status'] !== 'Deleted'; }); }
function assignedTo(c, id) { var a = String(c['Assigned to'] || 'All'); return a === 'All' || a.split(',').map(function (x) { return x.trim(); }).indexOf(id) >= 0; }
function parseQuiz(c) { try { return JSON.parse(String(c['Quiz JSON'] || '[]')); } catch (e) { return []; } }
function mdy(s) { var p = String(s || '').split('/'); return p.length === 3 ? new Date(+p[2], +p[0] - 1, +p[1]) : null; }
function courseOut(c, admin) {
  var q = parseQuiz(c);
  return {id: String(c['Course ID']), title: c['Title'], category: c['Category'], description: c['Description'], link: c['Video / link'],
          slides: c['Slides file ID'] ? {id: c['Slides file ID'], name: c['Slides name']} : null, pass: Number(c['Pass %']) || 80,
          required: c['Required'] === true || c['Required'] === 'TRUE' || c['Required'] === 'Yes', assigned: String(c['Assigned to'] || 'All'),
          due: c['Due date'], repeat: c['Repeat'] || 'Once', status: c['Status'] || 'Active', questions: q.length,
          quiz: admin ? q : q.map(function (x) { return {question: x.question, options: x.options}; })};   // pilots never receive answers
}
function bestCompletion(ss, courseId, pilotId) {
  var list = rows(ss.getSheetByName('Completions')).filter(function (r) { return String(r['Course ID']) === courseId && String(r['Pilot ID']) === pilotId && (r['Passed'] === true || r['Passed'] === 'TRUE' || r['Passed'] === 'Yes'); });
  list.sort(function (a, b) { return (mdy(b['Completed']) || 0) - (mdy(a['Completed']) || 0); });
  return list[0] || null;
}
function trainStatus(ss, c, pilotId) {
  var done = bestCompletion(ss, String(c['Course ID']), pilotId), now = new Date();
  if (done) {
    var until = mdy(done['Valid until']);
    if (!until || until >= now) return {state: 'done', completed: done['Completed'], score: done['Score %'], until: done['Valid until'] || ''};
  }
  var due = mdy(c['Due date']);
  return {state: due && due < now ? 'overdue' : 'due', due: c['Due date'] || '', expired: done ? done['Valid until'] : ''};
}

function trainAction(d) {
  var ss = pilotBook(), me = pilotAuth(d, ss), lock = LockService.getScriptLock();
  var C = ss.getSheetByName('Courses'), X = ss.getSheetByName('Completions');
  var adminOnly = function () { if (!me.admin) throw new Error('admins only'); };

  if (d.action === 'train.list') {
    var mine = trainCourses(ss).filter(function (c) { return (c['Status'] || 'Active') === 'Active' && assignedTo(c, me.id); }).map(function (c) {
      var o = courseOut(c, false); delete o.quiz; o.my = trainStatus(ss, c, me.id); return o; });
    var out = {ok: true, courses: mine, admin: me.admin};
    if (me.admin) {
      out.all = trainCourses(ss).map(function (c) { var o = courseOut(c, false); delete o.quiz; return o; });
      out.pilots = rows(ss.getSheetByName('Pilots')).filter(function (p) { return p['Status'] !== 'Inactive'; }).map(function (p) {
        return {id: String(p['Pilot ID']), name: p['Name'] || p['Pilot ID'], status: trainCourses(ss).filter(function (c) { return (c['Status'] || 'Active') === 'Active'; }).reduce(function (m, c) {
          if (assignedTo(c, String(p['Pilot ID']))) m[String(c['Course ID'])] = trainStatus(ss, c, String(p['Pilot ID'])); return m; }, {})}; });
    }
    return out;
  }
  if (d.action === 'train.get') {
    var r = findRow(C, 'Course ID', String(d.course));
    if (!r || (!me.admin && !assignedTo(r.obj, me.id))) return {ok: false, error: 'course not found'};
    var o = courseOut(r.obj, me.admin && d.edit); o.my = trainStatus(ss, r.obj, me.id); return {ok: true, course: o};
  }
  if (d.action === 'train.slides') {
    var rs = findRow(C, 'Course ID', String(d.course));
    if (!rs || !rs.obj['Slides file ID'] || (!me.admin && !assignedTo(rs.obj, me.id))) return {ok: false, error: 'slides not found'};
    var bl = DriveApp.getFileById(String(rs.obj['Slides file ID'])).getBlob();
    return {ok: true, mime: bl.getContentType(), name: rs.obj['Slides name'], data: Utilities.base64Encode(bl.getBytes())};
  }
  if (d.action === 'train.save') {
    adminOnly(); lock.waitLock(20000);
    try {
      var f = d.course || {}, id = String(f.id || ''), old = id ? findRow(C, 'Course ID', id) : null;
      if (!id) { var props = PropertiesService.getScriptProperties(), n = Number(props.getProperty('COURSE_NEXT') || 1); id = 'TR-' + ('00' + n).slice(-3); props.setProperty('COURSE_NEXT', String(n + 1)); }
      var quiz = (f.quiz || []).filter(function (q) { return q && q.question && q.options && q.options.length >= 2; }).slice(0, 50).map(function (q) {
        return {question: String(q.question).slice(0, 500), options: q.options.slice(0, 6).map(function (x) { return String(x).slice(0, 300); }),
                answer: Math.max(0, Math.min(q.options.length - 1, Number(q.answer) || 0)), explanation: String(q.explanation || '').slice(0, 500)}; });
      var slidesId = old ? old.obj['Slides file ID'] : '', slidesName = old ? old.obj['Slides name'] : '';
      if (d.slides && d.slides.data) {
        var bytes = Utilities.base64Decode(d.slides.data);
        if (bytes.length > 25 * 1024 * 1024) return {ok: false, error: 'slides file is larger than 25 MB'};
        var tf = folder(folder(folder(null, ROOT_FOLDER), 'Training'), id).createFile(Utilities.newBlob(bytes, 'application/pdf', String(d.slides.name || 'slides.pdf').replace(/[^\w.\- ]+/g, '_')));
        slidesId = tf.getId(); slidesName = tf.getName();
      }
      if (f.removeSlides) { slidesId = ''; slidesName = ''; }
      var vals = [id, clean(f.title, 120) || 'Untitled course', clean(f.category, 40), clean(f.description, 3000), clean(f.link, 500), slidesId, slidesName,
                  JSON.stringify(quiz), Math.max(0, Math.min(100, Number(f.pass) || 80)), f.required ? 'Yes' : 'No', clean(f.assigned || 'All', 1000),
                  clean(f.due, 20), f.repeat === 'Yearly' ? 'Yearly' : 'Once', f.status === 'Archived' ? 'Archived' : f.status === 'Deleted' ? 'Deleted' : 'Active',
                  old ? old.obj['Created'] : new Date(), clean(me.name, 80)];
      if (old) C.getRange(old.i, 1, 1, vals.length).setValues([vals]); else C.appendRow(vals);
      return {ok: true, course: courseOut(findRow(C, 'Course ID', id).obj, true)};
    } finally { lock.releaseLock(); }
  }
  if (d.action === 'train.submit') {
    var rr = findRow(C, 'Course ID', String(d.course));
    if (!rr || !assignedTo(rr.obj, me.id)) return {ok: false, error: 'course not found'};
    var c = rr.obj, q = parseQuiz(c), ans = d.answers || [], right = 0, missed = [];
    q.forEach(function (x, i) { if (Number(ans[i]) === Number(x.answer)) right++; else missed.push(i + 1); });
    var score = q.length ? Math.round(right / q.length * 100) : 100, pass = Number(c['Pass %']) || 80, passed = score >= pass;
    if (!passed) return {ok: true, passed: false, score: score, pass: pass, missed: missed};
    if (!d.signature) return {ok: false, error: 'signature required'};
    var now = new Date(), until = c['Repeat'] === 'Yearly' ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()) : null;
    var fmt = function (x) { return Utilities.formatDate(x, 'America/Los_Angeles', 'MM/dd/yyyy'); };
    var pr = findRow(ss.getSheetByName('Pilots'), 'Pilot ID', me.id), pname = (pr && pr.obj['Name']) || me.name;
    var esc = function (t) { return String(t || '').replace(/[&<>"]/g, function (ch) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]; }); };
    var sig = /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(String(d.signature)) ? d.signature : '';
    var html = '<html><body style="font-family:Helvetica,Arial,sans-serif;color:#0b1f33;margin:0;padding:48px;border:10px solid #0b1f33">' +
      '<div style="text-align:center"><div style="color:#c8102e;font-weight:bold;letter-spacing:3px;font-size:13px">OVERHEAD UAS</div>' +
      '<h1 style="font-size:34px;margin:14px 0 6px">Certificate of Training Completion</h1><p style="color:#5b6b7a;margin:0 0 28px">This certifies that</p>' +
      '<div style="font-size:28px;font-weight:bold;border-bottom:2px solid #9aa7b3;display:inline-block;padding:0 30px 6px">' + esc(pname) + '</div>' +
      '<p style="color:#5b6b7a;margin:26px 0 6px">has successfully completed</p><div style="font-size:22px;font-weight:bold">' + esc(c['Title']) + '</div>' +
      '<p style="margin:8px 0 0;color:#5b6b7a">' + esc(c['Category'] || 'Training') + ' · ' + String(c['Course ID']) + '</p>' +
      '<p style="margin:26px 0 0">Score: <b>' + score + '%</b> (pass ' + pass + '%) &nbsp;·&nbsp; Completed: <b>' + fmt(now) + '</b>' + (until ? ' &nbsp;·&nbsp; Valid until: <b>' + fmt(until) + '</b>' : '') + '</p>' +
      (sig ? '<div style="margin-top:28px"><img src="' + sig + '" style="height:60px"><div style="border-top:1px solid #9aa7b3;width:260px;margin:4px auto 0;font-size:12px;color:#5b6b7a">Pilot signature</div></div>' : '') +
      '<p style="margin-top:30px;font-size:11px;color:#5b6b7a">Overhead UAS · www.overheaduas.com · (760) 527-3267 · Electronically signed in the Overhead UAS Pilot Portal</p></div></body></html>';
    var pdf = Utilities.newBlob(html, 'text/html', 'cert.html').getAs('application/pdf');
    pdf.setName(('Training_' + c['Title'] + '_' + fmt(now)).replace(/[^\w.\- ]+/g, '_') + '.pdf');
    var file = pilotFolder(pname, me.id).createFile(pdf);
    X.appendRow([String(c['Course ID']), clean(c['Title'], 120), me.id, clean(pname, 80), score, 'Yes', now, until || '', file.getId()]);
    ss.getSheetByName('Documents').appendRow([file.getId(), me.id, 'Other certificate', clean('Training: ' + c['Title'], 120), '', '', until ? fmt(until) : '', file.getName(), now, clean(pname, 80), 'Active']);
    return {ok: true, passed: true, score: score, pass: pass, certificate: file.getId(), until: until ? fmt(until) : ''};
  }
  if (d.action === 'train.ai') { adminOnly(); return aiQuiz(d, C); }
  return {ok: false, error: 'unknown action'};
}

// ----- AI quiz writer (Claude API). Needs ANTHROPIC_API_KEY in Project Settings > Script Properties.
function aiQuiz(d, C) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return {ok: false, error: 'AI quiz writer is not set up yet: add ANTHROPIC_API_KEY in Apps Script Project Settings > Script Properties'};
  var n = Math.max(3, Math.min(20, Number(d.count) || 10)), content = [], text = String(d.text || '').slice(0, 150000);
  var fileId = d.slidesId || '';
  if (!fileId && d.course) { var r = findRow(C, 'Course ID', String(d.course)); if (r) fileId = r.obj['Slides file ID'] || ''; }
  if (fileId) {
    var bl = DriveApp.getFileById(String(fileId)).getBlob();
    if (bl.getBytes().length > 30 * 1024 * 1024) return {ok: false, error: 'slides PDF is too large for the AI writer (30 MB max)'};
    content.push({type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(bl.getBytes())}});
  }
  if (!fileId && text.length < 200) return {ok: false, error: 'Add the training material first: upload the slides PDF or paste the video transcript / notes'};
  content.push({type: 'text', text:
    (text ? 'Training material (transcript or notes):\n<material>\n' + text + '\n</material>\n\n' : '') +
    'You write quizzes for Overhead UAS, a commercial drone (FAA Part 107) company. Course: "' + String(d.title || '').slice(0, 200) + '".\n' +
    'Write exactly ' + n + ' multiple-choice questions that check a pilot understood the important points of the material above' + (fileId ? ' (the attached slides' + (text ? ' and the notes' : '') + ')' : '') + '. ' +
    'Base every question only on the material - do not add facts it does not contain. Each question has exactly 4 options with one correct answer; ' +
    'make the wrong options plausible, avoid "all of the above" / "none of the above", and vary the position of the correct answer. ' +
    '"answer" is the 0-based index of the correct option. "explanation" is one short sentence saying why it is correct.'});
  var schema = {type: 'object', additionalProperties: false, required: ['questions'], properties: {questions: {type: 'array', items: {type: 'object', additionalProperties: false,
    required: ['question', 'options', 'answer', 'explanation'], properties: {question: {type: 'string'}, options: {type: 'array', items: {type: 'string'}}, answer: {type: 'integer'}, explanation: {type: 'string'}}}}}};
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01'},
    payload: JSON.stringify({model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default',
      output_config: {effort: 'low', format: {type: 'json_schema', schema: schema}},
      messages: [{role: 'user', content: content}]})});
  var code = res.getResponseCode(), j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (code !== 200) return {ok: false, error: 'AI service error ' + code + (j.error && j.error.message ? ': ' + j.error.message : '')};
  if (j.stop_reason === 'refusal') return {ok: false, error: 'The AI declined to write this quiz. Write the questions manually.'};
  if (j.stop_reason === 'max_tokens') return {ok: false, error: 'The AI ran out of room. Try fewer questions or shorter material.'};
  var out = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var qs; try { qs = JSON.parse(out).questions || []; } catch (e) { return {ok: false, error: 'The AI reply could not be read. Try again.'}; }
  qs = qs.filter(function (q) { return q.question && q.options && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length; });
  return {ok: true, questions: qs, usage: j.usage || {}};
}
