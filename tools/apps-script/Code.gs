/**
 * Overhead UAS - signed agreement receiver (Google Apps Script web app)
 *
 * Receives signed forms from the Pilot Portal (service agreements, mission
 * sheets, incident reports), then:
 *   1. saves the PDF to Google Drive: "Overhead UAS Records/<form type>/<YYYY-MM>/"
 *   2. emails it to Overhead UAS
 *   3. emails a copy to the client (service agreements, if an email was entered)
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

/** Run this once from the editor to grant permissions (Drive + Gmail). */
function authorize() {
  DriveApp.getRootFolder();
  GmailApp.getAliases();
}
