/**
 * @file
 * 이동 대기와 위치 지정 필요 목록의 재료를 출발 위치별로 묶어 표시한다.
 * 목록 종류에 따라 선택한 재료를 대기 목록에서 빼거나, 삭제·새 위치 지정으로 연결한다.
 */
import { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { BottomSheetSectionList } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { EmptyListState } from '@/components/EmptyListState';
import { getIngredientLocationPath } from '@/features/fridge/model/fridgeLayout';
import type { FridgeLayout } from '@/features/fridge/model/fridgeLayout';
import { IngredientLocationBreadcrumb } from '@/features/ingredient/components/IngredientLocationBreadcrumb';
import type { Ingredient } from '@/features/ingredient/model/ingredient';
import { getIngredientExpirationStatus } from '@/features/ingredient/model/ingredient';
import { spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import { useTranslation } from '@/i18n/LanguageProvider';
import { getErrorMessage } from '@/i18n/errors';
import { formatDate } from '@/i18n/translations';
import { COMPACT_HEADER_ICON_INSET, COMPACT_HEADER_ICON_SIZE, getCompactHeaderStyles } from '@/theme/headerStyles';

export function useMoveQueueSelection() {
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  return { selectedIds, setSelectedIds };
}

type QueueSelection = ReturnType<typeof useMoveQueueSelection>;

export function IngredientMoveQueueHeader({ ingredients, selection, disabled, onBack, unassigned }: {
  ingredients: Ingredient[];
  selection: QueueSelection;
  disabled: boolean;
  onBack?: () => void;
  unassigned?: boolean;
}) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const { selectedIds, setSelectedIds } = selection;
  const allSelected = ingredients.length > 0 && ingredients.every(item => selectedIds?.includes(item.id));

  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        {onBack ? (
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('ingredient.back')}
            disabled={disabled} onPress={onBack} style={styles.headerButton}>
            <MaterialDesignIcons name="arrow-left" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
          </FeedbackPressable>
        ) : null}
        <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t(selectedIds ? 'ingredient.selectAll' : 'ingredient.select')}
          accessibilityState={{ disabled: disabled || ingredients.length === 0, ...(selectedIds ? { selected: allSelected } : {}) }}
          disabled={disabled || ingredients.length === 0} style={styles.headerButton}
          onPress={() => setSelectedIds(selectedIds && !allSelected ? ingredients.map(item => item.id) : [])}>
          <MaterialDesignIcons name={selectedIds ? 'check-all' : 'check'} size={COMPACT_HEADER_ICON_SIZE}
            color={allSelected ? colors.chilled : colors.text} accessible={false} />
        </FeedbackPressable>
      </View>
      <Text accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}
        style={styles.title}>{t(unassigned ? 'unassigned.title' : 'queue.title', { count: ingredients.length })}</Text>
      <View style={styles.headerRight}>
        {selectedIds ? (
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('ingredient.cancelSelection')}
            disabled={disabled} onPress={() => setSelectedIds(null)} style={styles.headerButton}>
            <MaterialDesignIcons name="close" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
          </FeedbackPressable>
        ) : null}
      </View>
    </View>
  );
}

interface IngredientMoveQueueListProps {
  ingredients: Ingredient[];
  layout?: FridgeLayout;
  disabled: boolean;
  selection: QueueSelection;
  onRemove: (ids: string[]) => void | Promise<void>;
  onAssign?: (ids: string[]) => void;
  getSourcePath?: (id: string) => string[] | undefined;
}

