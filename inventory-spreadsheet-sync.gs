/**
 * Zaikon 在庫管理 → Googleスプレッドシート 安全同期
 *
 * 重要:
 * - 既存の「大須」「那古野」「鉄板」「鎌倉」シートは読み取りだけです。
 * - 棚卸同期の書き込み先は「連携_店舗名」と「Zaikon連携設定」です。
 * - 「価格マスター」の確認済み変更だけ、Firestoreの現在価格と履歴へ反映します。
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
    .addItem('③ 入力した年度で全店舗を保存', 'saveZaikonAnnualSnapshot')
    .addItem('④ 2025記録から2026年度を開始', 'migrateLegacy2025To2026')
    .addSeparator()
    .addItem('価格マスターを更新', 'syncZaikonPriceMaster')
    .addItem('価格変更を確認・反映', 'applyZaikonPriceChanges')
    .addItem('価格マスター自動更新を開始（5分ごと）', 'enableZaikonPriceAutoSync')
    .addSeparator()
    .addItem('自動同期を停止（年1回運用）', 'disableZaikonAutoSync')
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
  ensureSettingsLayout_(settings);
  settings.getRange('B6:B9').setValues([['未実行'], ['未設定'], ['未保存'], ['未設定']]);
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

    getSyncStores_(inventory).forEach(store => {
      const source = ss.getSheetByName(store.sourceSheet);
      const stage = getOrCreateSheet_(ss, store.stageSheet);
      prepareStageSheet_(stage);
      // 初回だけ元シートから補助情報を引き継ぎ、以後は連携シート側の変更を保持する。
      // 翌年度準備で税率・備考を空にした後、前年値が復活しないための構造。
      const metadataSource = stage.getLastRow() > 1 ? stage : (source || stage);
      const sourceMeta = readExistingMetadata_(metadataSource);
      const storeItems = activeItems
        .filter(item => Number(item.storeId) === store.id)
        .sort(compareInventoryItems_);

      writeStageSheet_(stage, storeItems, sourceMeta, fetchedAt);
    });

    const settings = ss.getSheetByName(ZAIKON_SYNC.settingsSheet);
    ensureSettingsLayout_(settings);
    settings.getRange('B6').setValue(fetchedAt).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    settings.getRange('B7').setValue(normalizeInventoryYear_(inventory.inventoryYear) || '未設定');
    SpreadsheetApp.flush();
    ss.toast('既存4シートを変更せず、連携シートだけを更新しました。', 'Zaikon連携', 8);
    return inventory;
  } finally {
    lock.releaseLock();
  }
}

function saveZaikonAnnualSnapshot() {
  const ss = getZaikonSpreadsheet_();
  const inventory = syncZaikonToStaging();
  const year = normalizeInventoryYear_(inventory && inventory.inventoryYear);
  if (!year) {
    throw new Error('在庫アプリで棚卸年（西暦4桁）を入力してから実行してください。');
  }

  const targets = getSyncStores_(inventory).map(store => ({
    store,
    name: String(year) + store.sourceSheet,
  }));
  const existing = targets.filter(target => ss.getSheetByName(target.name));
  if (existing.length) {
    SpreadsheetApp.getUi().alert(
      year + '年度の保存シートがすでにあります。\n\n' +
      existing.map(target => target.name).join('\n') +
      '\n\n前年・確定済みデータを守るため、上書きしませんでした。'
    );
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    year + '年度を確定保存します',
    targets.map(target => target.name).join('、') +
      ' を固定保存します。\n\n保存後、連携シートは ' + (year + 1) +
      '年度用に、商品ID・物品名・カテゴリ・保管場所・単位だけを残します。\n' +
      '確定タブは自動更新されません。実行しますか？',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('別の同期・保存処理が実行中です。少し待ってから再実行してください。');
  }
  const savedAt = new Date();
  const created = [];
  let allSnapshotsCreated = false;
  try {
    const newlyExisting = targets.filter(target => ss.getSheetByName(target.name));
    if (newlyExisting.length) {
      throw new Error('保存処理中に同名タブが作成されたため中止しました: ' +
        newlyExisting.map(target => target.name).join('、'));
    }
    // 対象店舗すべてを先に固定保存する。途中失敗時は今回作成分だけ取り消す。
    targets.forEach(target => {
      const source = ss.getSheetByName(target.store.stageSheet);
      created.push(createFixedYearSheet_(ss, source, target.name, year, savedAt));
    });
    allSnapshotsCreated = true;

    // 確定保存が全店舗成功した後だけ、翌年度の作業用シートを準備する。
    targets.forEach(target => {
      prepareNextYearStage_(ss.getSheetByName(target.store.stageSheet), year + 1);
    });

    const settings = ss.getSheetByName(ZAIKON_SYNC.settingsSheet);
    ensureSettingsLayout_(settings);
    settings.getRange('B8').setValue(year + '年度 / ' +
      Utilities.formatDate(savedAt, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss'));
    settings.getRange('B9').setValue((year + 1) + '年度（最新単価を保持し、数量・税率・棚卸額・更新日・備考は空欄）');
    SpreadsheetApp.flush();
    ss.toast(
      year + '年度を固定保存し、連携シートを' + (year + 1) + '年度用に準備しました。',
      'Zaikon年度保存',
      10
    );
  } catch (error) {
    // 確定4タブが揃う前の失敗だけ今回作成分を取り消す。
    // 確定後の翌年度準備で失敗した場合は、安全コピーとして確定タブを残す。
    if (!allSnapshotsCreated) {
      created.forEach(sheet => {
        try { ss.deleteSheet(sheet); } catch (cleanupError) { console.warn(cleanupError); }
      });
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function archiveOriginalSheetsByYear() {
  const ss = getZaikonSpreadsheet_();
  assertSafeStructure_(ss);
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '元4シートを年度名でコピー保存',
    '保存する西暦を4桁で入力してください。現在の元データが2025年3月棚卸なら「2025」と入力します。',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const year = normalizeInventoryYear_(response.getResponseText());
  if (!year) throw new Error('西暦4桁で入力してください。（例：2025）');

  const targets = ZAIKON_SYNC.stores.map(store => ({
    store,
    name: String(year) + store.sourceSheet,
  }));
  const existing = targets.filter(target => ss.getSheetByName(target.name));
  if (existing.length) {
    ui.alert(
      '同じ年度の保存タブがすでにあります。\n\n' +
      existing.map(target => target.name).join('\n') +
      '\n\n上書きしませんでした。'
    );
    return;
  }

  const answer = ui.alert(
    year + '年度の元データをコピー保存',
    '元の大須・那古野・鉄板・鎌倉は変更せず、' +
      targets.map(target => target.name).join('、') + ' を固定作成します。実行しますか？',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('別の処理が実行中です。少し待ってから再実行してください。');
  const savedAt = new Date();
  const created = [];
  try {
    const newlyExisting = targets.filter(target => ss.getSheetByName(target.name));
    if (newlyExisting.length) {
      throw new Error('保存処理中に同名タブが作成されたため中止しました: ' +
        newlyExisting.map(target => target.name).join('、'));
    }
    targets.forEach(target => {
      const source = ss.getSheetByName(target.store.sourceSheet);
      created.push(createFixedYearSheet_(ss, source, target.name, year, savedAt));
    });
    SpreadsheetApp.flush();
    ss.toast(year + '年度の元4シートを変更せずコピー保存しました。', 'Zaikon年度保存', 10);
  } catch (error) {
    created.forEach(sheet => {
      try { ss.deleteSheet(sheet); } catch (cleanupError) { console.warn(cleanupError); }
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function createFixedYearSheet_(ss, source, name, year, savedAt) {
  if (!source) throw new Error('コピー元シートが見つかりません: ' + name);
  const values = source.getDataRange().getValues();
  const fixed = source.copyTo(ss);
  try {
    fixed.setName(name);
    if (values.length && values[0].length) {
      fixed.getRange(1, 1, values.length, values[0].length).setValues(values);
    }
    fixed.setTabColor('#BA7517');
    fixed.getRange('A1').setNote(
      year + '年度の確定保存（' +
      Utilities.formatDate(savedAt, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss') +
      '）。このシートは固定値で、自動更新されません。'
    );
    return fixed;
  } catch (error) {
    try { ss.deleteSheet(fixed); } catch (cleanupError) { console.warn(cleanupError); }
    throw error;
  }
}

function prepareNextYearStage_(sheet, nextYear) {
  prepareStageSheet_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const rowCount = lastRow - 1;
    // 商品ID・物品名・カテゴリ・保管場所・最新単価・単位を残し、数量だけ次年度用に空にする。
    sheet.getRange(2, 6, rowCount, 1).clearContent();   // 数量
    sheet.getRange(2, 8, rowCount, 7).clearContent();   // 税率～取得日時
  }
  sheet.getRange('A1').setNote(
    nextYear + '年度の作業用シート。商品ID・物品名・カテゴリ・保管場所・最新単価・単位を保持し、' +
    '数量・税率・棚卸額・更新日・備考・状態は空欄です。元シートは変更していません。'
  );
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
  const missingStage = ZAIKON_SYNC.stores
    .filter(store => !ss.getSheetByName(store.stageSheet))
    .map(store => store.stageSheet);
  if (missingStage.length || !ss.getSheetByName(ZAIKON_SYNC.settingsSheet)) {
    throw new Error('先に「① 初期設定」を実行してください。');
  }
}

function migrateLegacy2025To2026() {
  const ss = getZaikonSpreadsheet_();
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('別の同期処理が実行中です。少し待って再実行してください。');

  const created = [];
  let firestoreReset = false;
  try {
    assertSafeStructure_(ss);
    const pairs = ZAIKON_SYNC.stores.map(store => ({
      store,
      original: ss.getSheetByName(store.sourceSheet),
      archive: ss.getSheetByName('2025' + store.sourceSheet),
      nextName: '2026' + store.sourceSheet,
    }));
    const missing = pairs.filter(pair => !pair.original || !pair.archive)
      .map(pair => pair.store.sourceSheet);
    if (missing.length) throw new Error('2025年度の照合対象が見つかりません: ' + missing.join('、'));
    const existingNext = pairs.filter(pair => ss.getSheetByName(pair.nextName));
    if (existingNext.length) throw new Error('2026年度タブがすでにあります: ' + existingNext.map(pair => pair.nextName).join('、'));

    pairs.forEach(pair => {
      const originalValues = pair.original.getDataRange().getValues();
      const archiveValues = pair.archive.getDataRange().getValues();
      if (JSON.stringify(originalValues) !== JSON.stringify(archiveValues)) {
        throw new Error(pair.store.sourceSheet + ' と 2025' + pair.store.sourceSheet + ' の内容が一致しないため中止しました。');
      }
    });

    const raw = fetchFirestoreDocumentRaw_();
    const inventory = decodeFirestoreFields_(raw.fields || {});
    const activeItems = (inventory.allItems || []).filter(item => item.active !== false);
    const fetchedAt = new Date();
    const stores = getSyncStores_(inventory);

    stores.forEach(store => {
      const stage = getOrCreateSheet_(ss, store.stageSheet);
      const metadata = readExistingMetadata_(stage);
      const items = activeItems
        .filter(item => Number(item.storeId) === Number(store.id))
        .map(item => Object.assign({}, item, { qty: 0, done: false }))
        .sort(compareInventoryItems_);
      const next = stage.copyTo(ss);
      created.push(next);
      next.setName('2026' + store.sourceSheet);
      prepareStageSheet_(next);
      writeStageSheet_(next, items, metadata, fetchedAt);
      const lastRow = next.getLastRow();
      if (lastRow > 1) {
        next.getRange(2, 6, lastRow - 1, 1).setValue(0).setNumberFormat('0.##');
        next.getRange(2, 9, lastRow - 1, 6).clearContent();
      }
      next.setTabColor('#4285F4');
      next.getRange('A1').setNote('2026年度の入力用シート。2025年度記録は固定保存済み。商品情報と最新価格を保持し、数量は0から開始します。');
    });

    const resetAt = new Date();
    const resetItems = (inventory.allItems || []).map(item => Object.assign({}, item, {
      qty: 0,
      done: false,
      updatedAt: Utilities.formatDate(resetAt, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss'),
    }));
    commitInventoryYearReset_(raw.updateTime, resetItems, 2026, resetAt);
    firestoreReset = true;

    pairs.forEach(pair => ss.deleteSheet(pair.original));
    PropertiesService.getScriptProperties().setProperty('ZAIKON_SPREADSHEET_ID', ss.getId());
    syncZaikonPriceMaster();
    SpreadsheetApp.flush();
    ui.alert('2025年度記録を残し、2026年度を開始しました。\n\n2026年度タブを数量0で作成し、アプリも2026年度・数量0へ更新しました。');
  } catch (error) {
    if (!firestoreReset) {
      created.forEach(sheet => { try { ss.deleteSheet(sheet); } catch (cleanupError) { console.warn(cleanupError); } });
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function commitInventoryYearReset_(updateTime, items, year, resetAt) {
  const name = 'projects/' + ZAIKON_SYNC.projectId + '/databases/(default)/documents/' + ZAIKON_SYNC.documentPath;
  const write = {
    update: {
      name,
      fields: {
        allItems: encodeFirestoreValue_(items),
        inventoryYear: encodeFirestoreValue_(year),
        updatedAt: { timestampValue: resetAt.toISOString() },
      },
    },
    updateMask: { fieldPaths: ['allItems', 'inventoryYear', 'updatedAt'] },
    currentDocument: { updateTime },
  };
  const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(ZAIKON_SYNC.projectId) + '/databases/(default)/documents:commit';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ writes: [write] }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('2026年度への更新に失敗しました（HTTP ' + response.getResponseCode() + '）: ' + response.getContentText().slice(0, 240));
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
  const taxRateIndex = findHeaderIndex_(headers, ['税率', '消費税率']);
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
    const directTaxRate = taxRateIndex >= 0 ? Number(row[taxRateIndex]) : 0;
    metadata[key] = {
      location: locationIndex >= 0 ? (row[locationIndex] || '') : '',
      taxRate: directTaxRate === 8 || directTaxRate === 10
        ? directTaxRate
        : (amount10 !== 0 ? 10 : (amount8 !== 0 ? 8 : '')),
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
      item.done ? '入力済み' : '',
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
  sheet.getRange('A2:A10').setFontWeight('bold').setBackground('#E1F5EE');
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 430);
}

function ensureSettingsLayout_(sheet) {
  sheet.getRange('A1:A10').setValues([
    ['Zaikon在庫連携'],
    ['モード'],
    ['Firebaseプロジェクト'],
    ['Firestore保存先'],
    ['同期先'],
    ['最終同期'],
    ['アプリの棚卸年'],
    ['最終年度保存'],
    ['連携シート作業年'],
    ['注意'],
  ]);
  sheet.getRange('B1:B5').setValues([
    ['設定値'],
    ['年1回・手動同期（既存4シートは変更しない）'],
    [ZAIKON_SYNC.projectId],
    [ZAIKON_SYNC.documentPath],
    ['連携_大須／連携_那古野／連携_鉄板／連携_鎌倉'],
  ]);
  sheet.getRange('B10').setValue('元シートと過年度シートへの書き戻し・上書きはありません');
  formatSettingsSheet_(sheet);
}

function normalizeInventoryYear_(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
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

// ============================================================
// v2: 新規店舗・価格マスター・確認付き書き戻し
// ============================================================
const ZAIKON_PRICE_SHEET = '価格マスター';
const ZAIKON_PRICE_HEADERS = Object.freeze([
  '商品ID','店舗ID','店舗名','商品名','仕入先','現在価格','新価格','価格変更日','変更者','備考','状態'
]);

function safeSheetName_(value) {
  return String(value || '新店舗').replace(/[\\/?*\[\]:]/g, '').slice(0, 70) || '新店舗';
}

function getSyncStores_(inventory) {
  const configured = new Map(ZAIKON_SYNC.stores.map(store => [Number(store.id), store]));
  return (inventory.stores || []).map(raw => {
    const id = Number(raw.id);
    if (configured.has(id)) return configured.get(id);
    const name = safeSheetName_(raw.name || ('店舗' + id));
    return { id, sourceSheet: name, stageSheet: '連携_' + name };
  });
}

function syncZaikonPriceMaster() {
  const ss = getZaikonSpreadsheet_();
  const inventory = fetchFirestoreInventory_();
  const sheet = getOrCreateSheet_(ss, ZAIKON_PRICE_SHEET);
  const pending = readPendingPriceChanges_(sheet);
  const storeNames = new Map((inventory.stores || []).map(store => [Number(store.id), store.name]));
  const rows = (inventory.allItems || []).filter(item => item.active !== false).map(item => {
    const saved = pending[String(item.id)] || {};
    return [
      Number(item.id), Number(item.storeId), storeNames.get(Number(item.storeId)) || ('店舗' + item.storeId),
      item.name || '', item.supplier || item.cat || '', Number(item.price) || 0,
      saved.newPrice === '' ? '' : saved.newPrice, saved.effectiveDate || '', saved.changedBy || '',
      saved.note || '', saved.status || ''
    ];
  });
  preparePriceMaster_(sheet);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, ZAIKON_PRICE_HEADERS.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, ZAIKON_PRICE_HEADERS.length).setValues(rows);
  sheet.getRange(2, 6, Math.max(rows.length, 1), 2).setNumberFormat('#,##0.##');
  sheet.getRange('A1').setNote('新価格・変更日・変更者を入力し、Zaikon連携メニューの「価格変更を確認・反映」を実行してください。過年度タブは変更しません。');
  ss.toast('価格マスターを更新しました。入力途中の新価格は保持しています。', 'Zaikon価格管理', 8);
}

function enableZaikonPriceAutoSync() {
  PropertiesService.getScriptProperties().setProperty(
    'ZAIKON_SPREADSHEET_ID',
    SpreadsheetApp.getActiveSpreadsheet().getId()
  );
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'syncZaikonPriceMaster')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('syncZaikonPriceMaster')
    .timeBased()
    .everyMinutes(5)
    .create();
  syncZaikonPriceMaster();
  SpreadsheetApp.getUi().alert(
    '価格マスターの自動更新を開始しました。\n\n' +
    'アプリで保存した価格は、操作なしで5分以内に価格マスターへ反映されます。\n' +
    '年次棚卸の連携シートと確定年度タブは自動更新しません。'
  );
}

function readPendingPriceChanges_(sheet) {
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < ZAIKON_PRICE_HEADERS.length) return {};
  const result = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, ZAIKON_PRICE_HEADERS.length).getValues().forEach(row => {
    const id = String(Number(row[0]) || '');
    if (!id) return;
    result[id] = {newPrice:row[6], effectiveDate:formatSheetDate_(row[7]), changedBy:String(row[8]||'').trim(), note:String(row[9]||''), status:String(row[10]||'')};
  });
  return result;
}

function formatSheetDate_(value) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value || '').trim();
}

function preparePriceMaster_(sheet) {
  if (sheet.getMaxColumns() < ZAIKON_PRICE_HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), ZAIKON_PRICE_HEADERS.length - sheet.getMaxColumns());
  sheet.setFrozenRows(1);
  [80,70,120,190,150,90,90,110,110,180,120].forEach((width,index)=>sheet.setColumnWidth(index+1,width));
  sheet.getRange('G2:J').setBackground('#FFF2B8').setFontColor('#111111');
  sheet.getRange('A:F').setBackground('#F3F3F3').setFontColor('#111111');
  sheet.getRange('K:K').setBackground('#EFEFEF');
  sheet.getRange(1, 1, 1, ZAIKON_PRICE_HEADERS.length).setValues([Array.from(ZAIKON_PRICE_HEADERS)]).setBackground('#111111').setFontColor('#FFFFFF').setFontWeight('bold');
}

function applyZaikonPriceChanges() {
  const ss = getZaikonSpreadsheet_();
  const sheet = ss.getSheetByName(ZAIKON_PRICE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('先に「価格マスターを更新」を実行してください。');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ZAIKON_PRICE_HEADERS.length).getValues();
  const changes = rows.map((row,index)=>({
    row:index+2,itemId:Number(row[0]),storeId:Number(row[1]),productName:String(row[3]||''),supplier:String(row[4]||'').trim(),
    currentPrice:Number(row[5]),newPrice:row[6]===''?null:Number(row[6]),effectiveDate:formatSheetDate_(row[7]),changedBy:String(row[8]||'').trim(),note:String(row[9]||'').trim()
  })).filter(change=>change.newPrice!==null && Number.isFinite(change.newPrice) && change.newPrice>=0 && change.newPrice!==change.currentPrice);
  if (!changes.length) {
    SpreadsheetApp.getUi().alert('反映する価格変更はありません。');
    return;
  }
  const invalid = changes.filter(change=>!change.itemId || !/^\d{4}-\d{2}-\d{2}$/.test(change.effectiveDate) || !change.changedBy);
  if (invalid.length) throw new Error('価格変更日または変更者が未入力です。行: ' + invalid.map(change=>change.row).join('、'));
  const preview = changes.slice(0,20).map(change=>change.productName+'：'+change.currentPrice+'円 → '+change.newPrice+'円').join('\n') + (changes.length>20?'\nほか '+(changes.length-20)+'件':'');
  const answer = SpreadsheetApp.getUi().alert('価格変更の最終確認', preview+'\n\n変更者・変更日とともに履歴へ保存し、棚卸の現在価格へ反映します。過年度タブは変更しません。', SpreadsheetApp.getUi().ButtonSet.YES_NO);
  if (answer !== SpreadsheetApp.getUi().Button.YES) return;
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('別の同期処理が実行中です。少し待って再実行してください。');
  try {
    const raw = fetchFirestoreDocumentRaw_();
    const inventory = decodeFirestoreFields_(raw.fields || {});
    const items = (inventory.allItems || []).map(item=>Object.assign({},item));
    const history = [];
    changes.forEach(change=>{
      const item = items.find(candidate=>Number(candidate.id)===change.itemId && Number(candidate.storeId)===change.storeId);
      if (!item) throw new Error('棚卸商品が見つかりません。行: '+change.row);
      const oldPrice = Number(item.price)||0;
      if (oldPrice !== change.currentPrice) throw new Error('アプリ側で価格が更新されています。価格マスターを更新してやり直してください。行: '+change.row);
      const baseline = Number.isFinite(Number(item.previousYearPrice)) ? Number(item.previousYearPrice) : oldPrice;
      item.price=change.newPrice;item.supplier=change.supplier||item.supplier||item.cat||'';item.previousYearPrice=baseline;
      item.priceChangedSinceLastYear=change.newPrice!==baseline;item.priceChangedAt=new Date().toISOString();item.priceChangedBy=change.changedBy;
      item.updatedAt=Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy/MM/dd HH:mm');
      history.push(Object.assign({},change,{oldPrice,newPrice:change.newPrice,inventoryYear:Number(inventory.inventoryYear)||null,createdAt:new Date().toISOString(),type:'price_change'}));
    });
    commitPriceChanges_(raw.updateTime, items, history);
    changes.forEach(change=>sheet.getRange(change.row,7,1,5).setValues([['','','','', '反映済み '+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy/MM/dd HH:mm')]]));
    SpreadsheetApp.flush();
    ss.toast(changes.length+'件の価格変更を反映しました。', 'Zaikon価格管理', 10);
    syncZaikonPriceMaster();
  } finally { lock.releaseLock(); }
}

function fetchFirestoreDocumentRaw_() {
  const url='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(ZAIKON_SYNC.projectId)+'/databases/(default)/documents/inventory/main';
  const response=UrlFetchApp.fetch(url,{method:'get',muteHttpExceptions:true,headers:{Accept:'application/json'}});
  if(response.getResponseCode()<200||response.getResponseCode()>=300)throw new Error('Firestoreの取得に失敗しました（HTTP '+response.getResponseCode()+'）');
  return JSON.parse(response.getContentText());
}

function encodeFirestoreValue_(value) {
  if (value === null || value === undefined) return {nullValue:null};
  if (Array.isArray(value)) return {arrayValue:{values:value.map(encodeFirestoreValue_)}};
  if (value instanceof Date) return {timestampValue:value.toISOString()};
  if (typeof value === 'boolean') return {booleanValue:value};
  if (typeof value === 'number') return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};
  if (typeof value === 'object') return {mapValue:{fields:encodeFirestoreFields_(value)}};
  return {stringValue:String(value)};
}

function encodeFirestoreFields_(object) {
  const fields={};Object.keys(object||{}).forEach(key=>{fields[key]=encodeFirestoreValue_(object[key]);});return fields;
}

function commitPriceChanges_(updateTime, items, history) {
  const base='projects/'+ZAIKON_SYNC.projectId+'/databases/(default)/documents/';
  const writes=[{update:{name:base+'inventory/main',fields:{allItems:encodeFirestoreValue_(items),updatedAt:{timestampValue:new Date().toISOString()}}},updateMask:{fieldPaths:['allItems','updatedAt']},currentDocument:{updateTime:updateTime}}];
  history.forEach((record,index)=>writes.push({update:{name:base+'inventoryPriceHistory/sheet_'+Date.now()+'_'+index,fields:encodeFirestoreFields_(record)}}));
  const url='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(ZAIKON_SYNC.projectId)+'/databases/(default)/documents:commit';
  const response=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify({writes}),muteHttpExceptions:true});
  if(response.getResponseCode()<200||response.getResponseCode()>=300)throw new Error('価格反映に失敗しました（HTTP '+response.getResponseCode()+'）: '+response.getContentText().slice(0,240));
}
