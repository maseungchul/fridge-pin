/**
 * @file
 * 재료 이름을 검색하고 보관 위치와 유통기한을 표시한다.
 * 선택한 재료 ID를 홈에 전달하면 홈이 현재 보관 위치를 찾아 연다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { PrimaryButton } from '@/components/PrimaryButton';
import { getIngredients, getUnassignedIngredients } from '@/db/ingredientRepository';
import { getRefrigerator } from '@/db/refrigeratorRepository';
import { useSQLiteContext } from 'expo-sqlite';
import { getDraftLayout, getIngredientLocationPath } from '@/features/fridge/model/fridgeLayout';
import type { Refrigerator } from '@/features/fridge/model/fridgeLayout';
import { IngredientLocationBreadcrumb } from '@/features/ingredient/components/IngredientLocationBreadcrumb';
import type { Ingredient } from '@/features/ingredient/model/ingredient';
import { useTranslation } from '@/i18n/LanguageProvider';
import { useDelayedLoading } from '@/hooks/useDelayedLoading';
import type { RootStackParamList } from '@/navigation/RootNavigator';
import { COMPACT_HEADER_ICON_SIZE, HEADER_CONTENT_HEIGHT, getCompactHeaderStyles } from '@/theme/headerStyles';
import { useAppTheme } from '@/theme/ThemeProvider';
import { createThemedStyles, spacing } from '@/theme/tokens';

const SEARCH_DELAY_MS = 250;

type IngredientSearchScreenProps = NativeStackScreenProps<RootStackParamList, 'IngredientSearch'> & {
  onSelectIngredient: (id: string) => void;
};

function normalizeSearchText(text: string) {
  return text.trim().normalize('NFKC').toLowerCase();
}

/** 정규화로 문자 길이가 달라져도 화면에는 원래 재료명을 유지한다. */
function highlightName(name: string, query: string, styles: ReturnType<typeof getStyles>) {
  const normalized = normalizeSearchText(name);
  const ranges: { start: number; end: number }[] = [];
  let index = normalized.indexOf(query);
  while (index !== -1) {
    ranges.push({ start: index, end: index + query.length });
    index = normalized.indexOf(query, index + query.length);
  }
  if (!ranges.length) return <Text style={styles.name}>{name}</Text>;
  const characters = Array.from(name);
  const parts: { text: string; matched: boolean }[] = [];
  let offset = 0;
  for (const character of characters) {
    const length = character.normalize('NFKC').toLowerCase().length;
    const matched = ranges.some(range => offset < range.end && offset + length > range.start);
    const last = parts[parts.length - 1];
    if (last?.matched === matched) last.text += character;
    else parts.push({ text: character, matched });
    offset += length;
  }
  return parts.map((part, partIndex) => (
    <View key={partIndex} style={styles.namePart}>
      <Text style={[styles.name, part.matched && styles.highlight]}>{part.text}</Text>
      {part.matched ? <View pointerEvents="none" style={styles.highlightLine} /> : null}
    </View>
  ));
}

