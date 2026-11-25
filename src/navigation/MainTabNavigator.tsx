/**
 * @file
 * 냉장고·장보기·더보기를 공통 하단 탭으로 전환하고 선택한 탭의 아이콘 뒤를 녹색으로 강조한다.
 * 냉장고·재료·장보기 입력은 상위 Stack에서 열어 입력 중에는 탭을 표시하지 않는다.
 * 탭바에서 하단 안전 영역을 확보하고, 재료 패널·소비 기록 처리 중에는 탭 입력을 막는다.
 */
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBar, createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { HomeScreen } from '@/screens/HomeScreen';
import { ShoppingScreen, type ShoppingSelectionActions } from '@/screens/ShoppingScreen';
import { MoreStackNavigator } from '@/navigation/MoreStackNavigator';
import { spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import { useTranslation } from '@/i18n/LanguageProvider';
import type { IngredientFormResult } from '@/screens/IngredientFormScreen';

export type MainTabParamList = {
  Home: undefined;
  Shopping: undefined;
  More: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const allowTabLabelFontScaling = !(Platform.OS === 'ios' && parseInt(Platform.Version, 10) >= 13);
const tabIcons = {
  Home: require('../../assets/tab-fridge.svg'),
  Shopping: require('../../assets/tab-shopping.svg'),
  More: require('../../assets/tab-more.svg'),
};

export function MainTabNavigator({ takeIngredientFormResult, takeIngredientSearchResult }: {
  takeIngredientFormResult: () => IngredientFormResult | null;
  takeIngredientSearchResult: () => string | null;
}) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { t } = useTranslation();
  const tabLabels = {
    Home: t('tabs.fridge'),
    Shopping: t('tabs.shopping'),
    More: t('tabs.more'),
  };
  const [isTabInteractionBlocked, setIsTabInteractionBlocked] = useState(false);
  const [shoppingAction, setShoppingAction] = useState<ShoppingSelectionActions | null>(null);
  const clearDeletedRefrigerator = useRef<(() => void) | null>(null);
  const [isDeleteTransition, setIsDeleteTransition] = useState(false);
  const navigateAfterDelete = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isDeleteTransition || !navigateAfterDelete.current) return;
    const navigate = navigateAfterDelete.current;
    navigateAfterDelete.current = null;
    navigate();
  }, [isDeleteTransition]);

  return (
    <Tab.Navigator initialRouteName="Home" tabBar={props => shoppingAction ? (
      <View style={[styles.selectionToolbar, { height: 50 + insets.bottom, paddingBottom: insets.bottom,
        paddingLeft: spacing.sm + insets.left, paddingRight: spacing.sm + insets.right }]}>
        <FeedbackPressable accessibilityRole="button" accessibilityLabel={t(shoppingAction.isUndo ? 'shopping.undoPurchase' : 'shopping.purchasedTab')}
          disabled={shoppingAction.disabled} accessibilityState={{ disabled: shoppingAction.disabled }}
          feedback="none" onPress={shoppingAction.onPurchase} style={styles.selectionAction}>
          {({ pressed }) => <><MaterialDesignIcons name={shoppingAction.isUndo ? 'undo-variant' : 'check-circle-outline'} size={24}
            color={pressed ? colors.iconPressed : colors.text} accessible={false} pointerEvents="none" />
            <Text style={[styles.purchaseLabel, pressed && { color: colors.iconPressed }]}>{t(shoppingAction.isUndo ? 'shopping.undoPurchase' : 'shopping.purchasedTab')}</Text></>}
        </FeedbackPressable>
        {shoppingAction.onRegister ? (
          <FeedbackPressable accessibilityRole="button" accessibilityLabel={t('shopping.registerAsIngredient')}
            disabled={shoppingAction.disabled} accessibilityState={{ disabled: shoppingAction.disabled }}
            feedback="none" onPress={shoppingAction.onRegister} style={styles.selectionAction}>
            {({ pressed }) => <>
              <MaterialDesignIcons name="checkbox-marked-circle-plus-outline" size={24}
                color={pressed ? colors.iconPressed : colors.text} accessible={false} pointerEvents="none" />
              <Text style={[styles.purchaseLabel, pressed && { color: colors.iconPressed }]}>{t('shopping.registerAsIngredient')}</Text>
            </>}
          </FeedbackPressable>
        ) : null}
        {shoppingAction.onDelete ? <FeedbackPressable accessibilityRole="button" accessibilityLabel={t('shopping.deleteSelected')}
          disabled={shoppingAction.disabled} accessibilityState={{ disabled: shoppingAction.disabled }}
          feedback="none" onPress={shoppingAction.onDelete} style={styles.selectionAction}>
          {({ pressed }) => <><MaterialDesignIcons name="trash-can-outline" size={24}
            color={pressed ? colors.errorPressed : colors.error} accessible={false} pointerEvents="none" />
            <Text style={[styles.deleteLabel, pressed && { color: colors.errorPressed }]}>{t('common.delete')}</Text></>}
        </FeedbackPressable> : null}
      </View>
    ) : <BottomTabBar {...props} />} screenListeners={{
      tabPress: () => setIsDeleteTransition(false),
    }} screenOptions={({ route }) => ({
      headerShown: false,
      animation: isDeleteTransition ? 'shift' : 'none',
      sceneStyleInterpolator: isDeleteTransition ? ({ current }) => ({
        sceneStyle: { transform: [{ translateX: current.progress.interpolate({
          inputRange: [-1, 0, 1], outputRange: [-width, 0, width],
        }) }] },
      }) : undefined,
      title: tabLabels[route.name],
      tabBarLabelVisibilityMode: 'labeled',
      tabBarAccessibilityLabel: tabLabels[route.name],
      tabBarLabelPosition: 'below-icon',
      tabBarIconSize: 34,
      tabBarIconStyle: styles.icon,
      tabBarIcon: ({ focused, color, size }) => (
        <View style={[styles.icon, focused && styles.selectedIcon]} pointerEvents="none">
          <Image source={tabIcons[route.name]} style={[{ width: size, height: size }, route.name === 'Shopping' && styles.shoppingIcon]}
            contentFit="contain" tintColor={color} accessible={false} />
        </View>
      ),
      tabBarActiveTintColor: colors.chilled,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarActiveBackgroundColor: 'transparent',
      tabBarLabelStyle: styles.label,
      tabBarLabel: mode === 'light' ? ({ focused, color, children }) => (
        <Text numberOfLines={1} allowFontScaling={allowTabLabelFontScaling}
          style={[styles.label, styles.lightLabel, { color }, focused && styles.selectedLightLabel]}>
          {children}
        </Text>
      ) : undefined,
      tabBarItemStyle: styles.item,
      sceneStyle: styles.scene,
      tabBarStyle: [styles.tabBar, {
        height: 50 + insets.bottom,
        paddingBottom: insets.bottom,
        paddingLeft: spacing.sm + insets.left,
        paddingRight: spacing.sm + insets.right,
      }],
      tabBarButton: props => (
        <Pressable {...props} disabled={isTabInteractionBlocked} android_ripple={undefined}
          onPressIn={event => {
            Haptics.selectionAsync().catch(() => {});
            props.onPressIn?.(event);
          }}
          accessibilityState={{ ...props.accessibilityState, selected: props['aria-selected'], disabled: isTabInteractionBlocked }}
          accessibilityElementsHidden={isTabInteractionBlocked}
          importantForAccessibility={isTabInteractionBlocked ? 'no-hide-descendants' : 'auto'}
          style={[props.style, styles.button]} />
      ),
    })}>
      <Tab.Screen name="Home">
        {props => <HomeScreen {...props} onTabInteractionBlockedChange={setIsTabInteractionBlocked}
          clearDeletedRefrigeratorRef={clearDeletedRefrigerator}
          takeIngredientFormResult={takeIngredientFormResult} takeIngredientSearchResult={takeIngredientSearchResult} />}
      </Tab.Screen>
      <Tab.Screen name="Shopping">
        {props => <ShoppingScreen {...props} onSelectionModeChange={setShoppingAction} />}
      </Tab.Screen>
      <Tab.Screen name="More">
        {() => <MoreStackNavigator onTabInteractionBlockedChange={setIsTabInteractionBlocked}
          onRefrigeratorDeleted={navigate => {
            clearDeletedRefrigerator.current?.();
            navigateAfterDelete.current = navigate;
            setIsDeleteTransition(true);
          }} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scene: { backgroundColor: colors.background },
  tabBar: {
    backgroundColor: colors.navigationBackground, paddingTop: 0,
    borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0, shadowOpacity: 0,
  },
  selectionToolbar: { flexDirection: 'row', flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.background },
  selectionAction: { flex: 1, minHeight: 48, marginHorizontal: spacing.xs, paddingTop: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  purchaseLabel: { color: colors.text, fontSize: 12, lineHeight: 16, textAlign: 'center', fontWeight: '600' },
  deleteLabel: { color: colors.error, fontSize: 12, lineHeight: 16, textAlign: 'center', fontWeight: '600' },
  item: { marginHorizontal: spacing.xs },
  button: { minHeight: 44, borderRadius: 18, paddingTop: 8, paddingBottom: 0, justifyContent: 'center' },
  // 선택 배경 전체를 아이콘 슬롯에 넣어 아래 라벨과 겹치지 않게 한다.
  icon: { width: 52, height: 36, alignItems: 'center', justifyContent: 'center' },
  shoppingIcon: { width: 38, height: 38, transform: [{ translateY: -1 }] },
  selectedIcon: { borderRadius: 18, backgroundColor: colors.chipSelected },
  label: { fontSize: 12, lineHeight: 13, fontWeight: '600', marginTop: 1 },
  lightLabel: { fontWeight: '500', textAlign: 'center' },
  selectedLightLabel: { fontWeight: '700' },
}));
