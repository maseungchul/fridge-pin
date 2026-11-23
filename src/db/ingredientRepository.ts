/**
 * @file
 * 홈 도면과 선택한 칸의 재료를 조회하고 등록·수정·삭제·이동·소비 완료·복구한다.
 * 저장 결과는 재료 모델로 반환하며, 화면의 선택·로딩·오류 상태는 호출자가 관리한다.
 */
import { uuid } from 'expo';
import type { SQLiteDatabase } from 'expo-sqlite';
import { prepareIngredientRegistration } from '@/db/ingredientRegistration';
import type { ConsumedIngredient, Ingredient } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_NAME_MAX_LENGTH, INGREDIENT_QUANTITY_MAX_LENGTH } from '@/features/ingredient/model/ingredient';
import { AppError } from '@/i18n/errors';

const ingredientChangeListeners = new Set<(db: SQLiteDatabase) => void>();

/** 칸 ID와 단·열·칸 번호는 도면 변경 전 위치를 표시하는 데만 사용한다. */
export interface UnassignedIngredient extends Ingredient {
  rowNumber: number;
  firstColumn: number;
  lastColumn: number;
  doorCount: number;
  slotNumber: number;
  isBody: 0 | 1;
}

/** 예약 알림이 확정된 재료 목록을 다시 읽을 수 있게 저장 완료 시점을 전달한다. */
export function subscribeToIngredientChanges(listener: (db: SQLiteDatabase) => void) {
  ingredientChangeListeners.add(listener);
  return () => { ingredientChangeListeners.delete(listener); };
}

/** 재료를 포함한 다른 저장 작업에서도 커밋이 끝난 뒤 호출한다. */
export function notifyIngredientChanges(db: SQLiteDatabase) {
  for (const listener of ingredientChangeListeners) listener(db);
}

/** 냉장고 한 대의 전체 재료를 조회해 홈 도면의 위치별 등록 건수를 복원한다. */
export function getIngredients(db: SQLiteDatabase) {
  return db.getAllAsync<Ingredient>(`
    SELECT id, name, quantity, memo, expiration_date AS expirationDate,
      slot_id AS slotId, drawer_number AS drawerNumber
    FROM ingredients;
  `);
}

export function getUnassignedIngredients(db: SQLiteDatabase) {
  return db.getAllAsync<UnassignedIngredient>(`
    SELECT id, name, quantity, memo, expiration_date AS expirationDate,
      slot_id AS slotId, drawer_number AS drawerNumber, row_number AS rowNumber,
      first_column AS firstColumn, last_column AS lastColumn, door_count AS doorCount,
      slot_number AS slotNumber, is_body AS isBody
    FROM unassigned_ingredients
    ORDER BY row_number, first_column, is_body DESC, slot_number, drawer_number,
      expiration_date IS NULL, expiration_date, name, id;
  `);
}

/** 위치 지정을 기다리는 동안에도 유통기한 알림은 유지한다. */
export function getIngredientExpirationDates(db: SQLiteDatabase) {
  return db.getAllAsync<Pick<Ingredient, 'expirationDate'>>(`
    SELECT expiration_date AS expirationDate FROM ingredients WHERE expiration_date IS NOT NULL
    UNION ALL
    SELECT expiration_date AS expirationDate FROM unassigned_ingredients WHERE expiration_date IS NOT NULL;
  `);
}

/** 기존 도면의 위치를 기록하고, 구조를 수정하는 트랜잭션 안에서 재료를 분리한다. */
export async function unassignIngredients(transaction: SQLiteDatabase, ingredients: readonly Ingredient[]) {
  for (const ingredient of ingredients) {
    const result = await transaction.runAsync(`
      INSERT INTO unassigned_ingredients (
        id, name, quantity, memo, expiration_date, slot_id, drawer_number,
        row_number, first_column, last_column, door_count, slot_number, is_body
      )
      SELECT ingredient.id, ingredient.name, ingredient.quantity, ingredient.memo, ingredient.expiration_date,
        ingredient.slot_id, ingredient.drawer_number, row.sort_order + 1,
        COALESCE(door.sort_order, MIN(body_door.sort_order)) + 1,
        COALESCE(door.sort_order, MAX(body_door.sort_order)) + 1,
        (SELECT COUNT(*) FROM refrigerator_doors WHERE row_id = row.id),
        slot.sort_order + 1, slot.compartment_id IS NOT NULL
      FROM ingredients AS ingredient
      JOIN refrigerator_slots AS slot ON slot.id = ingredient.slot_id
      LEFT JOIN refrigerator_doors AS door ON door.id = slot.door_id
      LEFT JOIN refrigerator_compartments AS body ON body.id = slot.compartment_id
      JOIN refrigerator_rows AS row ON row.id = COALESCE(body.row_id, door.row_id)
      LEFT JOIN refrigerator_doors AS body_door ON body_door.compartment_id = body.id
      WHERE ingredient.id = ? AND ingredient.slot_id = ? AND ingredient.drawer_number = ?
      GROUP BY ingredient.id;
    `, ingredient.id, ingredient.slotId, ingredient.drawerNumber);
    if (result.changes !== 1) throw new AppError('fridge.unassignedChanged');
    await removeIngredient(transaction, ingredient);
  }
}

