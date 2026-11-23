/**
 * @file
 * 홈의 이동 대기·위치 지정 필요 목록을 같은 바텀 시트에 각각 표시한다.
 * 새 칸 선택 화면은 시트가 닫힌 후 연다.
 */
import { useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { BottomSheet } from '@/features/ingredient/components/BottomSheet';
import type { BottomSheetRef } from '@/features/ingredient/components/BottomSheet';
import { IngredientMoveQueueHeader, IngredientMoveQueueList, useMoveQueueSelection } from '@/features/ingredient/components/IngredientMoveQueueList';
import { useIngredientMoveQueue } from '@/features/ingredient/IngredientMoveQueueProvider';
import type { UnassignedIngredient } from '@/db/ingredientRepository';
import type { FridgeLayout } from '@/features/fridge/model/fridgeLayout';
import type { Ingredient } from '@/features/ingredient/model/ingredient';
import { createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import { useTranslation } from '@/i18n/LanguageProvider';

type IngredientMoveQueueSheetProps = { onClose: () => void } & ({
  ingredients: Ingredient[];
  layout: FridgeLayout;
  onAssign?: never;
} | {
  ingredients: UnassignedIngredient[];
  layout?: never;
  onAssign: (ids: string[]) => void;
  onDelete: (ids: string[]) => Promise<void>;
});

export function IngredientMoveQueueSheet(props: IngredientMoveQueueSheetProps) {
  const { ingredients, layout, onClose, onAssign } = props;
  const { mode } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const sheet = useRef<BottomSheetRef>(null);
  const pendingAssignment = useRef<string[] | null>(null);
  const deleting = useRef(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const { remove } = useIngredientMoveQueue();
  const selection = useMoveQueueSelection();
  const { selectedIds, setSelectedIds } = selection;
  const isSelecting = selectedIds !== null;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (deleting.current || pendingAssignment.current) return true;
      if (isSelecting) setSelectedIds(null);
      else sheet.current?.close();
      return true;
    });
    return () => subscription.remove();
  }, [isSelecting, setSelectedIds]);

  function getSourcePath(id: string) {
    if (!props.onAssign) return;
    const item = props.ingredients.find(ingredient => ingredient.id === id);
    if (!item) return;
    const column = item.firstColumn === item.lastColumn ? item.firstColumn : `${item.firstColumn}~${item.lastColumn}`;
    const row = item.doorCount === 1 ? t('fridge.rowLocation', { row: item.rowNumber })
      : t('fridge.columnLocation', { row: item.rowNumber, column });
    const slot = t('fridge.shortSlotName', { index: item.slotNumber });
    const direction = item.drawerNumber ? t(item.drawerNumber === 1 ? 'fridge.left' : 'fridge.right') : null;
    return [row, item.isBody ? t('fridge.body') : t('fridge.doorPocket'), direction ? `${slot} · ${direction}` : slot];
  }

  async function removeSelected(ids: string[]) {
    if (!props.onAssign) {
      ids.forEach(remove);
      return;
    }
    deleting.current = true;
    setIsDeleting(true);
    try {
      await props.onDelete(ids);
    } finally {
      deleting.current = false;
      setIsDeleting(false);
    }
  }

  return (
    <BottomSheet ref={sheet} disabled={isDeleting} onClose={() => {
      onClose();
      if (pendingAssignment.current) onAssign?.(pendingAssignment.current);
    }} header={
      <IngredientMoveQueueHeader ingredients={ingredients} selection={selection} disabled={isDeleting || isAssigning} unassigned={!!onAssign} />
    }>
      <View style={styles.panel} onAccessibilityEscape={() => {
        if (deleting.current || pendingAssignment.current) return;
        if (isSelecting) setSelectedIds(null);
        else sheet.current?.close();
      }}>
        <IngredientMoveQueueList ingredients={ingredients} layout={layout} disabled={isDeleting || isAssigning} selection={selection}
          getSourcePath={onAssign ? getSourcePath : undefined} onRemove={removeSelected}
          onAssign={onAssign ? ids => {
            if (pendingAssignment.current || deleting.current) return;
            pendingAssignment.current = ids;
            sheet.current?.close();
            setIsAssigning(true);
          } : undefined} />
      </View>
    </BottomSheet>
  );
}

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.surface },
}));
