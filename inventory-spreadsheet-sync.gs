/**
 * Zaikon 在庫管理 → Googleスプレッドシート 安全同期
 *
 * 重要:
 * - 既存の「大須」「那古野」「鉄板」「鎌倉」シートは読み取りだけです。
 * - 書き込み先は「連携_大須」「連携_那古野」「連携_鉄板」「連携_鎌倉」と
 *   「Zaikon連携設定」だけです。
 * - スプレッドシートからFirestoreへ書き戻す処理はありません。
 */

const ZAIKON_SYNC = Object.freeze({
  projectId: 'zaiko2017inb',
  documentPath: 'inventory/main',
  settingsSheet: 'Zaikon連携設定',
  stores: Object.freeze([
    { id: 1, sourceSheet: '大須', stageSheet: '連携_大須' },
    { id: 2, sourceSheet: '那古野', stageSheet: '連携_那古野' },
    { id: 3, sourceSheet: '鉄板', stageSheet: '連携_鉄板' },
    { id: 4, sourceSheet: '鎌倉', stageSheet: '連携_鎌倉' },
  ]),
  headers: Object.freeze([
    '商品ID', '物品名', 'カテゴリ', '保管場所', '単価', '数量', '単位', '税率',
    '棚卸額8%', '棚卸額10%', '更新日', '備考', '状態', '取得日時'
  ]),
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Zaikon連携')
    .addItem('① 初期設定（元シートは変更しない）', 'setupZaikonSafeSync')
    .addItem('② 連携シートへ安全同期', 'syncZaikonToStaging')
    .addSeparator()
    .addItem('1時間ごとの自動同期を開始', 'enableZaikonHourlySync')
    .addItem('自動同期を停止', 'disableZaikonAutoSync')
    .addToUi();
}

function setupZaikonSafeSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('対象スプレッドシートからApps Scriptを開いて実行してください。');
  PropertiesService.getScriptProperties().setProperty('ZAIKON_SPREADSHEET_ID', ss.getId());
  const missing = ZAIKON_SYNC.stores
    .filter(store => !ss.getSheetByName(store.sourceSheet))
    .map(store => store.sourceSheet);

  if (missing.length) {
    throw new Error('既存シートが見つかりません: ' + missing.join('、'));
  }

  const settings = getOrCreateSheet_(ss, ZAIKON_SYNC.settingsSheet);
  settings.clear();
  settings.getRange('A1:B7').setValues([
    ['Zaikon在庫連携', '設定値'],
    ['モード', '安全確認（既存4シートは変更しない）'],
    ['Firebaseプロジェクト', ZAIKON_SYNC.projectId],
    ['Firestore保存先', ZAIKON_SYNC.documentPath],
    ['同期先', '連携_大須／連携_那古野／連携_鉄板／連携_鎌倉'],
    ['最終同期', '未実行'],
    ['注意', '元シートへの書き戻し機能はありません'],
  ]);
  formatSettingsSheet_(settings);

  ZAIKON_SYNC.stores.forEach(store => {
    const stage = getOrCreateSheet_(ss, store.stageSheet);
    prepareStageSheet_(stage);
  });

  SpreadsheetApp.getUi().alert(
    '初期設定が完了しました。\n\n既存の大須・那古野・鉄板・鎌倉シートと数字は変更していません。\n次に「Zaikon連携 → ② 連携シートへ安全同期」を実行してください。'
  );
}

