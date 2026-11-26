/**
 * @file
 * 재료 등록·편집을 독립 화면에서 처리하고 키보드에 맞춰 입력 영역만 스크롤한다.
 * 입력 초안·저장 결과는 홈 복귀에 사용하며, 저장 성공 시 안내를 표시하고 이전 화면으로 돌아간다.
 */
import { usePreventRemove } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { useSQLiteContext } from 'expo-sqlite';
import Storage from 'expo-sqlite/kv-store';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { FormTextInput } from '@/components/FormTextInput';
import { useToast } from '@/components/ToastProvider';
import { registerIngredient, updateIngredient } from '@/db/ingredientRepository';
import { getIngredientTagOptions } from '@/db/ingredientTagRepository';
import type { BottomSheetRef } from '@/features/ingredient/components/BottomSheet';
import { IngredientExpirationCalendar } from '@/features/ingredient/components/IngredientExpirationCalendar';
import { IngredientTagPickerSheet } from '@/features/ingredient/components/IngredientTagPickerSheet';
import type { Ingredient, IngredientTag } from '@/features/ingredient/model/ingredient';
import { INGREDIENT_MEMO_MAX_LENGTH, INGREDIENT_NAME_MAX_LENGTH, INGREDIENT_QUANTITY_MAX_LENGTH } from '@/features/ingredient/model/ingredient';
import { useTranslation } from '@/i18n/LanguageProvider';
import { getErrorMessage } from '@/i18n/errors';
import { formatDate } from '@/i18n/translations';
import type { RootStackParamList } from '@/navigation/RootNavigator';
import { HEADER_CONTENT_HEIGHT, COMPACT_HEADER_ICON_INSET, COMPACT_HEADER_ICON_SIZE, getCompactHeaderStyles } from '@/theme/headerStyles';
import { TAG_ICON_GAP, spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';

const RECENT_TAGS_KEY = 'ingredient.recentTagIds';

async function readRecentTagIds(): Promise<string[]> {
  try {
    const stored: unknown = JSON.parse(await Storage.getItem(RECENT_TAGS_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

type IngredientFormScreenProps = NativeStackScreenProps<RootStackParamList, 'IngredientForm'> & {
  onSaved: (ingredient: Ingredient) => void;
};

export function IngredientFormScreen({ navigation, route, onSaved }: IngredientFormScreenProps) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const { t } = useTranslation();
  const showToast = useToast();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const { position, ingredient: editingIngredient } = route.params;
  const editingId = editingIngredient?.id;
  const isEditing = editingIngredient !== undefined;
  const [draft, setDraft] = useState(route.params.draft);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ cause: unknown } | null>(null);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [isTagPickerOpen, setIsTagPickerOpen] = useState(false);
  const [tags, setTags] = useState<IngredientTag[] | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [recentTagIds, setRecentTagIds] = useState<string[]>([]);
  const [initialTagIds, setInitialTagIds] = useState<string[]>([]);
  const [tagLoadError, setTagLoadError] = useState(false);
  const [tagLoadAttempt, setTagLoadAttempt] = useState(0);
  const tagSheet = useRef<BottomSheetRef>(null);
  const quantityInput = useRef<ComponentRef<typeof FormTextInput>>(null);
  const memoInput = useRef<ComponentRef<typeof FormTextInput>>(null);
  const saving = useRef(false);
  const leaving = useRef(false);
  const tagsChanged = tagIds.length !== initialTagIds.length || tagIds.some(id => !initialTagIds.includes(id));
  const hasChanges = !editingIngredient || draft.name.trim() !== editingIngredient.name
    || draft.quantity.trim() !== editingIngredient.quantity || (draft.memo?.trim() || null) !== (editingIngredient.memo || null)
    || draft.expirationDate !== editingIngredient.expirationDate || tagsChanged;
  const canSave = !!draft.name.trim() && !!draft.quantity.trim()
    && (draft.name.trim().length <= INGREDIENT_NAME_MAX_LENGTH || draft.name === editingIngredient?.name)
    && (draft.quantity.trim().length <= INGREDIENT_QUANTITY_MAX_LENGTH || draft.quantity === editingIngredient?.quantity)
    && ((draft.memo ?? '').trim().length <= INGREDIENT_MEMO_MAX_LENGTH || draft.memo === editingIngredient?.memo)
    && !isDatePickerOpen && !isTagPickerOpen && hasChanges;

  useEffect(() => {
    let active = true;
    void readRecentTagIds().then(ids => { if (active) setRecentTagIds(ids); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    getIngredientTagOptions(db, editingId).then(options => {
      if (!active) return;
      const ids = options.filter(tag => tag.attached).map(tag => tag.id);
      setInitialTagIds(ids);
      setTagIds(ids);
      setTags(options);
    }).catch(() => { if (active) setTagLoadError(true); });
    return () => { active = false; };
  }, [db, editingId, tagLoadAttempt]);

  usePreventRemove(isSaving || isTagPickerOpen, ({ data }) => {
    if (leaving.current) navigation.dispatch(data.action);
  });

  function returnToList() {
    if (isTagPickerOpen) {
      tagSheet.current?.close();
      return;
    }
    if (saving.current || leaving.current) return;
    leaving.current = true;
    setIsDatePickerOpen(false);
    Keyboard.dismiss();
    navigation.goBack();
  }

  function toggleDatePicker() {
    if (saving.current || leaving.current) return;
    Keyboard.dismiss();
    setIsDatePickerOpen(current => !current);
  }

  function removeTag(id: string) {
    setTagIds(current => current.filter(tagId => tagId !== id));
  }

  function closeTagPicker(selectedIds: string[] | null) {
    if (selectedIds?.length) setTagIds(current => [...new Set([...current, ...selectedIds])]);
    setIsTagPickerOpen(false);
  }

  async function saveIngredient() {
    if (saving.current || leaving.current || !canSave) return;
    saving.current = true;
    setIsSaving(true);
    setIsDatePickerOpen(false);
    setSaveError(null);
    Keyboard.dismiss();
    let ingredient: Ingredient;
    try {
      ingredient = editingIngredient
        ? await updateIngredient(db, { ...editingIngredient, ...draft }, tagsChanged ? tagIds : undefined)
        : await registerIngredient(db, { ...draft, ...position }, tagIds);
      const newlyAttached = tagIds.filter(id => !initialTagIds.includes(id)).reverse();
      if (newlyAttached.length) {
        const recent = [...new Set([...newlyAttached, ...recentTagIds])].slice(0, 50);
        void Storage.setItem(RECENT_TAGS_KEY, JSON.stringify(recent)).catch(() => {});
      }
    } catch (cause) {
      setSaveError({ cause });
      saving.current = false;
      setIsSaving(false);
      return;
    }
    onSaved(ingredient);
    leaving.current = true;
    navigation.goBack();
    showToast(isEditing ? t('ingredient.updated') : t('ingredient.registered'));
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={returnToList} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider>
        <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <SafeAreaView style={styles.content} edges={['top', 'left', 'right']} onAccessibilityEscape={returnToList}
            accessibilityElementsHidden={isTagPickerOpen} importantForAccessibility={isTagPickerOpen ? 'no-hide-descendants' : 'auto'}>
            {/* 헤더와 입력 영역 모두 첫 터치를 전달하고, 키보드는 각 버튼의 동작에서 닫는다. */}
            <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent} stickyHeaderIndices={[0]}
              bounces={false} overScrollMode="never"
              keyboardShouldPersistTaps="always" keyboardDismissMode="none" automaticallyAdjustKeyboardInsets={false}>
              {/* 고정 헤더는 직접 자식의 스타일을 옮기므로 가로 배치는 내부 View에 둔다. */}
              <View>
                <Pressable style={styles.header} onPress={Keyboard.dismiss} accessible={false}>
                <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('common.cancel')}
                    disabled={isSaving} accessibilityState={{ disabled: isSaving }}
                    onPress={returnToList} style={[styles.headerIconButton, styles.headerLeftButton]}>
                  <MaterialDesignIcons name="close" size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />
                  </FeedbackPressable>
                  <View style={styles.heading}>
                    <Text accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}
                      style={styles.title}>{isEditing ? t('ingredient.edit') : t('ingredient.add')}</Text>
                  </View>
                  <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={isEditing ? t('ingredient.saveEdit') : t('ingredient.register')}
                    accessibilityState={{ disabled: !canSave || isSaving, busy: isSaving }} disabled={!canSave || isSaving}
                    onPress={saveIngredient} style={[styles.headerIconButton, styles.headerRightButton]}>
                    {isSaving ? <ActivityIndicator color={colors.text} accessibilityLabel={isEditing ? t('ingredient.updating') : t('ingredient.registering')} />
                      : <MaterialDesignIcons name={isEditing ? 'checkbox-marked-circle-outline' : 'checkbox-marked-circle-plus-outline'}
                        size={COMPACT_HEADER_ICON_SIZE} color={colors.text} accessible={false} />}
                  </FeedbackPressable>
                </Pressable>
              </View>
              <Pressable style={[styles.form, { paddingBottom: spacing.lg + insets.bottom }]} onPress={Keyboard.dismiss} accessible={false}>
                <FormTextInput label={t('ingredient.name')} accessibilityLabel={t('ingredient.name')} placeholder={t('ingredient.namePlaceholder')} required
                  value={draft.name} maxLength={Math.max(INGREDIENT_NAME_MAX_LENGTH, editingIngredient?.name.length ?? 0)} editable={!isSaving} returnKeyType="next"
                  onSubmitEditing={() => { if (!saving.current && !leaving.current) quantityInput.current?.focus(); }}
                  onChangeText={name => { if (!saving.current && !leaving.current) setDraft(current => ({ ...current, name })); }} />
                <FormTextInput ref={quantityInput} label={t('ingredient.quantity')} accessibilityLabel={t('ingredient.quantityLabel')} placeholder={t('ingredient.quantityPlaceholder')} required
                  value={draft.quantity} maxLength={Math.max(INGREDIENT_QUANTITY_MAX_LENGTH, editingIngredient?.quantity.length ?? 0)} editable={!isSaving} returnKeyType="next"
                  onSubmitEditing={() => { if (!saving.current && !leaving.current) memoInput.current?.focus(); }}
                  onChangeText={quantity => { if (!saving.current && !leaving.current) setDraft(current => ({ ...current, quantity })); }} />
                <FormTextInput ref={memoInput} label={t('ingredient.memo')} accessibilityLabel={t('ingredient.memoLabel')} placeholder={t('ingredient.memoPlaceholder')}
                  value={draft.memo ?? ''} maxLength={Math.max(INGREDIENT_MEMO_MAX_LENGTH, editingIngredient?.memo?.length ?? 0)} editable={!isSaving} multiline
                  onChangeText={memo => { if (!saving.current && !leaving.current) setDraft(current => ({ ...current, memo })); }} />
                <Text style={styles.fieldLabel}>{t('ingredient.expiration')}</Text>
                <View style={styles.dateRow}>
                  <FeedbackPressable accessibilityRole="button" accessibilityLabel={t('ingredient.selectDate')}
                    accessibilityState={{ disabled: isSaving, expanded: isDatePickerOpen }} disabled={isSaving}
                    onPress={toggleDatePicker} style={styles.dateButton}>
                    <MaterialDesignIcons name="calendar-month" size={22} color={colors.text} accessible={false} />
                    <Text style={styles.date}>{draft.expirationDate ? formatDate(draft.expirationDate, t) : t('ingredient.datePlaceholder')}</Text>
                  </FeedbackPressable>
                  {draft.expirationDate ? (
                    <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('ingredient.clearDate')}
                      disabled={isSaving} accessibilityState={{ disabled: isSaving }} style={styles.clearDateButton}
                      onPress={() => {
                        if (saving.current || leaving.current) return;
                        Keyboard.dismiss();
                        setDraft(current => ({ ...current, expirationDate: null }));
                        setIsDatePickerOpen(false);
                      }}>
                      <MaterialDesignIcons name="calendar-remove" size={24} color={colors.text} accessible={false} />
                    </FeedbackPressable>
                  ) : null}
                </View>
                <View style={styles.tagSection}>
                {tagLoadError ? (
                  <FeedbackPressable accessibilityRole="button" accessibilityLabel={`${t('tag.loadError')} ${t('common.retry')}`}
                    disabled={isSaving} style={styles.tagChip} onPress={() => { setTagLoadError(false); setTagLoadAttempt(current => current + 1); }}>
                    <Text style={styles.errorText}>{t('tag.loadError')} {t('common.retry')}</Text>
                  </FeedbackPressable>
                ) : (
                  <View style={styles.tagRow}>
                    {tags?.filter(tag => tagIds.includes(tag.id)).map(tag => (
                      <View key={tag.id} style={styles.tagChip}>
                        <MaterialDesignIcons name="pound" size={16} color={colors.text} accessible={false} />
                        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.tagText}>{tag.name}</Text>
                        <FeedbackPressable iconFeedback accessibilityRole="button" accessibilityLabel={t('tag.remove', { name: tag.name })}
                          disabled={isSaving} style={styles.removeTagButton} onPress={() => { Keyboard.dismiss(); removeTag(tag.id); }}>
                          <MaterialDesignIcons name="close" size={16} color={colors.text} accessible={false} />
                        </FeedbackPressable>
                      </View>
                    ))}
                    <FeedbackPressable accessibilityRole="button" accessibilityLabel={t('tag.add')}
                      accessibilityState={{ busy: tags === null, expanded: isTagPickerOpen }}
                      disabled={isSaving || tags === null} style={[styles.tagChip, styles.tagAddButton]}
                      onPress={() => {
                        Keyboard.dismiss();
                        setIsDatePickerOpen(false);
                        setIsTagPickerOpen(true);
                      }}>
                      {tags === null ? <ActivityIndicator color={colors.text} />
                        : <MaterialDesignIcons name="tag-outline" size={22} color={colors.text} accessible={false} />}
                      <Text style={styles.tagText}>{t('tag.label')}</Text>
                    </FeedbackPressable>
                  </View>
                )}
                </View>
                {saveError ? <Text accessibilityRole="alert" style={styles.error}>{getErrorMessage(saveError.cause, t, t('ingredient.saveError'))}</Text> : null}
              </Pressable>
            </ScrollView>
            {isDatePickerOpen ? (
              <IngredientExpirationCalendar value={draft.expirationDate} disabled={isSaving}
                onSelect={expirationDate => { if (!saving.current && !leaving.current) setDraft(current => ({ ...current, expirationDate })); }}
                onDismiss={() => setIsDatePickerOpen(false)} />
            ) : null}
          </SafeAreaView>
        </KeyboardAvoidingView>
        {isTagPickerOpen && tags ? (
          // 앱의 기본 포털은 재료 폼 모달 아래에 있으므로 시트는 모달 내부 포털을 사용한다.
          <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <BottomSheetModalProvider>
              <IngredientTagPickerSheet sheetRef={tagSheet} tags={tags} attachedIds={tagIds} recentTagIds={recentTagIds}
                onTagCreated={tag => setTags(current => [...(current ?? []), tag].sort((a, b) => a.name.localeCompare(b.name)))}
                onClose={closeTagPicker} />
            </BottomSheetModalProvider>
          </GestureHandlerRootView>
        ) : null}
      </SafeAreaProvider>
    </Modal>
  );
}

