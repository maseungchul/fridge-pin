/**
 * @file
 * 등록·편집 초안의 검증·변환과 SQLite 저장을 실제 배치 모델과 함께 검사한다.
 * 네이티브 UUID·연결 인터페이스만 대체하고 SQL과 트랜잭션은 SQLite에서 실행한다.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { createSourceLoader } = require('./helpers/load-source.cjs');
const load = createSourceLoader({ expo: { uuid: { v4: randomUUID } } });
const model = load('src/features/fridge/model/fridgeLayout');
const { initializeDatabase } = load('src/db/initializeDatabase');
const { prepareRefrigeratorRegistration } = load('src/db/refrigeratorRegistration');
const { prepareIngredientRegistration } = load('src/db/ingredientRegistration');
const { getIngredients, getIngredientsByPosition, registerIngredient, subscribeToIngredientChanges,
  updateIngredient, consumeIngredients, deleteIngredients, moveIngredients, getConsumedIngredients,
  getConsumedIngredient, restoreConsumedIngredient, deleteConsumedIngredient, getUnassignedIngredients,
  assignIngredients } = load('src/db/ingredientRepository');
const { saveIngredientTag, getIngredientTagOptions } = load('src/db/ingredientTagRepository');
const { deleteRefrigerator, registerRefrigerator, updateRefrigerator, updateRefrigeratorName,
  getRefrigerator } = load('src/db/refrigeratorRepository');
const { addShoppingItem, getShoppingItems, setShoppingItemsPurchased,
  registerPurchasedIngredients } = load('src/db/shoppingRepository');
const prepare = draft => prepareRefrigeratorRegistration(draft, randomUUID);

function createConnectionAdapter(db) {
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 0;');
  return {
    async execAsync(sql) { db.exec(sql); },
    async getFirstAsync(sql, ...params) { return db.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, ...params) { return db.prepare(sql).all(...params); },
    async runAsync(sql, ...params) { return db.prepare(sql).run(...params); },
    async withTransactionAsync(task) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function createRepositoryDatabase(t, foreignKeys = false) {
  const databasePath = join(tmpdir(), `fridge-registration-${randomUUID()}.db`);
  const db = new DatabaseSync(databasePath);
  t.after(() => {
    db.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(databasePath + suffix, { force: true });
  });
  const adapter = createConnectionAdapter(db);
  // Expo와 같이 별도 연결을 열어 초기화 연결의 외래 키 설정이 공유되지 않는 상태를 재현한다.
  adapter.withExclusiveTransactionAsync = async task => {
    const connection = new DatabaseSync(databasePath);
    try {
      const transaction = createConnectionAdapter(connection);
      if (foreignKeys) connection.exec('PRAGMA foreign_keys = ON;');
      await transaction.withTransactionAsync(() => task(transaction));
    } finally {
      connection.close();
    }
  };
  await initializeDatabase(adapter);
  return { db, adapter, databasePath };
}

function readStoredData(db) {
  return Object.fromEntries([
    'refrigerators', 'refrigerator_rows', 'refrigerator_compartments', 'refrigerator_doors', 'refrigerator_slots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function createTwoDoorDraft() {
  const draft = model.createRefrigeratorDraft();
  return model.changeDraftDoorCount(draft, draft.rows[0].id, 1);
}

function createSlots(count, drawerCount = 0) {
  return Array.from({ length: count }, (_, index) => ({ name: model.getSlotName(index), drawerCount }));
}

test('구매 완료 품목의 일괄 등록은 실패하면 전체를 되돌리고 재시도하면 선택한 품목만 옮긴다', async t => {
  const { adapter } = await createRepositoryDatabase(t);
  const changes = [];
  t.after(subscribeToIngredientChanges(db => changes.push(db)));
  const draft = createTwoDoorDraft();
  draft.rows[0].compartments[0].slots[0].drawerCount = 2;
  await registerRefrigerator(adapter, draft);
  const refrigerator = await getRefrigerator(adapter);
  const position = { slotId: refrigerator.rows[0].compartments[0].slots[0].id, drawerNumber: 2 };
  const first = await addShoppingItem(adapter, { name: '우유', quantity: '1팩', memo: '무가당' });
  const second = await addShoppingItem(adapter, { name: '우유', quantity: '2팩', memo: null });
  const unselected = await addShoppingItem(adapter, { name: '계란', quantity: '1판', memo: null });
  const planned = await addShoppingItem(adapter, { name: '당근', quantity: '2개', memo: null });
  await setShoppingItemsPurchased(adapter, [first.id, second.id, unselected.id], true);
  const purchased = await getShoppingItems(adapter);
  const registrations = [first, second].map(({ id, quantity, memo }, index) => ({
    item: purchased.find(item => item.id === id),
    draft: { name: '저지방 우유', quantity, memo, expirationDate: index === 0 ? '2026-12-01' : null },
  }));
  const [firstRegistration, secondRegistration] = registrations;

  await assert.rejects(registerPurchasedIngredients(adapter, [firstRegistration, {
    ...secondRegistration, draft: { ...secondRegistration.draft, quantity: '1'.repeat(11) },
  }], position), { key: 'errors.ingredientQuantity' });
  assert.deepEqual(await getIngredients(adapter), []);
  assert.deepEqual(await getShoppingItems(adapter), purchased);

  await setShoppingItemsPurchased(adapter, [second.id], false);
  const afterUndo = await getShoppingItems(adapter);
  await assert.rejects(registerPurchasedIngredients(adapter, registrations, position), { key: 'shopping.importMissing' });
  assert.deepEqual(await getIngredients(adapter), []);
  assert.deepEqual(await getShoppingItems(adapter), afterUndo);
  assert.deepEqual(changes, []);

  await setShoppingItemsPurchased(adapter, [second.id], true);
  secondRegistration.item = (await getShoppingItems(adapter)).find(item => item.id === second.id);
  const registered = await registerPurchasedIngredients(adapter, registrations, position);
  assert.notEqual(registered[0].id, registered[1].id);
  assert.deepEqual(registered.map(({ id, ...ingredient }) => ingredient),
    registrations.map(({ draft }) => ({ ...draft, ...position })));
  assert.deepEqual((await getIngredientsByPosition(adapter, position)).map(item => ({ ...item })), registered);
  assert.deepEqual((await getShoppingItems(adapter)).map(item => item.id), [unselected.id, planned.id]);
  await assert.rejects(registerPurchasedIngredients(adapter, registrations, position), { key: 'shopping.importMissing' });
  assert.equal((await getIngredients(adapter)).length, 2);
  assert.deepEqual(changes, [adapter]);
});

test('재료 목록은 칸·좌우·포켓을 구분하고 유통기한·이름 순서로 조회한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  assert.deepEqual(await getIngredients(adapter), []);
  const draft = createTwoDoorDraft();
  draft.rows[0].compartments[0].slots[0].drawerCount = 2;
  await registerRefrigerator(adapter, draft);
  const refrigerator = await getRefrigerator(adapter);
  const bodySlotId = refrigerator.rows[0].compartments[0].slots[0].id;
  const pocketSlotId = refrigerator.rows[0].doors[0].slots[0].id;
  const otherSlotId = refrigerator.rows[1].compartments[0].slots[0].id;
  const insert = db.prepare('INSERT INTO ingredients (id, name, quantity, expiration_date, slot_id, drawer_number) VALUES (?, ?, ?, ?, ?, ?)');
  for (const item of [
    ['no-date', '감자', '반 통', null, bodySlotId, 1],
    ['later', '감자', '2개', '2026-12-01', bodySlotId, 1],
    ['same-name-b', '감자', '500g', '2026-11-30', bodySlotId, 1],
    ['same-name-a', '감자', '1봉', '2026-11-30', bodySlotId, 1],
    ['same-date', '당근', '1개', '2026-11-30', bodySlotId, 1],
    ['right', '오른쪽 재료', '1개', null, bodySlotId, 2],
    ['pocket', '문 재료', '1병', null, pocketSlotId, 0],
    ['other', '다른 칸 재료', '1개', null, otherSlotId, 0],
  ]) insert.run(...item);
  const before = db.prepare('SELECT * FROM ingredients ORDER BY id').all();
  const left = await getIngredientsByPosition(adapter, { slotId: bodySlotId, drawerNumber: 1 });
  assert.deepEqual(left.map(item => item.id), ['same-name-a', 'same-name-b', 'same-date', 'later', 'no-date']);
  assert.deepEqual({ ...left[0] }, { id: 'same-name-a', name: '감자', quantity: '1봉', memo: null, expirationDate: '2026-11-30', slotId: bodySlotId, drawerNumber: 1 });
  assert.equal(left.at(-1).expirationDate, null);
  for (const [slotId, drawerNumber, expected] of [
    [bodySlotId, 2, 'right'], [pocketSlotId, 0, 'pocket'], [otherSlotId, 0, 'other'],
  ]) assert.deepEqual((await getIngredientsByPosition(adapter, { slotId, drawerNumber })).map(item => item.id), [expected]);
  assert.deepEqual(await getIngredientsByPosition(adapter, { slotId: 'missing', drawerNumber: 0 }), []);
  assert.deepEqual(await getIngredientsByPosition(adapter, { slotId: "' OR 1 = 1 --", drawerNumber: 0 }), []);
  assert.deepEqual(await getIngredientsByPosition(adapter, { slotId: refrigerator.rows[0].doors[0].slots[1].id, drawerNumber: 0 }), []);
  const ingredients = await getIngredients(adapter);
  const layout = model.getDraftLayout(refrigerator, ingredients);
  assert.equal(ingredients.length, 8);
  assert.equal(layout.ingredients.length, ingredients.length);
  for (const [positionId, count] of [[`${bodySlotId}-left`, 5], [`${bodySlotId}-right`, 1], [pocketSlotId, 1], [otherSlotId, 1]]) {
    assert.equal(layout.ingredients.filter(ingredient => ingredient.positionId === positionId).length, count);
  }
  assert.deepEqual(db.prepare('SELECT * FROM ingredients ORDER BY id').all(), before);
});

test('재료 등록 입력은 공백을 정리하고 잘못된 이름·수량·날짜·위치를 저장 전에 거부한다', () => {
  const input = { name: '  계란  ', quantity: '  2개  ', memo: '  개봉 후 밀폐 보관  ', expirationDate: ' 2028-02-29 ', slotId: 'slot', drawerNumber: 1 };
  const before = structuredClone(input);
  let issuedIds = 0;
  const prepare = value => prepareIngredientRegistration(value, () => `id-${++issuedIds}`);
  assert.deepEqual(prepare(input), { id: 'id-1', name: '계란', quantity: '2개', memo: '개봉 후 밀폐 보관', expirationDate: '2028-02-29', slotId: 'slot', drawerNumber: 1 });
  assert.deepEqual(input, before);
  assert.equal(prepare({ ...input, expirationDate: '   ' }).expirationDate, null);
  for (const memo of [null, '', ' \n\t ']) assert.equal(prepare({ ...input, memo }).memo, null);
  const invalid = [
    ...['', ' \n\t ', '가'.repeat(21)].map(name => ({ ...input, name })),
    ...['', ' \n\t ', '가'.repeat(11)].map(quantity => ({ ...input, quantity })),
    ...['2026-02-29', '2026-04-31', '2026-00-01', '2026-01-00', '2026-13-01', '2026-1-01', '날짜 아님',
      '2026-11-04T00:00:00Z'].map(expirationDate => ({ ...input, expirationDate })),
    { ...input, slotId: ' ' }, { ...input, drawerNumber: 3 }, { ...input, drawerNumber: 1.5 },
  ];
  for (const value of invalid) assert.throws(() => prepare(value), /재료명|수량|유통기한|위치/);
  assert.equal(issuedIds, 5);
  assert.equal(prepare({ ...input, name: '가'.repeat(20), quantity: '1'.repeat(10) }).name.length, 20);
});

test('기존 제한보다 긴 재료명과 수량은 수정하지 않은 경우에만 유지한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  await registerRefrigerator(adapter, model.createRefrigeratorDraft());
  const refrigerator = await getRefrigerator(adapter);
  const original = await registerIngredient(adapter, { name: '계란', quantity: '2개', memo: null,
    expirationDate: null, slotId: refrigerator.rows[0].compartments[0].slots[0].id, drawerNumber: 0 });
  const name = '가'.repeat(21);
  const quantity = '1'.repeat(11);
  db.prepare('UPDATE ingredients SET name = ?, quantity = ? WHERE id = ?').run(name, quantity, original.id);
  const legacy = { ...original, name, quantity };
  assert.equal((await updateIngredient(adapter, { ...legacy, memo: '메모' })).memo, '메모');
  await assert.rejects(updateIngredient(adapter, { ...legacy, name: `${name}나` }), /재료명/);
  await assert.rejects(updateIngredient(adapter, { ...legacy, quantity: `${quantity}2` }), /수량/);
});

test('수동 등록 재료는 선택한 좌우·포켓에 저장되고 파일 DB를 다시 열어도 유지한다', async t => {
  const { db, adapter, databasePath } = await createRepositoryDatabase(t);
  const draft = createTwoDoorDraft();
  draft.rows[0].compartments[0].slots[0].drawerCount = 2;
  await registerRefrigerator(adapter, draft);
  const refrigerator = await getRefrigerator(adapter);
  const slotId = refrigerator.rows[0].compartments[0].slots[0].id;
  const pocketId = refrigerator.rows[0].doors[0].slots[0].id;
  const stored = [];
  for (const [target, drawerNumber, expirationDate, memo] of [
    [slotId, 1, '2028-02-29', '  개봉 후 밀폐 보관  '], [slotId, 2, null, '   '], [pocketId, 0, null, null],
  ]) {
    const ingredient = await registerIngredient(adapter, { name: '  같은 재료  ', quantity: '  반 통  ', memo, expirationDate, slotId: target, drawerNumber });
    assert.match(ingredient.id, /^[0-9a-f-]{36}$/);
    assert.equal(ingredient.name, '같은 재료');
    assert.equal(ingredient.quantity, '반 통');
    assert.equal(ingredient.memo, memo?.trim() || null);
    assert.equal(ingredient.expirationDate, expirationDate);
    assert.deepEqual({ ...(await getIngredientsByPosition(adapter, { slotId: target, drawerNumber }))[0] }, ingredient);
    stored.push(ingredient.id);
  }
  assert.equal(new Set(stored).size, 3);
  const reopened = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(reopened.prepare('SELECT * FROM ingredients ORDER BY id').all(), db.prepare('SELECT * FROM ingredients ORDER BY id').all());
    assert.deepEqual(await getIngredients(createConnectionAdapter(reopened)), await getIngredients(adapter));
  } finally { reopened.close(); }
});

test('재료 수정의 잘못된 입력·없는 ID·달라진 위치는 기존 재료를 보존한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  await registerRefrigerator(adapter, createTwoDoorDraft());
  const refrigerator = await getRefrigerator(adapter);
  const slotId = refrigerator.rows[0].compartments[0].slots[0].id;
  const original = await registerIngredient(adapter, { name: '계란', quantity: '2개', memo: null,
    expirationDate: null, slotId, drawerNumber: 0 });
  const before = db.prepare('SELECT * FROM ingredients').all();
  for (const input of [
    { ...original, name: '' }, { ...original, quantity: ' ' }, { ...original, expirationDate: '2026-02-29' },
    { ...original, id: 'missing' }, { ...original, drawerNumber: 1 },
    { ...original, slotId: refrigerator.rows[1].compartments[0].slots[0].id },
  ]) {
    await assert.rejects(updateIngredient(adapter, input), /재료명|수량|유통기한|수정할 재료/);
    assert.deepEqual(db.prepare('SELECT * FROM ingredients').all(), before);
  }
});

test('여러 칸의 같은 이름 재료를 합치지 않고 최신 정보로 일괄 이동하며 현재 칸의 재료는 유지한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  const draft = createTwoDoorDraft();
  draft.rows[0].compartments[0].slots[0].drawerCount = 2;
  await registerRefrigerator(adapter, draft);
  const refrigerator = await getRefrigerator(adapter);
  const slotId = refrigerator.rows[0].compartments[0].slots[0].id;
  const destination = { slotId: refrigerator.rows[1].compartments[0].slots[0].id, drawerNumber: 0 };
  const left = await registerIngredient(adapter, { name: '우유', quantity: '1팩', memo: null,
    expirationDate: '2026-11-10', slotId, drawerNumber: 1 });
  const right = await registerIngredient(adapter, { ...left, quantity: '2팩', expirationDate: '2026-11-15', drawerNumber: 2 });
  const pocket = await registerIngredient(adapter, { ...left, slotId: refrigerator.rows[0].doors[0].slots[0].id, drawerNumber: 0 });
  const alreadyThere = await registerIngredient(adapter, { ...left, ...destination });
  const untouched = await registerIngredient(adapter, { ...left, name: '계란' });
  const latest = await updateIngredient(adapter, { ...left, quantity: '반 팩', memo: '개봉함' });
  const structure = readStoredData(db);
  const moved = await moveIngredients(adapter, [left, right, pocket, alreadyThere, left], destination);
  assert.deepEqual(moved, [latest, right, pocket].map(item => ({ ...item, ...destination })));
  const stored = await getIngredients(adapter);
  assert.equal(stored.length, 5);
  assert.deepEqual({ ...stored.find(item => item.id === alreadyThere.id) }, alreadyThere);
  assert.deepEqual({ ...stored.find(item => item.id === untouched.id) }, untouched);
  assert.deepEqual((await getIngredientsByPosition(adapter, destination)).map(item => item.id).sort(),
    [left, right, pocket, alreadyThere].map(item => item.id).sort());
  assert.deepEqual(readStoredData(db), structure);
  assert.deepEqual(await moveIngredients(adapter, moved, destination), []);
  assert.deepEqual(await moveIngredients(adapter, [], destination), []);
});

test('두 번째 재료 이동이 실패하면 앞서 이동한 재료까지 롤백하고 재시도한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  await registerRefrigerator(adapter, model.createRefrigeratorDraft());
  const refrigerator = await getRefrigerator(adapter);
  const first = await registerIngredient(adapter, { name: '우유', quantity: '1팩', memo: null,
    expirationDate: null, slotId: refrigerator.rows[0].compartments[0].slots[0].id, drawerNumber: 0 });
  const second = await registerIngredient(adapter, { ...first, slotId: refrigerator.rows[0].doors[0].slots[0].id });
  const destination = { slotId: refrigerator.rows[1].compartments[0].slots[0].id, drawerNumber: 0 };
  const before = db.prepare('SELECT * FROM ingredients ORDER BY id').all();
  db.exec(`CREATE TRIGGER fail_second_move BEFORE UPDATE OF slot_id, drawer_number ON ingredients
    WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, '두 번째 재료 실패'); END;`);
  await assert.rejects(moveIngredients(adapter, [first, second], destination), /두 번째 재료 실패/);
  assert.deepEqual(db.prepare('SELECT * FROM ingredients ORDER BY id').all(), before);
  db.exec('DROP TRIGGER fail_second_move');
  assert.deepEqual(await moveIngredients(adapter, [first, second], destination), [first, second].map(item => ({ ...item, ...destination })));
});

async function createConsumableIngredient(t, foreignKeys = false) {
  const fixture = await createRepositoryDatabase(t, foreignKeys);
  const draft = model.createRefrigeratorDraft();
  draft.rows[0].compartments[0].slots[0].drawerCount = 2;
  await registerRefrigerator(fixture.adapter, draft);
  const refrigerator = await getRefrigerator(fixture.adapter);
  const ingredient = await registerIngredient(fixture.adapter, { name: '우유', quantity: '1팩', memo: '개봉함',
    expirationDate: '2026-11-30', slotId: refrigerator.rows[0].compartments[0].slots[0].id, drawerNumber: 1 });
  const destination = { slotId: refrigerator.rows[1].compartments[0].slots[0].id, drawerNumber: 0 };
  return { ...fixture, refrigerator, ingredient, destination };
}

for (const foreignKeys of [false, true]) {
  test(`냉장고 전체 삭제는 전용 연결 외래 키 ${foreignKeys ? '켜짐' : '꺼짐'}에서 재료와 구조만 함께 제거한다`, async t => {
    const { db, adapter, refrigerator, ingredient, destination } = await createConsumableIngredient(t, foreignKeys);
    await consumeIngredients(adapter, [ingredient]);
    await registerIngredient(adapter, { ...ingredient, name: '달걀' });
    await registerIngredient(adapter, { ...ingredient, ...destination, name: '사과' });
    const stored = await getIngredients(adapter);
    const records = await getConsumedIngredients(adapter);
    const shopping = await getShoppingItems(adapter);
    const changes = [];
    t.after(subscribeToIngredientChanges(changedDb => changes.push(changedDb)));

    await assert.rejects(deleteRefrigerator(adapter, '다른 냉장고'), /삭제할 냉장고/);
    db.exec(`CREATE TRIGGER reject_fridge_delete BEFORE DELETE ON refrigerators
      BEGIN SELECT RAISE(ABORT, '삭제 실패'); END;`);
    await assert.rejects(deleteRefrigerator(adapter, refrigerator.id), /삭제 실패/);
    assert.deepEqual(await getIngredients(adapter), stored);
    assert.deepEqual(await getRefrigerator(adapter), refrigerator);
    assert.deepEqual(changes, []);

    db.exec('DROP TRIGGER reject_fridge_delete;');
    await deleteRefrigerator(adapter, refrigerator.id);
    assert.deepEqual(await getIngredients(adapter), []);
    assert(Object.values(readStoredData(db)).every(rows => rows.length === 0));
    assert.deepEqual(await getConsumedIngredients(adapter), records);
    assert.deepEqual(await getShoppingItems(adapter), shopping);
    assert.deepEqual(changes, [adapter]);
    assert.notEqual(await registerRefrigerator(adapter, model.createRefrigeratorDraft()), refrigerator.id);
  });
}

for (const kind of ['delete', 'consume']) {
  test(`다중 ${kind}는 ID가 같은 선택을 중복 처리하지 않고 같은 이름의 각 재료를 유지한다`, async t => {
    const { adapter, ingredient } = await createConsumableIngredient(t);
    const other = await registerIngredient(adapter, { ...ingredient, quantity: '2팩' });
    const untouched = await registerIngredient(adapter, { ...ingredient, quantity: '3팩' });
    const action = kind === 'delete' ? deleteIngredients : consumeIngredients;
    await action(adapter, []);
    await action(adapter, [ingredient, other, ingredient]);
    assert.deepEqual((await getIngredients(adapter)).map(item => item.id), [untouched.id]);
    const records = await getConsumedIngredients(adapter);
    if (kind === 'consume') {
      assert.deepEqual(records.map(item => item.id).sort(), [ingredient.id, other.id].sort());
      assert.equal(records[0].consumedAt, records[1].consumedAt);
      assert.deepEqual(records.map(item => item.quantity).sort(), ['1팩', '2팩']);
    } else assert.deepEqual(records, []);
  });

  test(`다중 ${kind}의 두 번째 대상이 없거나 위치가 달라지면 앞선 처리도 롤백한다`, async t => {
    const { adapter, ingredient, destination } = await createConsumableIngredient(t);
    const other = await registerIngredient(adapter, { ...ingredient });
    const before = await getIngredients(adapter);
    const action = kind === 'delete' ? deleteIngredients : consumeIngredients;
    for (const stale of [{ ...other, id: 'missing' }, { ...other, ...destination }]) {
      await assert.rejects(action(adapter, [ingredient, stale]));
      assert.deepEqual(await getIngredients(adapter), before);
      assert.deepEqual(await getConsumedIngredients(adapter), []);
    }
  });

  test(`다중 ${kind}의 두 번째 저장 실패는 전체를 보존하고 같은 선택으로 재시도한다`, async t => {
    const { db, adapter, ingredient } = await createConsumableIngredient(t);
    const other = await registerIngredient(adapter, { ...ingredient });
    const before = await getIngredients(adapter);
    const action = kind === 'delete' ? deleteIngredients : consumeIngredients;
    db.exec(`CREATE TRIGGER fail_second_selection BEFORE DELETE ON ingredients WHEN OLD.id = '${other.id}'
      BEGIN SELECT RAISE(ABORT, '두 번째 선택 처리 실패'); END;`);
    await assert.rejects(action(adapter, [ingredient, other]), /두 번째 선택 처리 실패/);
    assert.deepEqual(await getIngredients(adapter), before);
    assert.deepEqual(await getConsumedIngredients(adapter), []);
    assert.deepEqual(db.prepare('SELECT * FROM shopping_items').all(), []);
    db.exec('DROP TRIGGER fail_second_selection');
    await action(adapter, [ingredient, other]);
    assert.deepEqual(await getIngredients(adapter), []);
    assert.equal((await getConsumedIngredients(adapter)).length, kind === 'consume' ? 2 : 0);
  });
}

test('소비 완료는 최신 정보·ID·원래 위치를 보존하고 활성 재료·배지에서 제외하며 재실행해도 남는다', async t => {
  const { db, adapter, databasePath, ingredient } = await createConsumableIngredient(t);
  const latest = await updateIngredient(adapter, { ...ingredient, quantity: '반 팩', memo: '오늘 개봉', expirationDate: null });
  const sameName = await registerIngredient(adapter, { ...ingredient, quantity: '2팩' });
  await consumeIngredients(adapter, [ingredient]);
  const [record] = await getConsumedIngredients(adapter);
  assert.deepEqual({ ...record, consumedAt: undefined }, { ...latest, consumedAt: undefined });
  assert(Number.isFinite(Date.parse(record.consumedAt)));
  assert.deepEqual((await getIngredients(adapter)).map(item => item.id), [sameName.id]);
  const refrigerator = await getRefrigerator(adapter);
  assert.equal(model.getDraftLayout(refrigerator, await getIngredients(adapter)).ingredients.length, 1);
  assert.deepEqual(await getConsumedIngredient(adapter, record), record);
  await initializeDatabase(adapter);
  const reopened = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(await getConsumedIngredients(createConnectionAdapter(reopened)), [record]);
    assert.deepEqual(await getIngredients(createConnectionAdapter(reopened)), await getIngredients(adapter));
  } finally { reopened.close(); }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('소비 완료는 구매 예정 품목과 이름이 겹치면 건너뛰고 새 품목은 이름당 한 번 추가한다', async t => {
  const { db, adapter, ingredient } = await createConsumableIngredient(t);
  const insert = db.prepare('INSERT INTO shopping_items (id, name, quantity, created_at, purchased_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('planned', ingredient.name, '3팩', '2026-11-19', null);
  insert.run('purchased', '달걀', '2개', '2026-11-19', '2026-11-20');
  const eggs = await registerIngredient(adapter, { ...ingredient, name: '달걀', quantity: '6개' });
  const sameName = await registerIngredient(adapter, { ...eggs, quantity: '10개' });

  assert.equal(await consumeIngredients(adapter, [ingredient, eggs, sameName]), true);
  assert.equal((await getConsumedIngredients(adapter)).length, 3);
  const planned = db.prepare('SELECT name, quantity, memo FROM shopping_items WHERE purchased_at IS NULL ORDER BY rowid').all();
  assert.deepEqual(planned.map(row => ({ ...row })), [
    { name: ingredient.name, quantity: '3팩', memo: null },
    { name: '달걀', quantity: '6개', memo: null },
  ]);
});

test('원래 위치 복구는 ID·수량·메모·유통기한을 유지하고 완료 기록을 제거하며 다시 소비할 수 있다', async t => {
  const { adapter, ingredient } = await createConsumableIngredient(t);
  await consumeIngredients(adapter, [ingredient]);
  const [record] = await getConsumedIngredients(adapter);
  assert.deepEqual(await restoreConsumedIngredient(adapter, record), ingredient);
  assert.deepEqual((await getIngredients(adapter)).map(item => ({ ...item })), [ingredient]);
  assert.deepEqual(await getConsumedIngredients(adapter), []);
  await assert.rejects(restoreConsumedIngredient(adapter, record), /이미 복구하거나 삭제/);
  await consumeIngredients(adapter, [ingredient]);
  assert.equal((await getConsumedIngredients(adapter))[0].id, ingredient.id);
});

for (const change of ['칸 삭제', '좌우 분할 해제', '문 수납 끄기', '서랍형 포켓 숨김', '냉장고 삭제']) {
  test(`소비 후 ${change} 시 완료 기록을 유지하고 새 위치로만 복구한다`, async t => {
    const { db, adapter, ingredient, refrigerator, destination } = await createConsumableIngredient(t);
    const pocket = change === '문 수납 끄기' || change === '서랍형 포켓 숨김';
    const target = pocket ? await registerIngredient(adapter, { ...ingredient,
      slotId: refrigerator.rows[0].doors[0].slots[0].id, drawerNumber: 0 }) : ingredient;
    if (pocket) await deleteIngredients(adapter, [ingredient]);
    await consumeIngredients(adapter, [target]);
    const [record] = await getConsumedIngredients(adapter);
    if (change === '칸 삭제') db.prepare('DELETE FROM refrigerator_slots WHERE id = ?').run(target.slotId);
    if (change === '좌우 분할 해제') db.prepare('UPDATE refrigerator_slots SET drawer_count = 0 WHERE id = ?').run(target.slotId);
    if (change === '문 수납 끄기') db.prepare('UPDATE refrigerator_doors SET storage_enabled = 0 WHERE id = ?').run(refrigerator.rows[0].doors[0].id);
    if (change === '서랍형 포켓 숨김') db.prepare("UPDATE refrigerator_compartments SET kind = 'DRAWER', side = NULL WHERE id = ?").run(refrigerator.rows[0].compartments[0].id);
    if (change === '냉장고 삭제') db.exec('DELETE FROM refrigerators');
    assert.equal(await restoreConsumedIngredient(adapter, record), null);
    assert.deepEqual(await getConsumedIngredients(adapter), [record]);
    await assert.rejects(restoreConsumedIngredient(adapter, record, { slotId: target.slotId, drawerNumber: target.drawerNumber }), /보관할 수 없는 위치/);
    assert.deepEqual(await getIngredients(adapter), []);
    if (change === '냉장고 삭제') {
      await registerRefrigerator(adapter, model.createRefrigeratorDraft());
      const fresh = await getRefrigerator(adapter);
      destination.slotId = fresh.rows[0].compartments[0].slots[0].id;
    }
    assert.deepEqual(await restoreConsumedIngredient(adapter, record, destination), { ...target, ...destination });
    assert.deepEqual(await getConsumedIngredients(adapter), []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

for (const [operation, table] of [['INSERT', 'ingredients'], ['DELETE', 'consumed_ingredients']]) {
  test(`복구 중 ${table} ${operation} 실패는 완료 기록을 유지하고 활성 재료를 남기지 않는다`, async t => {
    const { db, adapter, ingredient } = await createConsumableIngredient(t);
    await consumeIngredients(adapter, [ingredient]);
    const [record] = await getConsumedIngredients(adapter);
    db.exec(`CREATE TRIGGER fail_restore BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, '복구 저장 실패'); END;`);
    await assert.rejects(restoreConsumedIngredient(adapter, record), /복구 저장 실패/);
    assert.deepEqual(await getIngredients(adapter), []);
    assert.deepEqual(await getConsumedIngredients(adapter), [record]);
    db.exec('DROP TRIGGER fail_restore');
    assert.deepEqual(await restoreConsumedIngredient(adapter, record), ingredient);
  });
}

test('소비 완료 영구 삭제는 해당 기록만 지우고 중복·이전 완료 시점 요청을 거부한다', async t => {
  const { db, adapter, ingredient } = await createConsumableIngredient(t);
  await consumeIngredients(adapter, [ingredient]);
  const [record] = await getConsumedIngredients(adapter);
  const another = await registerIngredient(adapter, { ...ingredient, name: '계란' });
  await consumeIngredients(adapter, [another]);
  db.prepare('UPDATE consumed_ingredients SET consumed_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', another.id);
  assert.deepEqual((await getConsumedIngredients(adapter)).map(item => item.id), [record.id, another.id]);
  const stale = { ...record, consumedAt: '2000-01-01T00:00:00.000Z' };
  await assert.rejects(deleteConsumedIngredient(adapter, stale), /이미 복구하거나 삭제/);
  await assert.rejects(restoreConsumedIngredient(adapter, stale), /이미 복구하거나 삭제/);
  db.exec(`CREATE TRIGGER fail_consumed_delete BEFORE DELETE ON consumed_ingredients
    BEGIN SELECT RAISE(ABORT, '완료 기록 삭제 실패'); END;`);
  await assert.rejects(deleteConsumedIngredient(adapter, record), /완료 기록 삭제 실패/);
  assert.equal((await getConsumedIngredients(adapter)).length, 2);
  db.exec('DROP TRIGGER fail_consumed_delete');
  await deleteConsumedIngredient(adapter, record);
  await assert.rejects(deleteConsumedIngredient(adapter, record), /이미 복구하거나 삭제/);
  assert.deepEqual((await getConsumedIngredients(adapter)).map(item => item.id), [another.id]);
  assert.deepEqual(await getIngredients(adapter), []);
});

test('이름 공백을 제거하고 임시 ID를 UUID로 바꾸며 입력 초안을 유지한다', () => {
  const draft = model.createRefrigeratorDraft();
  draft.name = '  우리 집 냉장고  ';
  const before = structuredClone(draft);
  const data = prepare(draft);
  assert.equal(data.refrigerator.name, '우리 집 냉장고');
  assert.deepEqual(data.rows.map(row => row.sort_order), [0, 1]);
  assert.equal(data.compartments.length, 2);
  assert.equal(data.doors.length, 2);
  assert.equal(data.slots.length, 6);
  for (const row of data.rows) assert.equal(row.refrigerator_id, data.refrigerator.id);
  for (const body of data.compartments) assert(data.rows.some(row => row.id === body.row_id));
  for (const door of data.doors) {
    assert(data.compartments.some(body => body.id === door.compartment_id && body.row_id === door.row_id));
    assert.equal('kind' in door || 'side' in door, false);
  }
  for (const slot of data.slots) {
    assert.notEqual(slot.compartment_id === null, slot.door_id === null);
    assert.equal('name' in slot || 'area_id' in slot, false);
    if (slot.compartment_id !== null) assert(data.compartments.some(body => body.id === slot.compartment_id));
    if (slot.door_id !== null) assert(data.doors.some(door => door.id === slot.door_id));
  }
  const ids = [data.refrigerator, ...data.rows, ...data.compartments, ...data.doors, ...data.slots].map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal('nextId' in data, false);
  assert.deepEqual(draft, before);
});

test('서랍형은 본체에 기록하고 문 방향을 NULL로 바꾸면서 숨긴 포켓 입력을 보존한다', () => {
  const original = model.createRefrigeratorDraft();
  original.rows[0].doors[0].side = 'RIGHT_DOOR';
  const draft = model.setDraftDoorOpening(original, original.rows[0].id, original.rows[0].doors[0].id, 'DRAWER');
  const before = structuredClone(draft);
  const data = prepare(draft);
  assert.equal(data.compartments[0].kind, 'DRAWER');
  assert.equal(data.compartments[0].side, null);
  assert.equal(data.doors[0].storage_enabled, 1);
  assert.equal(data.slots.filter(slot => slot.door_id === data.doors[0].id).length, 2);
  assert.deepEqual(data.slots.filter(slot => slot.compartment_id === data.compartments[0].id).map(slot => slot.drawer_count), [0]);
  assert.deepEqual(draft, before);
});

test('잘못된 이름·개수·설정·식별자를 거부하고 초안을 변경하지 않는다', () => {
  const cases = [
    ['빈 이름', draft => { draft.name = '  '; }, /이름/],
    ['긴 이름', draft => { draft.name = '가'.repeat(51); }, /이름/],
    ['단 없음', draft => { draft.rows = []; }, /단으로/],
    ['단 초과', draft => { draft.rows = Array(5).fill(draft.rows[0]); }, /단으로/],
    ['문 없음', draft => { draft.rows[0].doors = []; }, /문은/],
    ['문 초과', draft => { draft.rows[0].doors.push(draft.rows[0].doors[0]); }, /문은/],
    ['본체 없음', draft => { draft.rows[0].compartments = []; }, /본체 연결/],
    ['본체 초과', draft => { draft.rows[0].compartments.push(draft.rows[0].compartments[0]); }, /본체 연결/],
    ['본체 칸 없음', draft => { draft.rows[0].compartments[0].slots = []; }, /칸은/],
    ['본체 칸 초과', draft => { draft.rows[0].compartments[0].slots = createSlots(5); }, /칸은/],
    ['포켓 칸 없음', draft => { draft.rows[0].doors[0].slots = []; }, /칸은/],
    ['포켓 칸 초과', draft => { draft.rows[0].doors[0].slots = createSlots(4); }, /칸은/],
    ['보관 모드 미선택', draft => { draft.rows[0].compartments[0].storageMode = null; }, /냉장·냉동/],
    ['잘못된 보관 모드', draft => { draft.rows[0].compartments[0].storageMode = 'INVALID'; }, /냉장·냉동/],
    ['잘못된 문 형태', draft => { draft.rows[0].doors[0].kind = 'INVALID'; }, /여는 방식/],
    ['잘못된 문 방향', draft => { draft.rows[0].doors[0].side = 'INVALID'; }, /여는 방식/],
    ['잘못된 문 수납 값', draft => { draft.rows[0].doors[0].storageEnabled = 1; }, /수납 사용/],
    ['잘못된 분할 값', draft => { draft.rows[0].compartments[0].slots[0].drawerCount = 3; }, /좌우 분할/],
    ['포켓 좌우 분할', draft => { draft.rows[0].doors[0].slots[0].drawerCount = 2; }, /분할할 수 없/],
    ['숨긴 포켓 좌우 분할', draft => {
      draft.rows[0].doors[0].storageEnabled = false;
      draft.rows[0].doors[0].slots[0].drawerCount = 2;
    }, /분할할 수 없/],
    ['빈 식별자', draft => { draft.rows[0].id = ''; }, /식별자/],
    ['중복 식별자', draft => { draft.rows[0].compartments[0].id = draft.rows[0].doors[0].id; }, /식별자/],
    ['다른 단과 식별자 중복', draft => { draft.rows[1].doors[0].id = draft.rows[0].doors[0].id; }, /식별자/],
  ];
  for (const [label, mutate, message] of cases) {
    const draft = createTwoDoorDraft();
    mutate(draft);
    const before = structuredClone(draft);
    assert.throws(() => prepare(draft), message, label);
    assert.deepEqual(draft, before, label);
  }
});

test('중복·누락·다른 단 참조·순서 불일치가 있는 본체 연결을 거부한다', () => {
  const cases = [
    draft => { draft.rows[0].compartments[0].doorIds = []; },
    draft => { draft.rows[0].compartments[0].doorIds = ['unknown']; },
    draft => { draft.rows[0].compartments[1].doorIds = [...draft.rows[0].compartments[0].doorIds]; },
    draft => { draft.rows[0].compartments.pop(); },
    draft => { draft.rows[0].compartments[0].doorIds = [draft.rows[1].doors[0].id]; },
    draft => { draft.rows[0].compartments.reverse(); },
  ];
  for (const mutate of cases) {
    const draft = createTwoDoorDraft();
    mutate(draft);
    assert.throws(() => prepare(draft), /본체/);
  }
});

test('공용 본체의 잘못된 문 형태·방향과 서로 다른 보관 모드의 합치기를 거부한다', () => {
  for (const mutate of [
    draft => { draft.rows[0].doors[0].kind = 'DRAWER'; },
    draft => { draft.rows[0].doors[1].side = 'LEFT_DOOR'; },
    draft => { draft.rows[0].compartments[0].doorIds.reverse(); },
  ]) {
    let draft = createTwoDoorDraft();
    draft = model.mergeDraftCompartments(draft, draft.rows[0].id, draft.rows[0].compartments[0].id);
    mutate(draft);
    assert.throws(() => prepare(draft), /공용 본체|연결 순서/);
  }
  let draft = createTwoDoorDraft();
  draft.rows[0].compartments[1].storageMode = 'FROZEN';
  draft = model.mergeDraftCompartments(draft, draft.rows[0].id, draft.rows[0].compartments[0].id);
  assert.throws(() => prepare(draft), /냉장·냉동/);
});

test('공용 본체·서랍형·좌우 분할과 숨긴 포켓 칸을 연결된 상태로 저장한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  let draft = createTwoDoorDraft();
  draft.rows[0].doors[1].storageEnabled = false;
  draft.rows[0].doors[1].slots = createSlots(3);
  draft = model.mergeDraftCompartments(draft, draft.rows[0].id, draft.rows[0].compartments[0].id);
  draft.rows[0].compartments[0].slots = createSlots(4, 2);
  draft = model.setDraftDoorOpening(draft, draft.rows[1].id, draft.rows[1].doors[0].id, 'DRAWER');
  draft.rows[1].compartments[0].storageMode = 'FROZEN';
  await registerRefrigerator(adapter, draft);
  const bodies = db.prepare(`
    SELECT body.* FROM refrigerator_compartments AS body
    JOIN refrigerator_rows AS row ON row.id = body.row_id ORDER BY row.sort_order
  `).all();
  assert.equal(bodies[0].kind, 'HINGED');
  assert.equal(bodies[0].side, null);
  assert.equal(bodies[1].kind, 'DRAWER');
  assert.equal(bodies[1].side, null);
  assert.equal(bodies[1].storage_mode, 'FROZEN');
  const doors = db.prepare('SELECT * FROM refrigerator_doors WHERE compartment_id = ? ORDER BY sort_order').all(bodies[0].id);
  assert.deepEqual(doors.map(door => door.sort_order), [0, 1]);
  assert.equal(doors[1].storage_enabled, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM refrigerator_slots WHERE door_id = ?').get(doors[1].id).count, 3);
  assert.deepEqual(
    db.prepare('SELECT drawer_count FROM refrigerator_slots WHERE compartment_id = ? ORDER BY sort_order').all(bodies[0].id)
      .map(slot => slot.drawer_count),
    [2, 2, 2, 2],
  );
  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM refrigerator_slots AS slot
    JOIN refrigerator_doors AS door ON door.id = slot.door_id WHERE door.compartment_id = ?
  `).get(bodies[1].id).count, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const table of ['refrigerator_compartments', 'refrigerator_slots']) {
  test(`${table} 저장 도중 실패하면 전체 등록을 롤백하고 다시 시도할 수 있다`, async t => {
    const { db, adapter } = await createRepositoryDatabase(t);
    const before = readStoredData(db);
    db.exec(`
      CREATE TRIGGER fail_registration BEFORE INSERT ON ${table}
      WHEN (SELECT count(*) FROM ${table}) >= 1
      BEGIN SELECT RAISE(ABORT, '검증용 저장 실패'); END;
    `);
    await assert.rejects(registerRefrigerator(adapter, model.createRefrigeratorDraft()), /검증용 저장 실패/);
    assert.deepEqual(readStoredData(db), before);
    db.exec('DROP TRIGGER fail_registration');
    const id = await registerRefrigerator(adapter, model.createRefrigeratorDraft());
    assert.equal(db.prepare('SELECT id FROM refrigerators').get().id, id);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('동시에 등록을 요청해도 냉장고 한 대와 완전한 구성만 저장된다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  const results = await Promise.allSettled([
    registerRefrigerator(adapter, model.createRefrigeratorDraft()),
    registerRefrigerator(adapter, createTwoDoorDraft()),
  ]);
  const successes = results.filter(result => result.status === 'fulfilled');
  const failures = results.filter(result => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /locked|busy|이미 등록/);
  assert.equal(db.prepare('SELECT id FROM refrigerators').get().id, successes[0].value);
  assert.equal(db.prepare('SELECT count(*) AS count FROM refrigerator_rows').get().count, 2);
  const doorCount = db.prepare('SELECT count(*) AS count FROM refrigerator_doors').get().count;
  assert(doorCount === 2 || doorCount === 3);
  assert.equal(db.prepare('SELECT count(*) AS count FROM refrigerator_compartments').get().count, doorCount);
  assert.equal(db.prepare('SELECT count(*) AS count FROM refrigerator_slots').get().count, doorCount * 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('이름만 변경하면 구조·위치 ID를 그대로 유지하고 재연결 후에도 이름을 복원한다', async t => {
  const { db, adapter, databasePath } = await createRepositoryDatabase(t);
  const id = await registerRefrigerator(adapter, createTwoDoorDraft());
  const before = readStoredData(db);
  const name = "  변경한 '냉장고'; --  ";
  assert.equal(await updateRefrigeratorName(adapter, id, name), name.trim());
  before.refrigerators[0].name = name.trim();
  assert.deepEqual(readStoredData(db), before);
  assert.equal((await getRefrigerator(adapter)).name, name.trim());
  const reopened = new DatabaseSync(databasePath);
  try {
    assert.equal(reopened.prepare('SELECT name FROM refrigerators WHERE id = ?').get(id).name, name.trim());
  } finally {
    reopened.close();
  }
});

test('이름·모드·문 수납·좌우 분할을 수정해도 기존 ID와 위치 참조를 유지한다', async t => {
  for (const foreignKeys of [false, true]) await t.test(`foreign_keys=${foreignKeys}`, async t => {
    const { db, adapter, databasePath } = await createRepositoryDatabase(t, foreignKeys);
    const id = await registerRefrigerator(adapter, createTwoDoorDraft());
    const loaded = await getRefrigerator(adapter);
    const before = readStoredData(db);
    const draft = model.createRefrigeratorDraft(loaded);
    draft.name = "  수정한 '냉장고'  ";
    draft.rows[0].compartments[0].storageMode = 'FROZEN';
    draft.rows[0].compartments[0].slots[0].drawerCount = 2;
    draft.rows[0].doors[1].storageEnabled = false;
    assert.notEqual(draft.rows[0].compartments[0].storageMode, loaded.rows[0].compartments[0].storageMode);
    const slotId = loaded.rows[0].compartments[0].slots[0].id;
    db.exec('CREATE TABLE position_refs (slot_id TEXT REFERENCES refrigerator_slots(id) ON DELETE CASCADE);');
    db.prepare('INSERT INTO position_refs (slot_id) VALUES (?)').run(slotId);
    const draftBeforeSave = structuredClone(draft);
    await updateRefrigerator(adapter, id, draft, []);
    assert.deepEqual(draft, draftBeforeSave);
    const after = readStoredData(db);
    for (const table of Object.keys(before)) assert.deepEqual(after[table].map(row => row.id), before[table].map(row => row.id));
    assert.equal(db.prepare('SELECT slot_id FROM position_refs').get().slot_id, slotId);
    const saved = await getRefrigerator(adapter);
    assert.equal(saved.name, "수정한 '냉장고'");
    assert.equal(saved.rows[0].compartments[0].storageMode, 'FROZEN');
    assert.equal(saved.rows[0].compartments[0].slots[0].drawerCount, 2);
    assert.equal(saved.rows[0].doors[1].storageEnabled, false);
    assert.deepEqual(saved.rows[0].doors[1].slots, loaded.rows[0].doors[1].slots);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const reopened = new DatabaseSync(databasePath);
    try {
      assert.equal(reopened.prepare('SELECT name FROM refrigerators WHERE id = ?').get(id).name, saved.name);
      assert.equal(reopened.prepare('SELECT drawer_count FROM refrigerator_slots WHERE id = ?').get(slotId).drawer_count, 2);
    } finally { reopened.close(); }
  });
});

test('본체 합치기·분리와 단·문·칸의 추가·삭제를 반복해도 연결과 순서를 유지한다', async t => {
  for (const foreignKeys of [false, true]) await t.test(`foreign_keys=${foreignKeys}`, async t => {
    const { db, adapter } = await createRepositoryDatabase(t, foreignKeys);
    const id = await registerRefrigerator(adapter, createTwoDoorDraft());
    const original = await getRefrigerator(adapter);
    const upper = original.rows[0];
    const retainedBodyId = upper.compartments[1].id;
    let draft = model.mergeDraftCompartments(model.createRefrigeratorDraft(original), upper.id, retainedBodyId);
    draft.rows[0].compartments[0].slots = createSlots(4, 2);
    draft.rows[0].doors[1].storageEnabled = false;
    draft.rows[0].doors[1].slots.push({ name: model.getSlotName(2), drawerCount: 0 });
    draft = model.setDraftDoorOpening(draft, draft.rows[1].id, draft.rows[1].doors[0].id, 'DRAWER');
    draft = model.addDraftRow(draft);
    await updateRefrigerator(adapter, id, draft, []);
    let saved = await getRefrigerator(adapter);
    assert.equal(saved.rows[0].compartments[0].id, retainedBodyId);
    assert.deepEqual(saved.rows[0].doors.map(door => door.id), upper.doors.map(door => door.id));
    assert.equal(saved.rows[0].doors[1].storageEnabled, false);
    assert.deepEqual(saved.rows[0].doors[1].slots.slice(0, 2), upper.doors[1].slots);
    assert.equal(saved.rows[0].compartments[0].slots.length, 4);
    assert.equal(saved.rows[1].doors[0].kind, 'DRAWER');
    assert.equal(saved.rows[1].compartments[0].slots.length, 1);
    assert.match(saved.rows[2].id, /^[0-9a-f-]{36}$/);
    assert.equal(db.prepare('SELECT id FROM refrigerator_compartments WHERE id = ?').get(upper.compartments[0].id), undefined);

    draft = model.splitDraftCompartment(model.createRefrigeratorDraft(saved), upper.id, retainedBodyId, upper.doors[1].id);
    await updateRefrigerator(adapter, id, draft, []);
    saved = await getRefrigerator(adapter);
    assert.equal(saved.rows[0].compartments[1].id, retainedBodyId);
    assert.notEqual(saved.rows[0].compartments[0].id, upper.compartments[0].id);
    assert.deepEqual(saved.rows[0].compartments.map(body => body.slots.length), [1, 1]);
    draft = model.changeDraftDoorCount(model.createRefrigeratorDraft(saved), upper.id, -1);
    await updateRefrigerator(adapter, id, draft, []);
    saved = await getRefrigerator(adapter);
    assert.equal(saved.rows[0].doors.length, 1);
    assert.equal(db.prepare('SELECT id FROM refrigerator_doors WHERE id = ?').get(upper.doors[1].id), undefined);

    const nextFirstRow = saved.rows[1];
    draft = model.removeDraftRow(model.createRefrigeratorDraft(saved), upper.id);
    draft = model.addDraftRow(draft);
    await updateRefrigerator(adapter, id, draft, []);
    saved = await getRefrigerator(adapter);
    assert.equal(saved.rows[0].id, nextFirstRow.id);
    assert.equal(saved.rows.length, 3);
    assert.equal(db.prepare('SELECT id FROM refrigerator_rows WHERE id = ?').get(upper.id), undefined);
    assert.deepEqual(db.prepare('SELECT sort_order FROM refrigerator_rows ORDER BY sort_order').all().map(row => row.sort_order), [0, 1, 2]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT count(*) AS count FROM refrigerators').get().count, 1);
  });
});

test('수정 기록·삭제 도중 실패하면 전체를 롤백하고 같은 초안으로 재시도할 수 있다', async t => {
  for (const phase of ['write', 'delete']) await t.test(phase, async t => {
    const { db, adapter } = await createRepositoryDatabase(t);
    const id = await registerRefrigerator(adapter, createTwoDoorDraft());
    const loaded = await getRefrigerator(adapter);
    const before = readStoredData(db);
    let draft = model.createRefrigeratorDraft(loaded);
    draft.name = '실패하면 바뀌지 않을 이름';
    draft = model.mergeDraftCompartments(draft, draft.rows[0].id, draft.rows[0].compartments[0].id);
    if (phase === 'write') db.exec(`
      CREATE TRIGGER fail_edit BEFORE UPDATE ON refrigerator_slots WHEN NEW.sort_order < OLD.sort_order
      BEGIN SELECT RAISE(ABORT, '검증용 수정 실패'); END;
    `);
    else db.exec(`
      CREATE TRIGGER fail_edit BEFORE DELETE ON refrigerator_compartments
      BEGIN SELECT RAISE(ABORT, '검증용 수정 실패'); END;
    `);
    await assert.rejects(updateRefrigerator(adapter, id, draft, []), /검증용 수정 실패/);
    assert.deepEqual(readStoredData(db), before);
    db.exec('DROP TRIGGER fail_edit;');
    await updateRefrigerator(adapter, id, draft, []);
    assert.equal((await getRefrigerator(adapter)).name, draft.name);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('참조 중인 칸을 없애는 수정은 전용 연결의 외래 키 설정과 관계없이 롤백한다', async t => {
  for (const foreignKeys of [false, true]) await t.test(`foreign_keys=${foreignKeys}`, async t => {
    const { db, adapter } = await createRepositoryDatabase(t, foreignKeys);
    const id = await registerRefrigerator(adapter, model.createRefrigeratorDraft());
    const loaded = await getRefrigerator(adapter);
    const before = readStoredData(db);
    db.exec('CREATE TABLE position_refs (slot_id TEXT REFERENCES refrigerator_slots(id));');
    const slotId = loaded.rows[0].compartments[0].slots[0].id;
    db.prepare('INSERT INTO position_refs (slot_id) VALUES (?)').run(slotId);
    let draft = model.createRefrigeratorDraft(loaded);
    draft = model.removeDraftRow(draft, loaded.rows[0].id);
    await assert.rejects(updateRefrigerator(adapter, id, draft, []), /연결 정보|FOREIGN KEY/);
    assert.deepEqual(readStoredData(db), before);
    assert.equal(db.prepare('SELECT slot_id FROM position_refs').get().slot_id, slotId);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('도면 편집은 확인한 재료만 위치 미지정으로 옮기고 실패와 재배치 과정에서 태그를 보존한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  const id = await registerRefrigerator(adapter, model.createRefrigeratorDraft());
  const refrigerator = await getRefrigerator(adapter);
  const [removed, retained] = refrigerator.rows;
  const slotId = removed.compartments[0].slots[0].id;
  const destination = { slotId: retained.compartments[0].slots[0].id, drawerNumber: 0 };
  const tag = await saveIngredientTag(adapter, '아침');
  const ingredient = await registerIngredient(adapter, {
    name: '우유', quantity: '1개', memo: '개봉', expirationDate: '2026-12-01', slotId, drawerNumber: 0,
  }, [tag.id]);
  const draft = model.removeDraftRow(model.createRefrigeratorDraft(refrigerator), removed.id);
  await assert.rejects(updateRefrigerator(adapter, id, draft, []), { key: 'fridge.unassignedChanged' });
  db.exec(`CREATE TRIGGER fail_layout_change BEFORE DELETE ON refrigerator_rows
    BEGIN SELECT RAISE(ABORT, '검증용 도면 저장 실패'); END;`);
  await assert.rejects(updateRefrigerator(adapter, id, draft, [ingredient.id]), /검증용 도면 저장 실패/);
  assert.deepEqual(await getRefrigerator(adapter), refrigerator);
  assert.deepEqual((await getIngredients(adapter)).map(item => ({ ...item })), [ingredient]);
  assert.deepEqual(await getUnassignedIngredients(adapter), []);

  db.exec('DROP TRIGGER fail_layout_change');
  await updateRefrigerator(adapter, id, draft, [ingredient.id]);
  const [unassigned] = await getUnassignedIngredients(adapter);
  assert.equal(unassigned.id, ingredient.id);
  assert.equal(unassigned.rowNumber, 1);
  assert.deepEqual(await getIngredients(adapter), []);
  assert.equal((await getIngredientTagOptions(adapter, ingredient.id))[0].attached, 1);

  await assignIngredients(adapter, [ingredient.id], destination);
  assert.deepEqual(await getUnassignedIngredients(adapter), []);
  assert.deepEqual((await getIngredients(adapter)).map(item => ({ ...item })), [{ ...ingredient, ...destination }]);
  assert.equal((await getIngredientTagOptions(adapter, ingredient.id))[0].attached, 1);
});

test('물리적 삽입 순서가 달라도 단·문·본체·칸은 저장된 배치 순서로 복원한다', async t => {
  const { db, adapter } = await createRepositoryDatabase(t);
  const draft = createTwoDoorDraft();
  draft.rows[0].doors[0].side = 'RIGHT_DOOR';
  draft.rows[0].doors[1].side = 'LEFT_DOOR';
  draft.rows[0].compartments[0].slots = createSlots(4);
  await registerRefrigerator(adapter, draft);
  const expected = await getRefrigerator(adapter);
  // 연쇄 삭제 전에 전체 원본을 보관하고 자식부터 비운 뒤 부모부터 다시 삽입한다.
  const stored = Object.keys(readStoredData(db)).map(table => [table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC`).all()]);
  db.exec('BEGIN;');
  for (const [table] of [...stored].reverse()) db.exec(`DELETE FROM ${table}`);
  for (const [table, rows] of stored) {
    for (const row of rows) {
      db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
        .run(...Object.values(row));
    }
  }
  db.exec('COMMIT;');
  assert.deepEqual(await getRefrigerator(adapter), expected);
  assert.deepEqual(expected.rows[0].doors.map(door => door.side), ['RIGHT_DOOR', 'LEFT_DOOR']);
  assert.deepEqual(expected.rows[0].compartments.map(body => body.doorIds), expected.rows[0].doors.map(door => [door.id]));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('누락된 구성은 미등록으로 오인하거나 임의로 채우지 않고 조회 오류로 알린다', async t => {
  const cases = [
    ['단 없음', db => { db.exec('DELETE FROM refrigerator_slots; DELETE FROM refrigerator_doors; DELETE FROM refrigerator_compartments; DELETE FROM refrigerator_rows;'); }],
    ['문 없는 본체', db => {
      const row = db.prepare('SELECT id FROM refrigerator_rows ORDER BY sort_order LIMIT 1').get();
      db.prepare("INSERT INTO refrigerator_compartments VALUES ('orphan-body', ?, 'CHILLED', 'HINGED', 'LEFT_DOOR')").run(row.id);
    }],
    ['칸 순서 누락', db => { db.exec('DELETE FROM refrigerator_slots WHERE door_id IS NOT NULL AND sort_order = 0'); }],
    ['단일 문의 방향 누락', db => { db.exec('UPDATE refrigerator_compartments SET side = NULL'); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const { db, adapter } = await createRepositoryDatabase(t);
      await registerRefrigerator(adapter, model.createRefrigeratorDraft());
      mutate(db);
      const before = readStoredData(db);
      await assert.rejects(getRefrigerator(adapter), /저장된 냉장고/);
      assert.deepEqual(readStoredData(db), before);
    });
  }
});