export function IngredientSearchScreen({ navigation, onSelectIngredient }: IngredientSearchScreenProps) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { showLoading, runLoad } = useDelayedLoading();
  const [data, setData] = useState<{ refrigerator: Refrigerator | null; ingredients: Ingredient[]; unassigned: Ingredient[] } | null>(null);
  const [hasError, setHasError] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const leaving = useRef(false);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const normalizedQuery = normalizeSearchText(query);
  const isPending = normalizedQuery !== appliedQuery;
  const searchText = normalizedQuery ? appliedQuery : '';

  const loadIngredients = useCallback(() => runLoad(async isCurrent => {
    setHasError(false);
    try {
      const refrigerator = await getRefrigerator(db);
      const [ingredients, unassigned] = refrigerator ? await Promise.all([getIngredients(db), getUnassignedIngredients(db)]) : [[], []];
      if (isCurrent()) setData({ refrigerator, ingredients, unassigned });
    } catch {
      if (isCurrent()) setHasError(true);
    }
  }), [db, runLoad]);

  useEffect(() => { void loadIngredients(); }, [loadIngredients]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    // iOS에서는 화면 전환 중에 키보드를 열면 시스템 테마가 먼저 보일 수 있다.
    return navigation.addListener('transitionEnd', ({ data }) => {
      if (!data.closing && !leaving.current) input.current?.focus();
    });
  }, [navigation]);

  useEffect(() => {
    if (!normalizedQuery) return;
    const timer = setTimeout(() => setAppliedQuery(normalizedQuery), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [normalizedQuery]);

  const results = useMemo(() => {
    if (!searchText || !data?.refrigerator) return [];
    const layout = getDraftLayout(data.refrigerator, [], t);
    const placed = data.ingredients.flatMap(ingredient => {
      if (!normalizeSearchText(ingredient.name).includes(searchText)) return [];
      const path = getIngredientLocationPath(layout, ingredient, t);
      return path ? [{ ingredient, path }] : [];
    });
    const unassigned = data.unassigned.filter(item => normalizeSearchText(item.name).includes(searchText))
      .map(ingredient => ({ ingredient, path: [t('unassigned.label')] }));
    return [...placed, ...unassigned].sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name));
  }, [data, searchText, t]);

  function changeQuery(value: string) {
    setQuery(value);
    if (!value.trim()) setAppliedQuery('');
  }

  function closeSearch(ingredientId?: string) {
    if (leaving.current) return;
    leaving.current = true;
    if (ingredientId !== undefined) onSelectIngredient(ingredientId);
    Keyboard.dismiss();
    navigation.goBack();
  }

  return (
    <SafeAreaView style={styles.screen} onAccessibilityEscape={() => closeSearch()}>
      <KeyboardAvoidingView style={styles.content} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('search.back')}
            onPress={() => closeSearch()} style={styles.backButton}>
            <MaterialDesignIcons name="arrow-left" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
          </FeedbackPressable>
          <View style={styles.searchBar}>
            <MaterialDesignIcons name="magnify" size={22} color={colors.textMuted} accessible={false} />
            <TextInput ref={input} value={query} onChangeText={changeQuery} style={styles.input} autoFocus={Platform.OS !== 'ios'}
              accessibilityLabel={t('search.placeholder')} placeholder={t('search.placeholder')} placeholderTextColor={colors.textMuted}
              keyboardAppearance={mode} autoCorrect={false} returnKeyType="done" />
            {query ? <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('search.clear')}
              onPress={() => { changeQuery(''); input.current?.focus(); }} style={styles.clearButton}>
              <MaterialDesignIcons name="close-circle-outline" size={22} color={colors.textMuted} accessible={false} />
            </FeedbackPressable> : null}
          </View>
        </View>
        {hasError ? <View style={styles.feedback}>
          <Text style={styles.empty} accessibilityRole="alert">{t('ingredient.loadError')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={loadIngredients} />
        </View> : !data ? (showLoading ? <ActivityIndicator color={colors.text} accessibilityLabel={t('common.loading')} /> : null)
          : results.length > 0 ? <>
            <View style={styles.summary} accessible accessibilityRole="header" accessibilityLiveRegion="polite"
              accessibilityLabel={t('search.resultCount', { count: results.length })}>
              <Text style={styles.summaryLabel}>{t('search.results')}</Text>
              <View style={styles.countBadge}><Text style={styles.resultCount}>{results.length}</Text></View>
            </View>
            <FlatList data={results} keyExtractor={item => item.ingredient.id} style={styles.list}
              keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
              renderItem={({ item: { ingredient, path } }) => {
                return (
                  <FeedbackPressable accessibilityRole="button" accessibilityState={{ disabled: isPending }} interactionBlocked={isPending}
                    onPress={() => closeSearch(ingredient.id)}>
                    <IngredientLocationBreadcrumb path={path} />
                    <View style={styles.result} accessible accessibilityLabel={`${ingredient.name}, ${ingredient.quantity}`}>
                      {highlightName(ingredient.name, searchText, styles)}
                      <Text style={styles.quantity}>{ingredient.quantity}</Text>
                    </View>
                  </FeedbackPressable>
                );
              }} />
          </> : appliedQuery && !isPending ? (
            <Text style={styles.empty} accessibilityLiveRegion="polite">{t('search.noResults')}</Text>
          ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const getStyles = createThemedStyles(({ colors }, mode) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
  header: { ...getCompactHeaderStyles(mode).header, gap: spacing.xs },
  backButton: { width: HEADER_CONTENT_HEIGHT, height: HEADER_CONTENT_HEIGHT, marginLeft: -spacing.sm,
    alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  list: { flex: 1 },
  feedback: { alignItems: 'center', paddingHorizontal: spacing.md },
  summary: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  summaryLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  countBadge: { minWidth: 22, minHeight: 22, paddingHorizontal: spacing.xs, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  resultCount: { color: colors.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.lg },
  result: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', paddingHorizontal: spacing.md,
    paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 16 },
  quantity: { color: colors.text, fontSize: 14, marginLeft: spacing.sm },
  namePart: { position: 'relative', flexShrink: 1 },
  highlight: { fontWeight: '700', color: colors.chilled },
  highlightLine: { position: 'absolute', left: 0, right: 0, bottom: -3, height: 1.5, borderRadius: 1, backgroundColor: colors.chilled },
  searchBar: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.sm,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  input: { flex: 1, minHeight: 46, color: colors.text, fontSize: 16, paddingRight: spacing.sm, paddingVertical: spacing.xs },
  clearButton: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
}));
