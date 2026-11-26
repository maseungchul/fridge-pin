/**
 * @file
 * 더보기에서 공용 재료 태그의 이름을 변경하거나 삭제한다.
 * 불러온 태그에 이름 검색을 적용해 편집할 태그를 찾는다.
 * 태그를 삭제할 때는 연결된 재료에도 반영된다는 점을 먼저 안내한다.
 */
import { useIsFocused, usePreventRemove } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { PrimaryButton } from '@/components/PrimaryButton';
import { deleteIngredientTag, getIngredientTagOptions, saveIngredientTag } from '@/db/ingredientTagRepository';
import type { IngredientTag } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_TAG_NAME_MAX_LENGTH, normalizeIngredientSearchText } from '@/features/ingredient/model/ingredient';
import { getErrorMessage } from '@/i18n/errors';
import { useTranslation } from '@/i18n/LanguageProvider';
import type { MoreStackParamList } from '@/navigation/MoreStackNavigator';
import { COMPACT_HEADER_ICON_SIZE, HEADER_CONTENT_HEIGHT, getCompactHeaderStyles } from '@/theme/headerStyles';
import { useAppTheme } from '@/theme/ThemeProvider';
import { TAG_ICON_GAP, createThemedStyles, spacing } from '@/theme/tokens';

export function IngredientTagManagementScreen({ navigation }: NativeStackScreenProps<MoreStackParamList, 'IngredientTags'>) {
  const { colors, mode } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const isFocused = useIsFocused();
  const [tags, setTags] = useState<IngredientTag[] | null>(null);
  const [query, setQuery] = useState('');
  const [inputRevision, setInputRevision] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const saving = useRef(false);
  const queryKey = normalizeIngredientSearchText(query);
  const visibleTags = queryKey ? tags?.filter(tag => normalizeIngredientSearchText(tag.name).includes(queryKey)) : tags;

  useEffect(() => {
    if (!isFocused) return;
    let active = true;
    void getIngredientTagOptions(db).then(result => {
      if (!active) return;
      setTags(result);
      setLoadError(false);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [db, isFocused, loadAttempt]);

  usePreventRemove(busy, () => {});

  async function runMutation(mutate: () => Promise<void>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await mutate();
    } catch (cause) {
      setError({ cause });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function renameTag(tag: IngredientTag, input: string) {
    if (input === tag.name) return;
    void runMutation(async () => {
      try {
        if (input.trim() === tag.name) return;
        const updated = await saveIngredientTag(db, input, tag.id);
        setTags(current => current?.map(item => item.id === updated.id ? updated : item)
          .sort((a, b) => a.name.localeCompare(b.name)) ?? null);
      } finally {
        // 입력을 마치면 성공 여부에 따라 화면에 저장된 이름을 다시 표시한다.
        setInputRevision(current => ({ ...current, [tag.id]: (current[tag.id] ?? 0) + 1 }));
      }
    });
  }

  function confirmDelete(tag: IngredientTag) {
    Alert.alert(t('tag.delete', { name: tag.name }), t('tag.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: () => void runMutation(async () => {
        await deleteIngredientTag(db, tag.id);
        setTags(current => current?.filter(item => item.id !== tag.id) ?? null);
      }) },
    ]);
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.header} accessible={false} onPress={Keyboard.dismiss}>
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('more.back')}
            disabled={busy} onPress={() => navigation.goBack()} style={styles.backButton}>
            <MaterialDesignIcons name="arrow-left" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
          </FeedbackPressable>
          <Text accessibilityRole="header" style={styles.title}>{t('tag.manageTitle')}</Text>
        </Pressable>
        {tags?.length && !loadError ? (
          <TextInput style={styles.search} value={query} onChangeText={setQuery}
            accessibilityLabel={t('search.tagPlaceholder')} placeholder={t('search.tagPlaceholder')}
            placeholderTextColor={colors.textMuted} keyboardAppearance={mode} autoCorrect={false} returnKeyType="search" />
        ) : null}
        {error ? <Text accessibilityRole="alert" style={[styles.error, styles.saveError]}>{getErrorMessage(error.cause, t, t('tag.saveError'))}</Text> : null}
        <FlatList data={loadError ? [] : visibleTags ?? []} keyExtractor={tag => tag.id}
          contentContainerStyle={styles.content} keyboardShouldPersistTaps="never"
          ListEmptyComponent={
          loadError ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>{t('tag.loadError')}</Text>
              <PrimaryButton label={t('common.retry')} onPress={() => {
                setLoadError(false);
                setLoadAttempt(current => current + 1);
              }} />
            </>
          ) : !tags ? <ActivityIndicator color={colors.text} accessibilityLabel={t('common.loading')} />
            : <Text style={styles.empty}>{t(tags.length ? 'tag.noResults' : 'tag.empty')}</Text>
          }
          renderItem={({ item: tag }) => (
            <View style={styles.row}>
              <MaterialDesignIcons name="pound" size={18} color={colors.textMuted} accessible={false} />
              <TextInput key={inputRevision[tag.id] ?? 0} style={styles.name} defaultValue={tag.name}
                accessibilityLabel={t('tag.rename', { name: tag.name })} maxLength={INGREDIENT_TAG_NAME_MAX_LENGTH}
                editable={!busy} keyboardAppearance={mode} autoCorrect={false} returnKeyType="done" submitBehavior="blurAndSubmit"
                onFocus={() => setError(null)} onEndEditing={({ nativeEvent }) => renameTag(tag, nativeEvent.text)} />
              <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('tag.delete', { name: tag.name })}
                feedback="danger" disabled={busy} style={styles.iconButton} onPress={() => confirmDelete(tag)}>
                <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} accessible={false} />
              </FeedbackPressable>
            </View>
          )} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const getStyles = createThemedStyles(({ colors }, mode) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { ...getCompactHeaderStyles(mode).header, gap: 0 },
  title: getCompactHeaderStyles(mode).title,
  backButton: { width: HEADER_CONTENT_HEIGHT, height: HEADER_CONTENT_HEIGHT, marginLeft: -spacing.sm,
    alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  content: { flexGrow: 1, padding: spacing.md },
  search: { minHeight: 44, marginHorizontal: spacing.md, marginTop: spacing.md, paddingHorizontal: spacing.md,
    paddingVertical: 0, includeFontPadding: false, textAlignVertical: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 12, color: colors.text, fontSize: 16 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: TAG_ICON_GAP,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { flex: 1, minHeight: 44, paddingVertical: 0, color: colors.text, fontSize: 16 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.md },
  error: { color: colors.error, marginVertical: spacing.sm },
  saveError: { marginHorizontal: spacing.md },
}));