async function removeUnassignedIngredient(transaction: SQLiteDatabase, id: string) {
  const result = await transaction.runAsync('DELETE FROM unassigned_ingredients WHERE id = ?;', id);
  if (result.changes !== 1) throw new AppError('unassigned.missing');
}

/** 선택한 재료만 기존 ID와 입력값을 유지해 새 칸에 배치한다. */
export async function assignIngredients(db: SQLiteDatabase, ids: readonly string[],
  destination: Pick<Ingredient, 'slotId' | 'drawerNumber'>) {
  await db.withExclusiveTransactionAsync(async transaction => {
    for (const id of new Set(ids)) {
      const result = await transaction.runAsync(`
        INSERT INTO ingredients (id, name, quantity, memo, expiration_date, slot_id, drawer_number)
        SELECT id, name, quantity, memo, expiration_date, ?, ?
        FROM unassigned_ingredients WHERE id = ?;
      `, destination.slotId, destination.drawerNumber, id);
      if (result.changes !== 1) throw new AppError('unassigned.missing');
      await removeUnassignedIngredient(transaction, id);
    }
  });
  notifyIngredientChanges(db);
}

/** 삭제 대상이 바뀌면 선택한 목록 전체를 보존한다. */
export async function deleteUnassignedIngredients(db: SQLiteDatabase, ids: readonly string[]) {
  await db.withExclusiveTransactionAsync(async transaction => {
    for (const id of new Set(ids)) await removeUnassignedIngredient(transaction, id);
  });
  notifyIngredientChanges(db);
}

/** 유통기한이 빠른 재료부터 표시하고, 날짜가 없는 재료는 뒤에 둔다. */
export function getIngredientsByPosition(db: SQLiteDatabase, position: Pick<Ingredient, 'slotId' | 'drawerNumber'>) {
  return db.getAllAsync<Ingredient>(`
    SELECT id, name, quantity, memo, expiration_date AS expirationDate,
      slot_id AS slotId, drawer_number AS drawerNumber
    FROM ingredients
    WHERE slot_id = ? AND drawer_number = ?
    ORDER BY expiration_date IS NULL, expiration_date, name, id;
  `, position.slotId, position.drawerNumber);
}

export async function registerIngredient(db: SQLiteDatabase, input: Omit<Ingredient, 'id'>): Promise<Ingredient> {
  const ingredient = await insertIngredient(db, input);
  notifyIngredientChanges(db);
  return ingredient;
}

/** 다른 작업과 같은 트랜잭션에서 사용할 수 있도록 재료만 저장한다. */
export async function insertIngredient(db: SQLiteDatabase, input: Omit<Ingredient, 'id'>): Promise<Ingredient> {
  const ingredient = prepareIngredientRegistration(input, uuid.v4);
  await db.runAsync(`
    INSERT INTO ingredients (id, name, quantity, memo, expiration_date, slot_id, drawer_number)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `, ingredient.id, ingredient.name, ingredient.quantity, ingredient.memo, ingredient.expirationDate,
  ingredient.slotId, ingredient.drawerNumber);
  return ingredient;
}

/** 기존 제한보다 긴 값은 변경하지 않은 경우에만 유지하며 재료의 기본 정보를 수정한다. */
export async function updateIngredient(db: SQLiteDatabase, input: Ingredient): Promise<Ingredient> {
  const existing = input.name.trim().length > INGREDIENT_NAME_MAX_LENGTH || input.quantity.trim().length > INGREDIENT_QUANTITY_MAX_LENGTH
    ? await db.getFirstAsync<Pick<Ingredient, 'name' | 'quantity'>>(
      'SELECT name, quantity FROM ingredients WHERE id = ? AND slot_id = ? AND drawer_number = ?',
      input.id, input.slotId, input.drawerNumber)
    : null;
  const ingredient = prepareIngredientRegistration(input, () => input.id, existing);
  const result = await db.runAsync(`
    UPDATE ingredients SET name = ?, quantity = ?, memo = ?, expiration_date = ?
    WHERE id = ? AND slot_id = ? AND drawer_number = ?;
  `, ingredient.name, ingredient.quantity, ingredient.memo, ingredient.expirationDate,
  ingredient.id, ingredient.slotId, ingredient.drawerNumber);
  if (result.changes !== 1) throw new AppError('errors.ingredientUpdateMissing');
  notifyIngredientChanges(db);
  return ingredient;
}

