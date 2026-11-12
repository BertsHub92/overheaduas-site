/**
 * Overhead UAS - signed agreement receiver (Google Apps Script web app)
 *
 * Receives signed forms from the Pilot Portal (service agreements, mission
 * sheets, incident reports), then:
 *   1. saves the PDF to Google Drive: "Overhead UAS Records/<form type>/<YYYY-MM>/"
 *   2. emails it to Overhead UAS
 *   3. emails a copy to the client (service agreements, if an email was entered)
 *
 * Also runs the OVH-204 Maintenance & Repair Log (Google Sheet
 * "Overhead UAS Maintenance Log"): aircraft list, log entries, battery
 * checks, and history for printing. Only failed / grounded entries email.
 *
 * Setup: see the instructions Claude provided. Deploy as a Web app,
 * "Execute as: Me", "Who has access: Anyone".
 */
var TOKEN = 'PASTE_TOKEN_HERE';          // must match the Pilot Portal
var OFFICE_EMAIL = 'overheaduas@gmail.com';
var ROOT_FOLDER = 'Overhead UAS Records';

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
    var file = folder(folder(folder(null, ROOT_FOLDER), type), month).createFile(blob);

    // 2. Email Overhead UAS
    var s = data.summary || {};
    var lines = data.lines && data.lines.length ? [
      (data.intro || 'A new form was submitted through the Pilot Portal.'), ''
    ].concat(data.lines.map(String), ['', 'Document ID: ' + (data.docId || '-'), 'Saved to Google Drive: ' + file.getUrl()]) : [
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
    GmailApp.sendEmail(OFFICE_EMAIL, subject, lines.join('\n'),
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
    return reply({ok: true, sentClient: sentClient});
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
}

// ===================== OVH-204 Maintenance & Repair Log =====================
var MAINT_BOOK = 'Overhead UAS Maintenance Log';
var TABS = {
  Aircraft: ['Aircraft ID', 'Nickname', 'Make / model', 'Serial #', 'FAA registration #', 'Status', 'Added', 'Added by'],
  'Log Entries': ['Logged', 'Entry date', 'Aircraft ID', 'Aircraft', 'Entry type', 'Pilot', 'Result', 'Failed items', 'Total flight time (hrs)',
                  'Firmware', 'Work performed / parts replaced', 'Notes', 'Batteries checked', 'Document ID', 'PDF'],
  'Battery Checks': ['Logged', 'Entry date', 'Aircraft ID', 'Aircraft', 'Battery ID', 'Cycle count', 'Health %', 'Condition', 'Notes', 'Pilot', 'Document ID']
};

function maintBook() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('MAINT_BOOK_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(MAINT_BOOK);
    props.setProperty('MAINT_BOOK_ID', ss.getId());
    try { DriveApp.getFileById(ss.getId()).moveTo(folder(folder(null, ROOT_FOLDER), 'Maintenance')); } catch (e) {}
  }
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(TABS[name]); sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, TABS[name].length).setFontWeight('bold').setBackground('#0b1f33').setFontColor('#ffffff');
    }
  });
  var def = ss.getSheetByName('Sheet1'); if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss;
}

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
