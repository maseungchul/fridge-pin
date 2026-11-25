/**
 * @file
 * 재료 폼 위에서 최근 태그와 검색 결과를 보여주고 여러 태그를 선택한다.
 * 공용 태그 생성은 즉시 저장하고, 재료에 붙일 태그는 완료로 닫힐 때 전달한다.
 */
import { useRef, useState } from 'react';
import type { ComponentRef, RefObject } from 'react';
import { ActivityIndicator, Keyboard, StyleSheet, Text, View } from 'react-native';
import { BottomSheetSectionList, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { SelectionCheck } from '@/components/SelectionCheck';
import { saveIngredientTag } from '@/db/ingredientTagRepository';
import { BottomSheet } from '@/features/ingredient/components/BottomSheet';
import type { BottomSheetRef } from '@/features/ingredient/components/BottomSheet';
import type { IngredientTag } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_TAG_NAME_MAX_LENGTH, normalizeIngredientSearchText } from '@/features/ingredient/model/ingredient';
import { getErrorMessage } from '@/i18n/errors';
import { useTranslation } from '@/i18n/LanguageProvider';
import { useAppTheme } from '@/theme/ThemeProvider';
import { TAG_ICON_GAP, createThemedStyles, spacing } from '@/theme/tokens';

interface IngredientTagPickerSheetProps {
  sheetRef: RefObject<BottomSheetRef | null>;
  tags: readonly IngredientTag[];
  attachedIds: readonly string[];
  recentTagIds: readonly string[];
  onTagCreated: (tag: IngredientTag) => void;
  onClose: (selectedIds: string[] | null) => void;
}

const SNAP_POINTS = ['100%'];
const RECENT_TAG_LIMIT = 5;