/** ID와 보관 위치가 일치하는 재료 한 건만 삭제하고, 달라진 대상은 목록에서 다시 확인한다. */
export async function deleteIngredient(db: SQLiteDatabase, ingredient: Pick<Ingredient, 'id' | 'slotId' | 'drawerNumber'>): Promise<void> {
  await removeIngredient(db, ingredient);
  notifyIngredientChanges(db);
}

async function removeIngredient(db: SQLiteDatabase, ingredient: Pick<Ingredient, 'id' | 'slotId' | 'drawerNumber'>) {
  const result = await db.runAsync(`
    DELETE FROM ingredients WHERE id = ? AND slot_id = ? AND drawer_number = ?;
  `, ingredient.id, ingredient.slotId, ingredient.drawerNumber);
  if (result.changes !== 1) throw new AppError('errors.ingredientDeleteMissing');
}

/** 최신 재료 정보를 완료 기록에 보관하고, 냉장고에서 제거하는 작업을 함께 확정한다. */
export async function consumeIngredient(db: SQLiteDatabase, ingredient: Pick<Ingredient, 'id' | 'slotId' | 'drawerNumber'>): Promise<void> {
  await consumeIngredients(db, [ingredient]);
}

/** 소비 기록과 장보기 추가를 함께 확정하고, 이미 등록된 품목이 있었는지 반환한다. */
export async function consumeIngredients(db: SQLiteDatabase, ingredients: readonly Pick<Ingredient, 'id' | 'slotId' | 'drawerNumber'>[]): Promise<boolean> {
  if (ingredients.length === 0) return false;
  const consumedAt = new Date().toISOString();
  let hasShoppingDuplicates = false;
  await db.withExclusiveTransactionAsync(async transaction => {
    for (const ingredient of new Map(ingredients.map(item => [item.id, item])).values()) {
      const result = await transaction.runAsync(`
        INSERT INTO consumed_ingredients (id, name, quantity, memo, expiration_date, slot_id, drawer_number, consumed_at)
        SELECT id, name, quantity, memo, expiration_date, slot_id, drawer_number, ? FROM ingredients
        WHERE id = ? AND slot_id = ? AND drawer_number = ?;
      `, consumedAt, ingredient.id, ingredient.slotId, ingredient.drawerNumber);
      if (result.changes !== 1) throw new AppError('errors.ingredientConsumeMissing');
      // 기존 재료의 수량을 보존하고 같은 일괄 처리에서 먼저 추가한 품목도 중복으로 본다.
      const shoppingResult = await transaction.runAsync(`
        INSERT INTO shopping_items (id, name, quantity, created_at)
        SELECT ?, source.name, source.quantity, ? FROM consumed_ingredients AS source
        WHERE source.id = ? AND NOT EXISTS (
          SELECT 1 FROM shopping_items
          WHERE purchased_at IS NULL AND TRIM(name) = TRIM(source.name) COLLATE NOCASE
        );
      `, uuid.v4(), consumedAt, ingredient.id);
      if (shoppingResult.changes === 0) hasShoppingDuplicates = true;
      await removeIngredient(transaction, ingredient);
    }
  });
  notifyIngredientChanges(db);
  return hasShoppingDuplicates;
}

/** 선택한 ID·출발 위치를 한 트랜잭션에서 삭제하고 일부만 삭제되는 상황을 막는다. */
export async function deleteIngredients(db: SQLiteDatabase, ingredients: readonly Pick<Ingredient, 'id' | 'slotId' | 'drawerNumber'>[]): Promise<void> {
  if (ingredients.length === 0) return;
  await db.withExclusiveTransactionAsync(async transaction => {
    for (const ingredient of new Map(ingredients.map(item => [item.id, item])).values()) {
      await removeIngredient(transaction, ingredient);
    }
  });
  notifyIngredientChanges(db);
}

/** 원래 위치가 사라져도 기록을 유지하고, 최근 소비한 재료부터 표시한다. */
export function getConsumedIngredients(db: SQLiteDatabase) {
  return db.getAllAsync<ConsumedIngredient>(`
    SELECT id, name, quantity, memo, expiration_date AS expirationDate,
      slot_id AS slotId, drawer_number AS drawerNumber, consumed_at AS consumedAt
    FROM consumed_ingredients ORDER BY consumed_at DESC, id;
  `);
}

