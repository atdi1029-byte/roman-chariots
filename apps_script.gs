// Roman Chariots — Google Sheets Cloud Sync
// Deploy as Web App: Execute as Me, Anyone can access
// Sheet name: "ChariotsData" — data in A1, timestamp in B1

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  const callback = (e && e.parameter && e.parameter.callback) || '';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('ChariotsData');
  if (!sheet) {
    sheet = ss.insertSheet('ChariotsData');
  }

  let result;

  if (action === 'save') {
    const data = e.parameter.data || '';
    sheet.getRange('A1').setValue(data);
    sheet.getRange('B1').setValue(new Date().toISOString());
    result = { ok: true };
  } else if (action === 'load') {
    const data = sheet.getRange('A1').getValue();
    const ts = sheet.getRange('B1').getValue();
    result = { ok: true, data: data || '', timestamp: ts || '' };
  } else {
    result = { error: 'Unknown action: ' + action };
  }

  // JSONP support
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(result) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Keep-alive function — set up a 5-minute trigger to prevent cold starts
function keepAlive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('ChariotsData');
  if (sheet) {
    sheet.getRange('C1').setValue('ping: ' + new Date().toISOString());
  }
}