export function IngredientTagPickerSheet({ sheetRef, tags, attachedIds, recentTagIds, onTagCreated, onClose }: IngredientTagPickerSheetProps) {
  const { colors, mode } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { bottom } = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const searchInput = useRef<ComponentRef<typeof BottomSheetTextInput>>(null);
  const creating = useRef(false);
  const closing = useRef(false);
  const selectionToApply = useRef<string[] | null>(null);

  const queryKey = normalizeIngredientSearchText(query);
  const exactTag = queryKey ? tags.find(tag => normalizeIngredientSearchText(tag.name) === queryKey) : undefined;
  const availableTags = tags.filter(tag => !attachedIds.includes(tag.id));
  const recentTags = queryKey ? [] : recentTagIds.flatMap(id => availableTags.find(tag => tag.id === id) ?? []).slice(0, RECENT_TAG_LIMIT);
  const otherTags = queryKey ? availableTags.filter(tag => normalizeIngredientSearchText(tag.name).includes(queryKey))
    : availableTags.filter(tag => !recentTags.some(recent => recent.id === tag.id));
  const sections = [];
  if (recentTags.length) sections.push({ key: 'recent', title: t('tag.recent'), data: recentTags });
  if (otherTags.length) sections.push({ key: 'other', title: queryKey ? null : t(recentTags.length ? 'tag.other' : 'tag.all'), data: otherTags });

  function close(apply: boolean) {
    if (creating.current || closing.current) return;
    closing.current = true;
    selectionToApply.current = apply ? [...selectedIds] : null;
    sheetRef.current?.close();
    Keyboard.dismiss();
  }

  function toggleTag(id: string) {
    if (creating.current || closing.current) return;
    setSelectedIds(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function clearQuery() {
    const input = searchInput.current;
    if (input && 'clear' in input && typeof input.clear === 'function') input.clear();
    setQuery('');
  }

  async function selectQuery() {
    if (!queryKey || creating.current || closing.current) return;
    if (exactTag) {
      if (attachedIds.includes(exactTag.id)) return;
      setSelectedIds(current => new Set(current).add(exactTag.id));
      clearQuery();
      setError(null);
      return;
    }
    creating.current = true;
    setIsCreating(true);
    setError(null);
    try {
      const tag = await saveIngredientTag(db, query);
      onTagCreated(tag);
      setSelectedIds(current => new Set(current).add(tag.id));
      clearQuery();
    } catch (cause) {
      setError({ cause });
    } finally {
      creating.current = false;
      setIsCreating(false);
    }
  }

  return (
    <BottomSheet ref={sheetRef} snapPoints={SNAP_POINTS} keyboardBlurBehavior="restore"
      disabled={isCreating} onClose={() => {
        Keyboard.dismiss();
        onClose(selectionToApply.current);
      }} header={
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text accessibilityRole="header" style={styles.title}>{t('tag.list')}</Text>
        <View style={styles.headerSide}>
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('tag.done')}
            accessibilityState={{ disabled: isCreating || selectedIds.size === 0 }} disabled={isCreating || selectedIds.size === 0}
            style={styles.doneButton} onPress={() => close(true)}>
            <MaterialDesignIcons name="tag-arrow-left-outline" size={24} color={colors.text} accessible={false} />
          </FeedbackPressable>
        </View>
      </View>
      }>
      {/* 입력창은 손잡이 밖에 두어 입력 중에도 다시 만들지 않는다. */}
      <View style={styles.search}>
        <MaterialDesignIcons name="magnify" size={20} color={colors.textMuted} accessible={false} />
        {/* 검색 상태를 입력창에 다시 쓰지 않아 한글 조합은 네이티브 키보드가 유지한다. */}
        <BottomSheetTextInput ref={searchInput} accessibilityLabel={t('tag.search')} placeholder={t('tag.search')} placeholderTextColor={colors.textMuted}
          keyboardAppearance={mode} style={styles.input} maxLength={INGREDIENT_TAG_NAME_MAX_LENGTH}
          editable={!isCreating} autoCorrect={false} returnKeyType="done" submitBehavior="submit"
          onChangeText={text => { setQuery(text); setError(null); }} onSubmitEditing={() => void selectQuery()} />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{getErrorMessage(error.cause, t, t('tag.saveError'))}</Text> : null}
      <BottomSheetSectionList<IngredientTag> sections={sections} extraData={selectedIds} keyExtractor={tag => tag.id}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="none" stickySectionHeadersEnabled={false}
        style={styles.list} contentContainerStyle={{ paddingBottom: bottom + spacing.md }}
        ListHeaderComponent={queryKey && !exactTag ? (
          <FeedbackPressable accessibilityRole="button" disabled={isCreating} style={styles.row} onPress={() => void selectQuery()}>
            {isCreating ? <ActivityIndicator color={colors.text} />
              : <MaterialDesignIcons name="tag-plus-outline" size={20} color={colors.text} accessible={false} />}
            <Text style={styles.action}>{t('tag.create', { name: query.trim() })}</Text>
          </FeedbackPressable>
        ) : undefined}
        ListEmptyComponent={(!queryKey || (exactTag && attachedIds.includes(exactTag.id))) ? (
          <Text style={styles.empty}>{t(tags.length ? 'tag.noAvailable' : 'tag.empty')}</Text>
        ) : undefined}
        renderSectionHeader={({ section }) => section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
        renderItem={({ item }) => {
          const selected = selectedIds.has(item.id);
          return (
            <FeedbackPressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: isCreating }}
              feedback="none" disabled={isCreating} style={[styles.row, styles.tagRow, selected && styles.selected]}
              onPress={() => toggleTag(item.id)}>
              <MaterialDesignIcons name="pound" size={18} color={colors.textMuted} accessible={false} />
              <Text style={styles.name}>{item.name}</Text>
              <SelectionCheck selected={selected} />
            </FeedbackPressable>
          );
        }} />
    </BottomSheet>
  );
}

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, gap: spacing.xs },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  headerSide: { minWidth: 64, alignItems: 'flex-end' },
  doneButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 10 },
  action: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  search: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginHorizontal: spacing.md, marginVertical: spacing.sm,
    paddingHorizontal: spacing.sm, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  input: { flex: 1, minHeight: 46, paddingVertical: spacing.xs, color: colors.text, fontSize: 16 },
  list: { flex: 1, paddingHorizontal: spacing.md },
  sectionTitle: { color: colors.textMuted, fontSize: 13, fontWeight: '600', paddingTop: spacing.md, paddingBottom: spacing.xs },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: TAG_ICON_GAP, paddingHorizontal: spacing.sm, borderRadius: 10 },
  tagRow: { marginVertical: 2 },
  selected: { backgroundColor: colors.sageLight },
  name: { flex: 1, color: colors.text, fontSize: 16 },
  empty: { padding: spacing.md, textAlign: 'center', color: colors.textMuted },
  error: { marginHorizontal: spacing.md, marginBottom: spacing.xs, color: colors.error },
}));