function syncZaikonToStaging() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('別の同期処理が実行中です。少し待ってから再実行してください。');
  }

  try {
    const ss = getZaikonSpreadsheet_();
    assertSafeStructure_(ss);
    const inventory = fetchFirestoreInventory_();
    const activeItems = inventory.allItems.filter(item => item.active !== false);
    const fetchedAt = new Date();

    ZAIKON_SYNC.stores.forEach(store => {
      const source = ss.getSheetByName(store.sourceSheet);
      const stage = ss.getSheetByName(store.stageSheet);
      const sourceMeta = readExistingMetadata_(source);
      const storeItems = activeItems
        .filter(item => Number(item.storeId) === store.id)
        .sort(compareInventoryItems_);

      writeStageSheet_(stage, storeItems, sourceMeta, fetchedAt);
    });

    const settings = ss.getSheetByName(ZAIKON_SYNC.settingsSheet);
    settings.getRange('B6').setValue(fetchedAt).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    SpreadsheetApp.flush();
    ss.toast('既存4シートを変更せず、連携シートだけを更新しました。', 'Zaikon連携', 8);
  } finally {
    lock.releaseLock();
  }
}

function enableZaikonHourlySync() {
  disableZaikonAutoSync(false);
  ScriptApp.newTrigger('syncZaikonToStaging')
    .timeBased()
    .everyHours(1)
    .create();
  getZaikonSpreadsheet_().toast(
    '1時間ごとの自動同期を開始しました。書き込み先は連携シートだけです。',
    'Zaikon連携',
    8
  );
}

function disableZaikonAutoSync(showMessage) {
  const shouldShow = showMessage !== false;
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'syncZaikonToStaging')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  if (shouldShow) {
    getZaikonSpreadsheet_().toast('自動同期を停止しました。', 'Zaikon連携', 5);
  }
}

function assertSafeStructure_(ss) {
  const missingSource = ZAIKON_SYNC.stores
    .filter(store => !ss.getSheetByName(store.sourceSheet))
    .map(store => store.sourceSheet);
  if (missingSource.length) {
    throw new Error('既存シートが見つかりません: ' + missingSource.join('、'));
  }

  const missingStage = ZAIKON_SYNC.stores
    .filter(store => !ss.getSheetByName(store.stageSheet))
    .map(store => store.stageSheet);
  if (missingStage.length || !ss.getSheetByName(ZAIKON_SYNC.settingsSheet)) {
    throw new Error('先に「① 初期設定」を実行してください。');
  }
}

function fetchFirestoreInventory_() {
  const encodedPath = ZAIKON_SYNC.documentPath.split('/').map(encodeURIComponent).join('/');
  const url = 'https://firestore.googleapis.com/v1/projects/'
    + encodeURIComponent(ZAIKON_SYNC.projectId)
    + '/databases/(default)/documents/'
    + encodedPath;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Accept: 'application/json' },
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Firestoreの取得に失敗しました（HTTP ' + status + '）: '
      + response.getContentText().slice(0, 300));
  }

  const document = JSON.parse(response.getContentText());
  const data = decodeFirestoreFields_(document.fields || {});
  if (!Array.isArray(data.allItems) || !Array.isArray(data.stores)) {
    throw new Error('Firestoreの在庫データ形式を確認できませんでした。');
  }
  return data;
}

function decodeFirestoreFields_(fields) {
  const result = {};
  Object.keys(fields || {}).forEach(key => {
    result[key] = decodeFirestoreValue_(fields[key]);
  });
  return result;
}

function decodeFirestoreValue_(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return new Date(value.timestampValue);
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue_);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return decodeFirestoreFields_(value.mapValue.fields || {});
  }
  return null;
}