export function IngredientMoveQueueList({ ingredients, layout, disabled, selection, onRemove, onAssign,
  getSourcePath }: IngredientMoveQueueListProps) {
  const { mode, colors, ingredientBadgeColors } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const removalPending = useRef(false);
  const { selectedIds, setSelectedIds } = selection;
  const targets = ingredients.filter(item => selectedIds?.includes(item.id));

  function requestRemoval() {
    if (disabled || targets.length === 0 || removalPending.current) return;
    removalPending.current = true;
    Alert.alert(t('common.warning'), t(onAssign ? 'ingredient.deleteSelectedConfirm' : 'queue.deleteSelectedConfirm', { count: targets.length }), [
      { text: t('common.cancel'), style: 'cancel', onPress: () => { removalPending.current = false; } },
      { text: t('common.delete'), style: 'destructive', onPress: async () => {
        if (!removalPending.current) return;
        try {
          await onRemove(targets.map(item => item.id));
          setSelectedIds(null);
        } catch (error) {
          Alert.alert(t('common.error'), getErrorMessage(error, t, t('ingredient.deleteError')), [{ text: t('common.ok') }]);
        } finally {
          removalPending.current = false;
        }
      } },
    ], { cancelable: false });
  }
  const sections: { key: string; title: string; path: string[]; data: Ingredient[] }[] = [];
  for (const ingredient of ingredients) {
    const sourcePath = getSourcePath?.(ingredient.id);
    const key = sourcePath?.join(' → ') ?? `${ingredient.slotId}:${ingredient.drawerNumber}`;
    let section = sections.find(candidate => candidate.key === key);
    if (!section) {
      const path = sourcePath ?? (layout && getIngredientLocationPath(layout, ingredient, t)) ?? [t('queue.locationMissing')];
      section = { key, title: path.join(' → '), path, data: [] };
      sections.push(section);
    }
    section.data.push(ingredient);
  }

  return (
    <>
      <BottomSheetSectionList sections={sections} extraData={selectedIds} keyExtractor={item => item.id} stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator indicatorStyle={mode === 'dark' ? 'white' : 'black'} automaticallyAdjustsScrollIndicatorInsets={false}
        scrollIndicatorInsets={{ top: 0, bottom: spacing.md + (selectedIds ? 0 : insets.bottom), left: 0, right: spacing.xs }}
        style={styles.list} contentContainerStyle={[ingredients.length === 0 ? styles.empty : undefined, { paddingBottom: selectedIds ? 0 : insets.bottom }]}
        ListHeaderComponent={onAssign && ingredients.length > 0
          ? <Text style={styles.guide}>{t('unassigned.guide')}</Text> : undefined}
        ListEmptyComponent={<EmptyListState message={t(onAssign ? 'unassigned.emptyTitle' : 'queue.emptyTitle')}
          description={t(onAssign ? 'unassigned.emptyGuide' : 'queue.emptyGuide')} />}
        renderSectionHeader={({ section }) => <IngredientLocationBreadcrumb path={section.path} sectionHeader />}
        renderItem={({ item, section }) => {
          const expiration = getIngredientExpirationStatus(item.expirationDate, undefined, t);
          const checked = selectedIds?.includes(item.id) ?? false;
          const details = (
            <View style={styles.labels}>
              <Text style={styles.name}>{item.name}<Text style={styles.quantity}>  {item.quantity}</Text></Text>
              {item.memo ? <Text style={styles.detail}>{item.memo}</Text> : null}
              <Text style={[styles.detail, item.expirationDate !== null && {
                color: ingredientBadgeColors[expiration.isExpired ? 'expired' : expiration.isUrgent ? 'warning' : 'normal'],
              }]}>{item.expirationDate ? t('ingredient.expirationLabel', { date: formatDate(item.expirationDate, t) }) : t('ingredient.noExpiration')}</Text>
            </View>
          );
          return selectedIds ? (
            <FeedbackPressable accessibilityRole="checkbox" accessibilityLabel={t('ingredient.selectItem', { name: item.name })}
              accessibilityHint={section.title} accessibilityValue={{ text: `${item.quantity}, ${expiration.label}` }}
              accessibilityState={{ checked, disabled }} disabled={disabled} feedback="none"
              onPress={() => setSelectedIds(current => current && (current.includes(item.id)
                ? current.filter(id => id !== item.id) : [...current, item.id]))}
              style={[styles.item, checked && styles.selectedItem]}>
              <View style={styles.selectionCircleContainer}>
                {checked ? <MaterialDesignIcons name="checkbox-marked-circle" size={24} color={colors.chilled} accessible={false} />
                  : <View style={styles.selectionCircle} />}
              </View>
              {details}
            </FeedbackPressable>
          ) : <View style={styles.item}>{details}</View>;
        }} />
      {selectedIds ? (
        <View style={[styles.selectionToolbar, { height: 50 + insets.bottom, paddingBottom: insets.bottom }]}>
          {onAssign ? (
            <FeedbackPressable accessibilityRole="button" accessibilityLabel={t('unassigned.choose')} feedback="none"
              disabled={disabled || targets.length === 0} onPress={() => {
                if (!removalPending.current) onAssign(targets.map(item => item.id));
              }} style={styles.selectionAction}>
              {({ pressed }) => <>
                <MaterialDesignIcons name="map-marker-outline" size={24} color={pressed ? colors.iconPressed : colors.text} accessible={false} />
                <Text style={[styles.assignLabel, pressed && { color: colors.iconPressed }]}>{t('unassigned.choose')}</Text>
              </>}
            </FeedbackPressable>
          ) : null}
          <FeedbackPressable accessibilityRole="button" accessibilityLabel={t(onAssign ? 'ingredient.deleteSelected' : 'queue.deleteSelected')} feedback="none"
            disabled={disabled || targets.length === 0} accessibilityState={{ disabled: disabled || targets.length === 0 }}
            onPress={requestRemoval} style={styles.selectionAction}>
            {({ pressed }) => <>
              <MaterialDesignIcons name="trash-can-outline" size={24} color={pressed ? colors.errorPressed : colors.error} accessible={false} />
              <Text style={[styles.deleteLabel, pressed && { color: colors.errorPressed }]}>{t('common.delete')}</Text>
            </>}
          </FeedbackPressable>
        </View>
      ) : null}
    </>
  );
}

const getStyles = createThemedStyles(({ colors }, mode) => StyleSheet.create({
  header: { ...getCompactHeaderStyles(mode).header, gap: 0 },
  title: { ...getCompactHeaderStyles(mode).title, flex: 1, textAlign: 'center' },
  headerLeft: { flexDirection: 'row', marginLeft: -COMPACT_HEADER_ICON_INSET },
  headerRight: { width: 48, marginRight: -COMPACT_HEADER_ICON_INSET },
  headerButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  guide: { padding: spacing.md, color: colors.textMuted, fontSize: 14, lineHeight: 21 },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md,
    paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  labels: { flex: 1, gap: spacing.xs },
  name: { color: colors.text, fontSize: 16 },
  quantity: { color: colors.text, fontSize: 14 },
  detail: { color: colors.textMuted, fontSize: 15, lineHeight: 21 },
  selectedItem: { backgroundColor: colors.chilledBackground },
  selectionCircleContainer: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  selectionCircle: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: colors.textMuted },
  selectionToolbar: { flexShrink: 0, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
  selectionAction: { flex: 1, minHeight: 48, paddingTop: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  deleteLabel: { color: colors.error, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  assignLabel: { color: colors.text, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  empty: { flexGrow: 1, justifyContent: 'center' },
}));
