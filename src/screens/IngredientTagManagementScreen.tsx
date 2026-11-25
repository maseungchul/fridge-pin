/**
 * @file
 * 더보기에서 공용 재료 태그의 이름을 변경하거나 삭제한다.
 * 태그를 삭제할 때는 연결된 재료에도 반영된다는 점을 먼저 안내한다.
 */
import { useIsFocused, usePreventRemove } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { FormTextInput } from '@/components/FormTextInput';
import { PrimaryButton } from '@/components/PrimaryButton';
import { deleteIngredientTag, getIngredientTagOptions, saveIngredientTag } from '@/db/ingredientTagRepository';
import type { IngredientTag } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_TAG_NAME_MAX_LENGTH } from '@/features/ingredient/model/ingredient';
import { getErrorMessage } from '@/i18n/errors';
import { useTranslation } from '@/i18n/LanguageProvider';
import type { MoreStackParamList } from '@/navigation/MoreStackNavigator';
import { COMPACT_HEADER_ICON_SIZE, HEADER_CONTENT_HEIGHT, getCompactHeaderStyles } from '@/theme/headerStyles';
import { useAppTheme } from '@/theme/ThemeProvider';
import { createThemedStyles, spacing } from '@/theme/tokens';

export function IngredientTagManagementScreen({ navigation }: NativeStackScreenProps<MoreStackParamList, 'IngredientTags'>) {
  const { colors, mode } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const isFocused = useIsFocused();
  const [tags, setTags] = useState<IngredientTag[] | null>(null);
  const [editing, setEditing] = useState<IngredientTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const saving = useRef(false);

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

  function renameTag(tag: IngredientTag) {
    Keyboard.dismiss();
    void runMutation(async () => {
      const updated = await saveIngredientTag(db, tag.name, tag.id);
      setTags(current => current?.map(item => item.id === updated.id ? updated : item)
        .sort((a, b) => a.name.localeCompare(b.name)) ?? null);
      setEditing(null);
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
        <View style={styles.header}>
          <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('more.back')}
            disabled={busy} onPress={() => navigation.goBack()} style={styles.backButton}>
            <MaterialDesignIcons name="arrow-left" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
          </FeedbackPressable>
          <Text accessibilityRole="header" style={styles.title}>{t('tag.manageTitle')}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {loadError ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>{t('tag.loadError')}</Text>
              <PrimaryButton label={t('common.retry')} onPress={() => {
                setLoadError(false);
                setLoadAttempt(current => current + 1);
              }} />
            </>
          ) : !tags ? <ActivityIndicator color={colors.text} accessibilityLabel={t('common.loading')} /> : editing ? (
            <>
              <FormTextInput label={t('tag.renameTitle')} accessibilityLabel={t('tag.name')} value={editing.name}
                maxLength={INGREDIENT_TAG_NAME_MAX_LENGTH} editable={!busy} autoFocus autoCorrect={false}
                onChangeText={name => { setEditing({ ...editing, name }); setError(null); }} />
              <View style={styles.buttons}>
                <PrimaryButton style={styles.button} variant="secondary" label={t('common.cancel')} disabled={busy} onPress={() => {
                  Keyboard.dismiss();
                  setEditing(null);
                  setError(null);
                }} />
                <PrimaryButton style={styles.button} label={t('common.ok')} loading={busy} disabled={!editing.name.trim()}
                  onPress={() => renameTag(editing)} />
              </View>
            </>
          ) : tags.length ? tags.map(tag => (
            <View key={tag.id} style={styles.row}>
              <MaterialDesignIcons name="pound" size={18} color={colors.textMuted} accessible={false} />
              <Text numberOfLines={1} style={styles.name}>{tag.name}</Text>
              <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('tag.rename', { name: tag.name })}
                disabled={busy} style={styles.iconButton} onPress={() => { setError(null); setEditing(tag); }}>
                <MaterialDesignIcons name="pencil-outline" size={20} color={colors.text} accessible={false} />
              </FeedbackPressable>
              <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('tag.delete', { name: tag.name })}
                disabled={busy} style={styles.iconButton} onPress={() => confirmDelete(tag)}>
                <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} accessible={false} />
              </FeedbackPressable>
            </View>
          )) : <Text style={styles.empty}>{t('tag.empty')}</Text>}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{getErrorMessage(error.cause, t, t('tag.saveError'))}</Text> : null}
        </ScrollView>
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
  content: { padding: spacing.md },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { flex: 1, color: colors.text, fontSize: 16 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.md },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  button: { flex: 1 },
  error: { color: colors.error, marginVertical: spacing.sm },
}));
