/**
 * @file
 * 검색 모드에 맞춰 재료 이름 또는 태그를 검색하고 보관 위치를 표시한다.
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
import { getSearchableIngredientTags } from '@/db/ingredientTagRepository';
import { getRefrigerator } from '@/db/refrigeratorRepository';
import { useSQLiteContext } from 'expo-sqlite';
import { getDraftLayout, getIngredientLocationPath } from '@/features/fridge/model/fridgeLayout';
import type { Refrigerator } from '@/features/fridge/model/fridgeLayout';
import { IngredientLocationBreadcrumb } from '@/features/ingredient/components/IngredientLocationBreadcrumb';
import { normalizeIngredientSearchText } from '@/features/ingredient/model/ingredient';
import type { Ingredient, IngredientTag } from '@/features/ingredient/model/ingredient';
import { useTranslation } from '@/i18n/LanguageProvider';
import { useDelayedLoading } from '@/hooks/useDelayedLoading';
import type { RootStackParamList } from '@/navigation/RootNavigator';
import { COMPACT_HEADER_ICON_SIZE, HEADER_CONTENT_HEIGHT, getCompactHeaderStyles } from '@/theme/headerStyles';
import { useAppTheme } from '@/theme/ThemeProvider';
import { TAG_ICON_GAP, createThemedStyles, spacing } from '@/theme/tokens';

const SEARCH_DELAY_MS = 250;
const SEARCH_ROW_HEIGHT = 46;
const SEARCH_TEXT_LINE_HEIGHT = 22;
const TAG_SEARCH_PREFIX = '# ';
// 화면에는 아이콘을 보여주되, 백스페이스로 지울 수 있는 문자는 입력창에 남긴다.
const TAG_SEARCH_MARKER = '\u200B';

type SearchMode = 'name' | 'tag';
const EMPTY_TERMS: readonly string[] = [];

type IngredientSearchScreenProps = NativeStackScreenProps<RootStackParamList, 'IngredientSearch'> & {
  onSelectIngredient: (id: string) => void;
};

/** 넓은 조건이 먼저 태그를 골랐어도 다른 후보로 옮겨 각 조건에 별도 태그를 배정한다. */
function matchesDistinctTags(terms: readonly string[], candidates: Map<string, string[]>) {
  const assignedTerms = new Map<string, string>();

  function assign(term: string, visited: Set<string>): boolean {
    for (const id of candidates.get(term) ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      const previous = assignedTerms.get(id);
      if (previous !== undefined && !assign(previous, visited)) continue;
      assignedTerms.set(id, term);
      return true;
    }
    return false;
  }

  return terms.every(term => assign(term, new Set<string>()));
}

/** 정규화로 문자 길이가 달라져도 화면에는 원래 재료명과 태그명을 유지한다. */
function highlightName(name: string, queries: readonly string[], styles: ReturnType<typeof getStyles>, isTag = false) {
  const normalized = normalizeIngredientSearchText(name);
  const ranges: { start: number; end: number }[] = [];
  for (const query of queries) {
    let index = normalized.indexOf(query);
    while (index !== -1) {
      ranges.push({ start: index, end: index + query.length });
      index = normalized.indexOf(query, index + query.length);
    }
  }
  if (!ranges.length) return <Text style={isTag ? styles.matchTagText : styles.name}>{name}</Text>;
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
      <Text style={[isTag ? styles.matchTagText : styles.name, part.matched && styles.highlight]}>{part.text}</Text>
      {part.matched ? <View pointerEvents="none" style={[styles.highlightLine, isTag && styles.tagHighlightLine]} /> : null}
    </View>
  ));
}