function readExistingMetadata_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  const nameIndex = findHeaderIndex_(headers, ['物品名', '商品名', '品名']);
  const locationIndex = findHeaderIndex_(headers, ['保管場所', '保存場所', '保管']);
  const amount8Index = findHeaderIndex_(headers, ['棚卸額8%', '棚卸額8％', '8%棚卸額', '8％棚卸額']);
  const amount10Index = findHeaderIndex_(headers, ['棚卸額10%', '棚卸額10％', '10%棚卸額', '10％棚卸額']);
  const noteIndex = findHeaderIndex_(headers, ['備考', 'メモ']);
  if (nameIndex < 0) return {};

  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const metadata = {};
  rows.forEach(row => {
    const name = String(row[nameIndex] || '').trim();
    if (!name) return;
    const key = normalizeProductName_(name);
    if (!key || metadata[key]) return;

    const amount8 = amount8Index >= 0 ? (Number(row[amount8Index]) || 0) : 0;
    const amount10 = amount10Index >= 0 ? (Number(row[amount10Index]) || 0) : 0;
    metadata[key] = {
      location: locationIndex >= 0 ? (row[locationIndex] || '') : '',
      taxRate: amount10 !== 0 ? 10 : (amount8 !== 0 ? 8 : ''),
      note: noteIndex >= 0 ? (row[noteIndex] || '') : '',
    };
  });
  return metadata;
}

function findHeaderIndex_(headers, candidates) {
  const normalized = headers.map(normalizeHeader_);
  for (const candidate of candidates) {
    const index = normalized.indexOf(normalizeHeader_(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

function normalizeHeader_(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

function writeStageSheet_(sheet, items, metadata, fetchedAt) {
  prepareStageSheet_(sheet);
  const rows = items.map(item => {
    const meta = metadata[normalizeProductName_(item.name)] || {};
    return [
      Number(item.id) || '',
      item.name || '',
      item.cat || '',
      meta.location || '',
      Number(item.price) || 0,
      Number(item.qty) || 0,
      item.unit || '',
      meta.taxRate || '',
      '',
      '',
      item.updatedAt || '',
      meta.note || '',
      '棚卸対象',
      fetchedAt,
    ];
  });

  const oldLastRow = sheet.getLastRow();
  if (oldLastRow > 1) {
    sheet.getRange(2, 1, oldLastRow - 1, ZAIKON_SYNC.headers.length).clearContent();
  }

  if (!rows.length) return;
  const range = sheet.getRange(2, 1, rows.length, ZAIKON_SYNC.headers.length);
  range.setValues(rows);

  const formulas8 = [];
  const formulas10 = [];
  for (let row = 2; row < rows.length + 2; row += 1) {
    formulas8.push(['=IF($H' + row + '=8,ROUND($E' + row + '*$F' + row + ',0),"")']);
    formulas10.push(['=IF($H' + row + '=10,ROUND($E' + row + '*$F' + row + ',0),"")']);
  }
  sheet.getRange(2, 9, rows.length, 1).setFormulas(formulas8);
  sheet.getRange(2, 10, rows.length, 1).setFormulas(formulas10);

  sheet.getRange(2, 5, rows.length, 1).setNumberFormat('#,##0.##');
  sheet.getRange(2, 6, rows.length, 1).setNumberFormat('#,##0.##');
  sheet.getRange(2, 9, rows.length, 2).setNumberFormat('#,##0');
  sheet.getRange(2, 14, rows.length, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
}

function prepareStageSheet_(sheet) {
  const requiredColumns = ZAIKON_SYNC.headers.length;
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, requiredColumns).setValues([Array.from(ZAIKON_SYNC.headers)]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, requiredColumns)
    .setBackground('#1D9E75')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const widths = [80, 190, 110, 120, 85, 75, 70, 60, 100, 100, 150, 190, 90, 150];
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
  sheet.getRange('A1').setNote(
    'この「連携_」シートだけがZaikon同期の書き込み先です。元の店舗シートは変更しません。'
  );
}

function formatSettingsSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange('A1:B1')
    .setBackground('#1D9E75')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');
  sheet.getRange('A2:A7').setFontWeight('bold').setBackground('#E1F5EE');
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 430);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getZaikonSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('ZAIKON_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('先に「① 初期設定」を実行してください。');
  return active;
}

function normalizeProductName_(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

function compareInventoryItems_(a, b) {
  const category = String(a.cat || '').localeCompare(String(b.cat || ''), 'ja');
  if (category !== 0) return category;
  return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
}
