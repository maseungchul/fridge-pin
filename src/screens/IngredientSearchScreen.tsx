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
import { getIngredientExpirationStatus } from '@/features/ingredient/model/ingredient';
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

export function IngredientSearchScreen({ navigation, onSelectIngredient }: IngredientSearchScreenProps) {
  const { mode, colors, ingredientBadgeColors } = useAppTheme();
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
            <Text style={styles.summary} accessibilityLiveRegion="polite">{t('search.resultCount', { count: results.length })}</Text>
            <FlatList data={results} keyExtractor={item => item.ingredient.id} style={styles.list}
              keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
              renderItem={({ item: { ingredient, path } }) => {
                const expiration = getIngredientExpirationStatus(ingredient.expirationDate, new Date(), t);
                const expirationColor = ingredientBadgeColors[ingredient.expirationDate === null ? 'unknown'
                  : expiration.isExpired ? 'expired' : expiration.isUrgent ? 'warning' : 'normal'];
                return (
                  <FeedbackPressable accessibilityRole="button" accessibilityState={{ disabled: isPending }} interactionBlocked={isPending}
                    onPress={() => closeSearch(ingredient.id)}>
                    <IngredientLocationBreadcrumb path={path} />
                    <View style={styles.result}>
                      <View style={styles.resultInfo}>
                        <Text style={styles.name}>{ingredient.name}</Text>
                        <Text style={styles.detail}>{ingredient.quantity}</Text>
                      </View>
                      <Text style={[styles.expiration, { color: expirationColor }]}>{expiration.label}</Text>
                      <MaterialDesignIcons name="chevron-right" size={20} color={colors.textMuted} accessible={false} />
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
  summary: { color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.lg },
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  resultInfo: { flex: 1, minWidth: 0, gap: spacing.xs },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  detail: { color: colors.textMuted, fontSize: 13 },
  expiration: { fontSize: 13, fontVariant: ['tabular-nums'] },
  searchBar: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.sm,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  input: { flex: 1, minHeight: 46, color: colors.text, fontSize: 16, paddingRight: spacing.sm, paddingVertical: spacing.xs },
  clearButton: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
}));
