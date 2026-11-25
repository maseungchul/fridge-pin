/**
 * @file
 * 재료가 공유하는 태그 목록과 재료 UUID별 태그 연결을 관리한다.
 * 태그 연결 저장은 재료를 등록하거나 수정하는 트랜잭션에서 호출한다.
 */
import { uuid } from 'expo';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { IngredientTag } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_TAG_NAME_MAX_LENGTH, normalizeIngredientSearchText } from '@/features/ingredient/model/ingredient';
import { AppError } from '@/i18n/errors';

export function getIngredientTagOptions(db: SQLiteDatabase, ingredientId?: string) {
  return db.getAllAsync<IngredientTag & { attached: 0 | 1 }>(`
    SELECT tag.id, tag.name, link.tag_id IS NOT NULL AS attached
    FROM tags AS tag
    LEFT JOIN ingredient_tags AS link ON link.tag_id = tag.id AND link.ingredient_id = ?
    ORDER BY tag.name_key;
  `, ingredientId ?? null);
}

export function getSearchableIngredientTags(db: SQLiteDatabase) {
  return db.getAllAsync<IngredientTag & { ingredientId: string }>(`
    SELECT tag.id, tag.name, link.ingredient_id AS ingredientId
    FROM ingredient_tags AS link JOIN tags AS tag ON tag.id = link.tag_id
    WHERE EXISTS (SELECT 1 FROM ingredients WHERE id = link.ingredient_id)
      OR EXISTS (SELECT 1 FROM unassigned_ingredients WHERE id = link.ingredient_id)
    ORDER BY tag.name_key;
  `);
}

export async function saveIngredientTag(db: SQLiteDatabase, input: string, tagId?: string): Promise<IngredientTag> {
  const name = input.trim();
  const nameKey = normalizeIngredientSearchText(name);
  if (!nameKey || name.length > INGREDIENT_TAG_NAME_MAX_LENGTH) throw new AppError('tag.invalidName');
  const id = tagId ?? uuid.v4();
  const result = tagId
    ? await db.runAsync(`
      UPDATE tags SET name = ?, name_key = ? WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tags WHERE name_key = ? AND id <> ?);
    `, name, nameKey, id, nameKey, id)
    : await db.runAsync('INSERT INTO tags (id, name, name_key) VALUES (?, ?, ?) ON CONFLICT (name_key) DO NOTHING;', id, name, nameKey);
  if (result.changes !== 1) {
    if (tagId && !await db.getFirstAsync('SELECT id FROM tags WHERE id = ?;', tagId)) throw new AppError('tag.missing');
    throw new AppError('tag.duplicate');
  }
  return { id, name };
}

export async function deleteIngredientTag(db: SQLiteDatabase, id: string) {
  // 기본 연결에서 활성화된 외래 키가 연결 행을 함께 삭제한다.
  const result = await db.runAsync('DELETE FROM tags WHERE id = ?;', id);
  if (result.changes !== 1) throw new AppError('tag.missing');
}

export async function replaceIngredientTags(transaction: SQLiteDatabase, ingredientId: string, tagIds: readonly string[]) {
  await transaction.runAsync('DELETE FROM ingredient_tags WHERE ingredient_id = ?;', ingredientId);
  for (const id of new Set(tagIds)) {
    const result = await transaction.runAsync(`
      INSERT INTO ingredient_tags (ingredient_id, tag_id)
      SELECT ?, id FROM tags WHERE id = ?;
    `, ingredientId, id);
    if (result.changes !== 1) throw new AppError('tag.missing');
  }
}
