// Roman Chariots — Google Sheets Cloud Sync + Receipt Scanner
// Deploy with: Documents/Code/Claude/.clasp/gas_deploy.sh romanchariots
// Sheet "ChariotsData": data split over A1..An (a cell holds at most 50,000 characters),
//   B1 = last save time, C1 = keep-alive ping, D1 = part count, E1 = total length, F1 = transaction count.
//   Before Oct 2026 the whole JSON lived in A1 alone; that broke once the data passed 50,000 characters.
// Sheet "ChariotsBackups": one snapshot a day (A = time, B = transactions, C = length, D.. = parts), last 14 kept.
// Chunked uploads (save_chunk/save_done) carry a save id in "sv" — Google rejects a "sid" parameter with HTTP 400.
// Every save is parsed and checked before it touches the sheet, so a truncated or empty upload can't
// overwrite good data. ns=test uses the *_test sheets so the app can be tested without touching real data.
// Receipt scans use Gemini API — set GEMINI_API_KEY in Script Properties
// Scan flow: POST image (no-cors) → stores result → GET polls for result

var PART_SIZE = 45000;   // characters per cell, under the 50,000 limit
var PART_MARK = '~';     // stored in front of every part so Sheets never reads one as a number, date or formula
var CHUNK_TTL = 600;     // seconds an uploaded chunk waits for save_done
var BACKUP_KEEP = 14;    // daily snapshots kept
var BACKUP_EVERY_MS = 20 * 3600 * 1000;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || '';
  var callback = p.callback;
  var ns = p.ns === 'test' ? 'test' : '';

  if (action === 'load') {
    return wrapResponse(handleLoad(ns), callback);
  }
  if (action === 'meta') {
    return wrapResponse(handleMeta(ns), callback);
  }
  if (action === 'save') {
    return wrapResponse(handleSave(p.data || '', {ns: ns, force: p.force === '1'}), callback);
  }
  if (action === 'save_chunk') {
    var i = parseInt(p.i || '0', 10);
    CacheService.getScriptCache().put(chunkKey(ns, p.sv, i), p.cd || '', CHUNK_TTL);
    return wrapResponse({ok: true}, callback);
  }
  if (action === 'save_done') {
    return wrapResponse(handleSaveDone(ns, p), callback);
  }
  if (action === 'scan_result') {
    return wrapResponse(handleScanResult(p.id), callback);
  }

  return wrapResponse({ok: false, error: 'Unknown action: ' + action}, callback);
}

function doPost(e) {
  try {
    var body = e.postData ? e.postData.contents : '';
    var parsed = null;
    try { parsed = JSON.parse(body); } catch(parseErr) {}

    if (parsed && parsed.action === 'scan_receipt') {
      handleScanReceipt(parsed.id, parsed.image);
      return jsonOut({ok: true});
    }

    if (parsed && parsed.action === 'save' && parsed.data) {
      // ns can come in the body or on the URL (test builds post to .../exec?ns=test)
      var nsIn = parsed.ns || (e.parameter && e.parameter.ns);
      var ns = nsIn === 'test' ? 'test' : '';
      return jsonOut(handleSave(parsed.data, {ns: ns, force: parsed.force === true || parsed.force === '1'}));
    }

    // Legacy: form-encoded or raw body
    if (e.parameter && e.parameter.data) return jsonOut(handleSave(e.parameter.data, {}));
    if (body) return jsonOut(handleSave(body, {}));

    return jsonOut({ok: false, error: 'No data received'});
  } catch (err) {
    return jsonOut({ok: false, error: err.message});
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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

// ===== STORAGE =====

function dataSheet(ns, create) {
  var name = ns === 'test' ? 'ChariotsData_test' : 'ChariotsData';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet && create) sheet = ss.insertSheet(name);
  return sheet;
}

function splitParts(str) {
  var parts = [];
  for (var i = 0; i < str.length; i += PART_SIZE) parts.push(PART_MARK + str.substring(i, i + PART_SIZE));
  return parts;
}

function joinParts(values) {
  var out = '';
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i][0] || '');
    if (v.charAt(0) === PART_MARK) v = v.substring(1);
    out += v;
  }
  return out;
}

// Returns {data, ts, count} — data is the stored JSON string, or '' when nothing is stored
function readData(sheet) {
  if (!sheet) return {data: '', ts: null, count: null};
  var head = sheet.getRange(1, 2, 1, 5).getValues()[0]; // B1:F1
  var parts = Number(head[2]) || 0;
  var data;
  if (parts > 0) {
    data = joinParts(sheet.getRange(1, 1, parts, 1).getValues());
  } else {
    data = String(sheet.getRange('A1').getValue() || ''); // single-cell layout from before Oct 2026
  }
  return {data: data, ts: head[0] || null, count: head[4] === '' ? null : Number(head[4])};
}