export function getConsumedIngredient(db: SQLiteDatabase, record: Pick<ConsumedIngredient, 'id' | 'consumedAt'>) {
  return db.getFirstAsync<ConsumedIngredient>(`
    SELECT id, name, quantity, memo, expiration_date AS expirationDate,
      slot_id AS slotId, drawer_number AS drawerNumber, consumed_at AS consumedAt
    FROM consumed_ingredients WHERE id = ? AND consumed_at = ?;
  `, record.id, record.consumedAt);
}

/** 원래 위치가 유효하지 않으면 기록을 남기고 null을 반환해 새 위치 선택으로 연결한다. */
export async function restoreConsumedIngredient(db: SQLiteDatabase, record: Pick<ConsumedIngredient, 'id' | 'consumedAt'>,
  destination?: Pick<Ingredient, 'slotId' | 'drawerNumber'>): Promise<Ingredient | null> {
  let restored: Ingredient | null = null;
  await db.withExclusiveTransactionAsync(async transaction => {
    const stored = await getConsumedIngredient(transaction, record);
    if (!stored) throw new AppError('errors.consumedIngredientMissing');
    const position = destination ?? stored;
    const available = await transaction.getFirstAsync(`
      SELECT slot.id FROM refrigerator_slots AS slot
      LEFT JOIN refrigerator_doors AS door ON door.id = slot.door_id
      LEFT JOIN refrigerator_compartments AS body ON body.id = door.compartment_id
      WHERE slot.id = ? AND ((slot.drawer_count = 2 AND ? IN (1, 2)) OR (slot.drawer_count IN (0, 1) AND ? = 0))
        AND (slot.door_id IS NULL OR (door.storage_enabled = 1 AND body.kind = 'HINGED'));
    `, position.slotId, position.drawerNumber, position.drawerNumber);
    if (!available) {
      if (destination) throw new AppError('errors.invalidPosition');
      return;
    }
    const ingredient: Ingredient = { id: stored.id, name: stored.name, quantity: stored.quantity, memo: stored.memo,
      expirationDate: stored.expirationDate, slotId: position.slotId, drawerNumber: position.drawerNumber };
    await transaction.runAsync(`
      INSERT INTO ingredients (id, name, quantity, memo, expiration_date, slot_id, drawer_number)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `, ingredient.id, ingredient.name, ingredient.quantity, ingredient.memo, ingredient.expirationDate,
    ingredient.slotId, ingredient.drawerNumber);
    await deleteConsumedIngredient(transaction, record);
    restored = ingredient;
  });
  if (restored) notifyIngredientChanges(db);
  return restored;
}

/** 화면에서 확인한 완료 기록만 영구 삭제하고, 이미 처리된 기록의 중복 요청을 거부한다. */
export async function deleteConsumedIngredient(db: SQLiteDatabase, record: Pick<ConsumedIngredient, 'id' | 'consumedAt'>): Promise<void> {
  const result = await db.runAsync('DELETE FROM consumed_ingredients WHERE id = ? AND consumed_at = ?;', record.id, record.consumedAt);
  if (result.changes !== 1) throw new AppError('errors.consumedIngredientMissing');
}

/** 최신 재료와 출발 위치를 확인하고, 한 건이라도 달라졌으면 전체 이동을 취소한다. */
export async function moveIngredients(db: SQLiteDatabase, ingredients: readonly Ingredient[],
  destination: Pick<Ingredient, 'slotId' | 'drawerNumber'>): Promise<Ingredient[]> {
  const moved: Ingredient[] = [];
  if (ingredients.length === 0) return moved;
  await db.withExclusiveTransactionAsync(async transaction => {
    const seen = new Set<string>();
    for (const ingredient of ingredients) {
      if (seen.has(ingredient.id)) continue;
      seen.add(ingredient.id);
      const stored = await transaction.getFirstAsync<Ingredient>(`
        SELECT id, name, quantity, memo, expiration_date AS expirationDate,
          slot_id AS slotId, drawer_number AS drawerNumber
        FROM ingredients WHERE id = ? AND slot_id = ? AND drawer_number = ?;
      `, ingredient.id, ingredient.slotId, ingredient.drawerNumber);
      if (!stored) throw new AppError('errors.ingredientMoveMissing');
      if (stored.slotId === destination.slotId && stored.drawerNumber === destination.drawerNumber) continue;
      const result = await transaction.runAsync(`
        UPDATE ingredients SET slot_id = ?, drawer_number = ?
        WHERE id = ? AND slot_id = ? AND drawer_number = ?;
      `, destination.slotId, destination.drawerNumber, stored.id, stored.slotId, stored.drawerNumber);
      if (result.changes !== 1) throw new AppError('errors.ingredientMoveMissing');
      moved.push({ ...stored, ...destination });
    }
  });
  return moved;
}
