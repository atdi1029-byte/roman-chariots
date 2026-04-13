// Roman Chariots — Google Sheets Cloud Sync + Receipt Scanner
// Deploy as Web App: Execute as Me, Anyone can access
// Sheet name: "ChariotsData" — data in A1, timestamp in B1
// Receipt scans use Gemini API — set GEMINI_API_KEY in Script Properties
// Scan flow: POST image (no-cors) → stores result → GET polls for result

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var callback = e && e.parameter && e.parameter.callback;

  if (action === 'load') {
    return wrapResponse(handleLoad(), callback);
  }
  if (action === 'save') {
    var dataParam = e.parameter.data || '';
    return wrapResponse(handleSave(dataParam), callback);
  }
  if (action === 'save_chunk') {
    var i = parseInt(e.parameter.i || '0');
    var cd = e.parameter.cd || '';
    CacheService.getScriptCache().put('rc_chunk_' + i, cd, 120);
    return wrapResponse({ok: true}, callback);
  }
  if (action === 'save_done') {
    var n = parseInt(e.parameter.n || '0');
    var cache = CacheService.getScriptCache();
    var assembled = '';
    for (var i = 0; i < n; i++) {
      assembled += cache.get('rc_chunk_' + i) || '';
      cache.remove('rc_chunk_' + i);
    }
    var result = handleSave(assembled);
    return wrapResponse(result, callback);
  }
  if (action === 'scan_result') {
    return wrapResponse(handleScanResult(e.parameter.id), callback);
  }

  return wrapResponse({ok: false, error: 'Unknown action: ' + action}, callback);
}

function doPost(e) {
  try {
    var body = e.postData ? e.postData.contents : '';
    // Parse JSON body (text/plain POST)
    var parsed = null;
    try { parsed = JSON.parse(body); } catch(parseErr) {}

    if (parsed && parsed.action === 'scan_receipt') {
      handleScanReceipt(parsed.id, parsed.image);
      return ContentService.createTextOutput(
        JSON.stringify({ok: true})
      ).setMimeType(ContentService.MimeType.JSON);
    }

    if (parsed && parsed.action === 'save' && parsed.data) {
      return ContentService.createTextOutput(JSON.stringify(handleSave(parsed.data))).setMimeType(ContentService.MimeType.JSON);
    }

    // Legacy: form-encoded or raw body
    if (e.parameter && e.parameter.data) {
      return ContentService.createTextOutput(JSON.stringify(handleSave(e.parameter.data))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body) return ContentService.createTextOutput(JSON.stringify(handleSave(body))).setMimeType(ContentService.MimeType.JSON);

    return ContentService.createTextOutput(
      JSON.stringify({ok: false, error: 'No data received'})
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok: false, error: err.message})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Wrap response for JSONP support
function wrapResponse(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function handleSave(dataStr) {
  try {
    if (!dataStr) {
      return {ok: false, error: 'No data'};
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ChariotsData');
    if (!sheet) {
      sheet = ss.insertSheet('ChariotsData');
    }

    sheet.getRange('A1').setValue(dataStr);
    sheet.getRange('B1').setValue(new Date().toISOString());

    return {ok: true, saved: true, ts: new Date().toISOString()};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

function handleLoad() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ChariotsData');
    if (!sheet) {
      return {ok: true, data: null, ts: null};
    }

    var dataStr = sheet.getRange('A1').getValue();
    var ts = sheet.getRange('B1').getValue();

    return {ok: true, data: dataStr || null, ts: ts || null};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

// ===== RECEIPT SCANNING =====

function handleScanReceipt(scanId, base64Image) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ScanResults');
  if (!sheet) {
    sheet = ss.insertSheet('ScanResults');
  }

  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
      storeScanResult(sheet, scanId, JSON.stringify({ok: false, error: 'No GEMINI_API_KEY in Script Properties'}));
      return;
    }

    // Call Gemini API
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    var payload = {
      contents: [{
        parts: [
          {text: 'Extract all items from this receipt. Return ONLY valid JSON, no markdown, no code blocks:\n{"store":"store name","date":"YYYY-MM-DD","items":[{"name":"item name","price":1.99}],"tax":0.50,"total":25.49}\nInclude every line item with its exact price. If the date is unclear, use null. Use short clean item names.'},
          {inline_data: {mime_type: 'image/jpeg', data: base64Image}}
        ]
      }],
      generationConfig: {
        temperature: 0.1
      }
    };

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var respCode = response.getResponseCode();
    var respBody = response.getContentText();

    if (respCode !== 200) {
      storeScanResult(sheet, scanId, JSON.stringify({ok: false, error: 'Gemini API error ' + respCode + ': ' + respBody.substring(0, 200)}));
      return;
    }

    var geminiResp = JSON.parse(respBody);
    var text = geminiResp.candidates[0].content.parts[0].text;

    // Extract JSON from response (strip markdown code blocks if present)
    var jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(jsonStr);

    storeScanResult(sheet, scanId, JSON.stringify({ok: true, receipt: parsed}));
  } catch (err) {
    storeScanResult(sheet, scanId, JSON.stringify({ok: false, error: err.message}));
  }
}

function storeScanResult(sheet, scanId, resultJson) {
  // Find next empty row or overwrite existing scan with same ID
  var data = sheet.getDataRange().getValues();
  var row = -1;
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === scanId) { row = i + 1; break; }
  }
  if (row === -1) row = data.length + 1;

  sheet.getRange(row, 1).setValue(scanId);
  sheet.getRange(row, 2).setValue(resultJson);
  sheet.getRange(row, 3).setValue(new Date().toISOString());

  // Clean up old scans (keep last 20)
  var allData = sheet.getDataRange().getValues();
  if (allData.length > 20) {
    sheet.deleteRows(1, allData.length - 20);
  }
}

function handleScanResult(scanId) {
  try {
    if (!scanId) return {ok: false, error: 'No scan ID'};

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ScanResults');
    if (!sheet) return {ok: true, pending: true};

    var data = sheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === scanId) {
        var result = JSON.parse(data[i][1]);
        return result;
      }
    }

    return {ok: true, pending: true};
  } catch (err) {
    return {ok: false, error: err.message};
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

// Test function — run this to check if Gemini API key works
function testGemini() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log('API Key: ' + (apiKey ? apiKey.substring(0,8) + '...' : 'NOT SET'));
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{parts: [{text: 'Say hello in one word'}]}]
  };
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Response: ' + response.getContentText().substring(0, 500));
}