function writeData(sheet, str, count) {
  var parts = splitParts(str);
  var last = sheet.getLastRow();
  sheet.getRange(1, 1, parts.length, 1).setNumberFormat('@')
    .setValues(parts.map(function(p) { return [p]; }));
  if (last > parts.length) sheet.getRange(parts.length + 1, 1, last - parts.length, 1).clearContent();
  var ts = new Date().toISOString();
  sheet.getRange('B1').setValue(ts);
  sheet.getRange(1, 4, 1, 3).setValues([[parts.length, str.length, count]]); // D1:F1
  return ts;
}

function countTransactions(str) {
  try {
    var d = JSON.parse(str);
    return d && Array.isArray(d.transactions) ? d.transactions.length : 0;
  } catch (e) {
    return 0;
  }
}

// ===== SAVE / LOAD =====

function handleSave(dataStr, opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    if (!dataStr) return {ok: false, error: 'No data'};

    var parsed;
    try { parsed = JSON.parse(dataStr); } catch (e) {
      return {ok: false, error: 'invalid_json', len: dataStr.length};
    }
    if (!parsed || !Array.isArray(parsed.transactions)) return {ok: false, error: 'no_transactions'};
    var count = parsed.transactions.length;
    if (count === 0 && !opts.force) return {ok: false, error: 'empty'};

    lock.waitLock(30000);
    locked = true;
    var sheet = dataSheet(opts.ns, true);
    var prev = readData(sheet);
    var prevCount = prev.count !== null ? prev.count : countTransactions(prev.data);
    // A device with stale or partial data must not wipe out most of the history
    if (!opts.force && prevCount >= 20 && count < prevCount * 0.5) {
      return {ok: false, error: 'shrink_guard', count: count, cloudCount: prevCount};
    }

    var ts = writeData(sheet, dataStr, count);
    backupIfDue(opts.ns, dataStr, count);
    return {ok: true, saved: true, ts: ts, count: count, len: dataStr.length};
  } catch (err) {
    return {ok: false, error: err.message};
  } finally {
    if (locked) lock.releaseLock();
  }
}

function handleSaveDone(ns, p) {
  var n = parseInt(p.n || '0', 10);
  var cache = CacheService.getScriptCache();
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(chunkKey(ns, p.sv, i));
  var got = cache.getAll(keys);
  var assembled = '';
  var missing = [];
  for (var j = 0; j < n; j++) {
    var c = got[keys[j]];
    if (c === undefined || c === null) missing.push(j);
    else assembled += c;
  }
  // The cache can drop chunks; report them so the client re-sends just those and calls save_done again
  if (missing.length) return {ok: false, error: 'missing_chunk', missing: missing.slice(0, 200), index: missing[0]};
  if (p.len && assembled.length !== parseInt(p.len, 10)) {
    return {ok: false, error: 'length_mismatch', got: assembled.length, want: parseInt(p.len, 10)};
  }
  var result = handleSave(assembled, {ns: ns, force: p.force === '1'});
  if (result.ok) cache.removeAll(keys);
  return result;
}

function chunkKey(ns, sv, i) {
  return 'rc_chunk_' + (ns ? ns + '_' : '') + (sv ? sv + '_' : '') + i;
}

function handleLoad(ns) {
  try {
    var r = readData(dataSheet(ns, false));
    return {ok: true, data: r.data || null, ts: r.ts, count: r.count};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

function handleMeta(ns) {
  try {
    var sheet = dataSheet(ns, false);
    if (!sheet) return {ok: true, ts: null, count: null, len: 0, parts: 0};
    var head = sheet.getRange(1, 2, 1, 5).getValues()[0];
    return {ok: true, ts: head[0] || null, parts: Number(head[2]) || 0, len: Number(head[3]) || 0,
            count: head[4] === '' ? null : Number(head[4])};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

// One snapshot a day of what was just saved, so a bad day can be rolled back by hand
function backupIfDue(ns, dataStr, count) {
  var name = ns === 'test' ? 'ChariotsBackups_test' : 'ChariotsBackups';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var last = sheet.getLastRow();
  if (last > 0) {
    var lastTs = new Date(sheet.getRange(last, 1).getValue()).getTime();
    if (Date.now() - lastTs < BACKUP_EVERY_MS) return;
  }
  var parts = splitParts(dataStr);
  var row = [new Date().toISOString(), count, dataStr.length].concat(parts);
  if (row.length > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
  sheet.getRange(last + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  var rows = sheet.getLastRow();
  if (rows > BACKUP_KEEP) sheet.deleteRows(1, rows - BACKUP_KEEP);
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
  var sheet = dataSheet('', false);
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
