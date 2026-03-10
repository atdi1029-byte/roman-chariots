// Roman Chariots — Google Sheets Cloud Sync
// Deploy as Web App: Execute as Me, Anyone can access
// Sheet name: "ChariotsData" — data in A1, timestamp in B1
// Save uses POST (handles large payloads), Load uses GET

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'load') {
    return handleLoad();
  }
  if (action === 'save') {
    return handleSave(e.parameter.data || '');
  }

  return ContentService.createTextOutput(
    JSON.stringify({ok: false, error: 'Unknown action: ' + action})
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var dataStr = e.postData ? e.postData.contents : '';
    return handleSave(dataStr);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok: false, error: err.message})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleSave(dataStr) {
  try {
    if (!dataStr) {
      return ContentService.createTextOutput(
        JSON.stringify({ok: false, error: 'No data'})
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ChariotsData');
    if (!sheet) {
      sheet = ss.insertSheet('ChariotsData');
    }

    sheet.getRange('A1').setValue(dataStr);
    sheet.getRange('B1').setValue(new Date().toISOString());

    return ContentService.createTextOutput(
      JSON.stringify({ok: true, saved: true, ts: new Date().toISOString()})
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok: false, error: err.message})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleLoad() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ChariotsData');
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ok: true, data: null, ts: null})
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var dataStr = sheet.getRange('A1').getValue();
    var ts = sheet.getRange('B1').getValue();

    return ContentService.createTextOutput(
      JSON.stringify({ok: true, data: dataStr || null, ts: ts || null})
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok: false, error: err.message})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Keep-alive function — set up a 5-minute trigger to prevent cold starts
function keepAlive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ChariotsData');
  if (sheet) {
    sheet.getRange('C1').setValue('ping: ' + new Date().toISOString());
  }
}