const getStyles = createThemedStyles(({ colors }, mode) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  header: { ...getCompactHeaderStyles(mode).header, backgroundColor: colors.surface },
  heading: { flex: 1, minHeight: HEADER_CONTENT_HEIGHT, justifyContent: 'center' },
  title: { ...getCompactHeaderStyles(mode).title, textAlign: 'center' },
  headerIconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  headerLeftButton: { marginLeft: -COMPACT_HEADER_ICON_INSET },
  headerRightButton: { marginRight: -COMPACT_HEADER_ICON_INSET },
  form: { flexGrow: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.lg },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  date: { color: colors.text, fontSize: 16, flexShrink: 1 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  dateButton: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52, padding: spacing.md,
    gap: spacing.sm, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  clearDateButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  tagSection: { marginTop: spacing.lg },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tagChip: { minHeight: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: TAG_ICON_GAP, alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  tagAddButton: { height: 44, justifyContent: 'center' },
  tagText: { flexShrink: 1, maxWidth: 180, color: colors.text, fontSize: 14 },
  removeTagButton: { width: 44, height: 44, marginLeft: spacing.xs - TAG_ICON_GAP - spacing.sm, marginRight: -spacing.sm,
    alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  errorText: { flexShrink: 1, color: colors.error, fontSize: 14 },
  error: { color: colors.error, fontSize: 16, textAlign: 'center', marginTop: spacing.md },
}));