export function IngredientSearchScreen({ navigation, onSelectIngredient }: IngredientSearchScreenProps) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { showLoading, runLoad } = useDelayedLoading();
  const [data, setData] = useState<{ refrigerator: Refrigerator | null; ingredients: Ingredient[]; unassigned: Ingredient[];
    tags: (IngredientTag & { ingredientId: string })[] } | null>(null);
  const [hasError, setHasError] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const leaving = useRef(false);
  const [query, setQuery] = useState('');
  const [completedTagTerms, setCompletedTagTerms] = useState<string[]>([]);
  const [appliedSearch, setAppliedSearch] = useState<{ mode: SearchMode; terms: readonly string[] } | null>(null);
  const isTagSearch = query.startsWith(TAG_SEARCH_MARKER);
  const searchMode: SearchMode = isTagSearch ? 'tag' : 'name';
  const queryText = isTagSearch ? query.slice(TAG_SEARCH_MARKER.length) : query;
  const currentTerms = useMemo(() => [...new Set([...completedTagTerms, queryText]
    .map(normalizeIngredientSearchText).filter(Boolean))], [completedTagTerms, queryText]);
  const searchTerms = currentTerms.length && appliedSearch?.mode === searchMode ? appliedSearch.terms : EMPTY_TERMS;
  const isPending = currentTerms.length !== searchTerms.length || currentTerms.some((term, index) => term !== searchTerms[index]);
  const searchLabel = t(isTagSearch ? 'search.tagPlaceholder' : 'search.placeholder');

  const loadIngredients = useCallback(() => runLoad(async isCurrent => {
    setHasError(false);
    try {
      const refrigerator = await getRefrigerator(db);
      const [ingredients, unassigned, tags] = refrigerator
        ? await Promise.all([getIngredients(db), getUnassignedIngredients(db), getSearchableIngredientTags(db)]) : [[], [], []];
      if (isCurrent()) setData({ refrigerator, ingredients, unassigned, tags });
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
    if (!currentTerms.length) return;
    const timer = setTimeout(() => setAppliedSearch({ mode: searchMode, terms: currentTerms }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [currentTerms, searchMode]);

  const results = useMemo(() => {
    if (!searchTerms.length || !data?.refrigerator) return [];
    const layout = getDraftLayout(data.refrigerator, [], t);
    const tagsByIngredient = new Map<string, { tags: IngredientTag[]; candidates: Map<string, string[]> }>();
    if (isTagSearch) {
      for (const tag of data.tags) {
        const name = normalizeIngredientSearchText(tag.name);
        const terms = searchTerms.filter(term => name.includes(term));
        const match = tagsByIngredient.get(tag.ingredientId) ?? { tags: [], candidates: new Map<string, string[]>() };
        match.tags.push(tag);
        for (const term of terms) {
          const ids = match.candidates.get(term) ?? [];
          ids.push(tag.id);
          match.candidates.set(term, ids);
        }
        tagsByIngredient.set(tag.ingredientId, match);
      }
    }
    function findMatches(ingredients: Ingredient[], getPath: (ingredient: Ingredient) => string[] | null) {
      return ingredients.flatMap(ingredient => {
        const tagMatch = tagsByIngredient.get(ingredient.id);
        const matches = isTagSearch ? !!tagMatch && matchesDistinctTags(searchTerms, tagMatch.candidates)
          : normalizeIngredientSearchText(ingredient.name).includes(searchTerms[0]);
        if (!matches) return [];
        const path = getPath(ingredient);
        return path ? [{ ingredient, path, tags: tagMatch?.tags ?? [] }] : [];
      });
    }
    return [
      ...findMatches(data.ingredients, ingredient => getIngredientLocationPath(layout, ingredient, t)),
      ...findMatches(data.unassigned, () => [t('unassigned.label')]),
    ].sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name));
  }, [data, isTagSearch, searchTerms, t]);

  function changeQuery(value: string) {
    if (!value && isTagSearch && completedTagTerms.length) {
      // 빈 태그 조건을 지우면 직전 조건으로 돌아가 다시 편집할 수 있게 한다.
      setQuery(TAG_SEARCH_MARKER + completedTagTerms[completedTagTerms.length - 1]);
      setCompletedTagTerms(completedTagTerms.slice(0, -1));
      return;
    }
    const prefix = value.startsWith(TAG_SEARCH_MARKER) ? TAG_SEARCH_MARKER : TAG_SEARCH_PREFIX;
    if (value.startsWith(prefix)) {
      const segments = value.slice(prefix.length).split(TAG_SEARCH_PREFIX);
      const nextText = segments.pop() ?? '';
      const newTerms = segments.map(term => term.trim()).filter(Boolean);
      if (newTerms.length) setCompletedTagTerms([...completedTagTerms, ...newTerms]);
      setQuery(TAG_SEARCH_MARKER + nextText);
      if (!isTagSearch || (!nextText.trim() && !completedTagTerms.length && !newTerms.length)) setAppliedSearch(null);
      return;
    }
    if (completedTagTerms.length) setCompletedTagTerms([]);
    setQuery(value);
    if (isTagSearch || !value.trim()) setAppliedSearch(null);
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
            <View style={styles.searchFields}>
              {completedTagTerms.map((term, index) => (
                <View key={index} style={styles.searchTag}>
                  <MaterialDesignIcons name="pound" size={18} color={colors.chilled} accessible={false} />
                  <Text style={styles.searchTagText} numberOfLines={1}>{term}</Text>
                </View>
              ))}
              <View style={styles.activeSearchField}>
                {isTagSearch ? <MaterialDesignIcons name="pound" size={18} color={colors.chilled} accessible={false} /> : null}
                <View style={[styles.inputContainer, isTagSearch && styles.tagInput]}>
                  {isTagSearch && !queryText ? <Text pointerEvents="none" accessible={false} style={styles.tagPlaceholder}>{searchLabel}</Text> : null}
                  <TextInput ref={input} value={query} onChangeText={changeQuery} style={[styles.input, isTagSearch && styles.tagInputText]}
                    autoFocus={Platform.OS !== 'ios'} accessibilityLabel={searchLabel}
                    placeholder={searchLabel} placeholderTextColor={colors.textMuted}
                    keyboardAppearance={mode} autoCorrect={false} returnKeyType="done" />
                </View>
              </View>
            </View>
            {query ? <FeedbackPressable iconFeedback accessibilityRole="button"
              accessibilityLabel={t(isTagSearch && !queryText && !completedTagTerms.length ? 'search.exitTagMode' : 'search.clear')}
              onPress={() => { changeQuery(isTagSearch && queryText ? TAG_SEARCH_MARKER : ''); input.current?.focus(); }}
              style={styles.clearButton}>
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
              renderItem={({ item: { ingredient, path, tags } }) => {
                return (
                  <FeedbackPressable accessibilityRole="button" accessibilityState={{ disabled: isPending }} interactionBlocked={isPending}
                    onPress={() => closeSearch(ingredient.id)}>
                    <IngredientLocationBreadcrumb path={path} />
                    <View style={styles.result} accessible accessibilityLabel={[ingredient.name, ingredient.quantity, ...tags.map(tag => tag.name)].join(', ')}>
                      <View style={styles.resultDetails}>
                        <View style={styles.resultText}>
                          {isTagSearch ? <Text style={styles.name}>{ingredient.name}</Text> : highlightName(ingredient.name, searchTerms, styles)}
                          <Text style={styles.quantity}>{ingredient.quantity}</Text>
                        </View>
                        {tags.length > 0 ? <View style={styles.matchTags}>
                          {tags.map(tag => <View key={tag.id} style={styles.matchTag}>
                            <MaterialDesignIcons name="pound" style={styles.resultTagIcon} size={14} color={colors.textMuted} accessible={false} />
                            {highlightName(tag.name, searchTerms, styles, true)}
                          </View>)}
                        </View> : null}
                      </View>
                      <MaterialDesignIcons name="map-marker-right-outline" size={22} color={colors.textMuted} accessible={false} />
                    </View>
                  </FeedbackPressable>
                );
              }} />
          </> : searchTerms.length > 0 && !isPending ? (
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
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md,
    paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  resultDetails: { flex: 1, minWidth: 0 },
  resultText: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' },
  matchTags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  matchTag: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 12, paddingHorizontal: spacing.xs, paddingVertical: 3 },
  resultTagIcon: { marginRight: TAG_ICON_GAP },
  matchTagText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  name: { color: colors.text, fontSize: 16 },
  quantity: { color: colors.text, fontSize: 14, marginLeft: spacing.sm },
  namePart: { position: 'relative', flexShrink: 1 },
  highlight: { fontWeight: '700', color: colors.chilled },
  highlightLine: { position: 'absolute', left: 0, right: 0, bottom: -3, height: 1.5, borderRadius: 1, backgroundColor: colors.chilled },
  tagHighlightLine: { bottom: -1 },
  searchBar: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.sm,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  searchFields: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: 4,
    paddingVertical: (SEARCH_ROW_HEIGHT - SEARCH_TEXT_LINE_HEIGHT) / 2 },
  searchTag: { minHeight: SEARCH_TEXT_LINE_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: TAG_ICON_GAP, maxWidth: '100%' },
  searchTagText: { flexShrink: 1, fontSize: 16, lineHeight: SEARCH_TEXT_LINE_HEIGHT, color: colors.chilled },
  activeSearchField: { flexGrow: 1, flexBasis: 100, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inputContainer: { flex: 1, minWidth: 0, justifyContent: 'center' },
  // 입력 글자의 기준선은 네이티브 한 줄 입력에 맡기고 검색 행 안에서 가운데에 둔다.
  input: { height: SEARCH_TEXT_LINE_HEIGHT, color: colors.text, fontSize: 16,
    paddingRight: spacing.sm, paddingVertical: 0, includeFontPadding: false, textAlignVertical: 'center' },
  tagInput: { marginLeft: TAG_ICON_GAP - spacing.sm },
  tagInputText: { color: colors.chilled },
  tagPlaceholder: { position: 'absolute', left: 0, color: mode === 'dark' ? '#83A590' : colors.chilledPressed,
    fontSize: 16, lineHeight: SEARCH_TEXT_LINE_HEIGHT },
  clearButton: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
}));
