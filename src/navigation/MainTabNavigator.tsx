/**
 * @file
 * 냉장고·장보기·더보기를 공통 하단 탭으로 전환하고 선택한 탭의 아이콘 뒤를 녹색으로 강조한다.
 * 냉장고·재료·장보기 입력은 상위 Stack에서 열어 입력 중에는 탭을 표시하지 않는다.
 * 탭바에서 하단 안전 영역을 확보하고, 재료 패널·소비 기록 처리 중에는 탭 입력을 막는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBar, createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SelectionToolbar, SelectionToolbarButton } from '@/components/SelectionToolbar';
import { HomeScreen } from '@/screens/HomeScreen';
import { ShoppingScreen, type ShoppingSelectionActions } from '@/screens/ShoppingScreen';
import { MoreStackNavigator } from '@/navigation/MoreStackNavigator';
import { spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import { useTranslation } from '@/i18n/LanguageProvider';
import type { Ingredient } from '@/features/ingredient/model/ingredient';

export type MainTabParamList = {
  Home: undefined;
  Search: undefined;
  Shopping: undefined;
  More: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const allowTabLabelFontScaling = !(Platform.OS === 'ios' && parseInt(Platform.Version, 10) >= 13);
const tabIcons = {
  Home: require('../../assets/tab-fridge.svg'),
  Search: require('../../assets/tab-search.svg'),
  Shopping: require('../../assets/tab-shopping.svg'),
  More: require('../../assets/tab-more.svg'),
};

/** 터치 영역을 유지하면서 탭의 아이콘과 라벨에 누름 효과를 표시한다. */
function MainTabButton({ children, disabled, onTouchStart, onPressIn, onPressOut, onLongPress: _onLongPress, ...props }: BottomTabBarButtonProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: disabled ? 1 : scale.get() }],
  }));

  useEffect(() => {
    if (disabled) scale.set(1);
  }, [disabled, scale]);

  return (
    <Pressable {...props} disabled={disabled} android_ripple={undefined}
      onTouchStart={event => {
        if (!disabled) Haptics.selectionAsync().catch(() => {});
        onTouchStart?.(event);
      }}
      onPressIn={event => {
        scale.set(withTiming(0.9, { duration: 100, reduceMotion: ReduceMotion.System }));
        onPressIn?.(event);
      }}
      onPressOut={event => {
        scale.set(withTiming(1, { duration: 160, reduceMotion: ReduceMotion.System }));
        onPressOut?.(event);
      }}>
      <Animated.View pointerEvents="none" style={[{ alignSelf: 'stretch', alignItems: 'center' }, animatedStyle]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

export function MainTabNavigator({ takeIngredientFormResult, takeIngredientSearchResult, openSearch, navigateHomeRef }: {
  openSearch: () => void;
  navigateHomeRef: React.RefObject<(() => void) | null>;
  takeIngredientFormResult: () => Ingredient | null;
  takeIngredientSearchResult: () => string | null;
}) {
  const { mode, colors } = useAppTheme();
  const styles = getStyles(mode);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { t } = useTranslation();
  const tabLabels = {
    Home: t('tabs.fridge'),
    Search: t('tabs.search'),
    Shopping: t('tabs.shopping'),
    More: t('tabs.more'),
  };
  const [isTabInteractionBlocked, setIsTabInteractionBlocked] = useState(false);
  const [shoppingAction, setShoppingAction] = useState<ShoppingSelectionActions | null>(null);
  const [pressedTab, setPressedTab] = useState<keyof MainTabParamList | null>(null);
  const clearDeletedRefrigerator = useRef<(() => void) | null>(null);
  const [isDeleteTransition, setIsDeleteTransition] = useState(false);
  const navigateAfterDelete = useRef<(() => void) | null>(null);

  const handleTabInteractionBlockedChange = useCallback((blocked: boolean) => {
    if (blocked) setPressedTab(null);
    setIsTabInteractionBlocked(blocked);
  }, []);
  const handleShoppingSelectionChange = useCallback((action: ShoppingSelectionActions | null) => {
    if (action) setPressedTab(null);
    setShoppingAction(action);
  }, []);

  useEffect(() => {
    if (!isDeleteTransition || !navigateAfterDelete.current) return;
    const navigate = navigateAfterDelete.current;
    navigateAfterDelete.current = null;
    navigate();
  }, [isDeleteTransition]);

  return (
    <Tab.Navigator initialRouteName="Home" tabBar={props => shoppingAction ? (
      <SelectionToolbar background="background">
        <SelectionToolbarButton icon={shoppingAction.isUndo ? 'undo-variant' : 'check-circle-outline'}
          label={t(shoppingAction.isUndo ? 'shopping.undoPurchase' : 'shopping.purchasedTab')}
          disabled={shoppingAction.disabled} onPress={shoppingAction.onPurchase} />
        {shoppingAction.onRegister ? (
          <SelectionToolbarButton icon="checkbox-marked-circle-plus-outline" label={t('shopping.registerAsIngredient')}
            disabled={shoppingAction.disabled} onPress={shoppingAction.onRegister} />
        ) : null}
        {shoppingAction.onDelete ? (
          <SelectionToolbarButton icon="trash-can-outline" label={t('common.delete')} accessibilityLabel={t('shopping.deleteSelected')}
            disabled={shoppingAction.disabled} destructive onPress={shoppingAction.onDelete} />
        ) : null}
      </SelectionToolbar>
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
      tabBarIconSize: 28,
      tabBarIconStyle: styles.icon,
      tabBarIcon: ({ focused, color, size }) => (
        <View style={[styles.icon, focused && styles.selectedIcon]} pointerEvents="none">
          <Image source={tabIcons[route.name]} style={[{ width: size, height: size }, route.name === 'Shopping' && styles.shoppingIcon]}
            contentFit="contain" tintColor={pressedTab === route.name ? colors.chilled : color} accessible={false} />
        </View>
      ),
      tabBarActiveTintColor: colors.chilled,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarActiveBackgroundColor: 'transparent',
      tabBarLabelStyle: styles.label,
      tabBarLabel: mode === 'light' || pressedTab === route.name ? ({ focused, color, children }) => (
        <Text numberOfLines={1} allowFontScaling={allowTabLabelFontScaling}
          style={[styles.label, mode === 'light' && styles.lightLabel,
            { color: pressedTab === route.name ? colors.chilled : color },
            mode === 'light' && (focused || pressedTab === route.name) && styles.selectedLightLabel]}>
          {children}
        </Text>
      ) : undefined,
      tabBarItemStyle: styles.item,
      sceneStyle: styles.scene,
      tabBarStyle: [styles.tabBar, {
        height: 58 + insets.bottom,
        paddingBottom: insets.bottom,
        paddingLeft: spacing.sm + insets.left,
        paddingRight: spacing.sm + insets.right,
      }],
      tabBarButton: props => (
        <MainTabButton {...props} disabled={isTabInteractionBlocked}
          onPressIn={event => {
            setPressedTab(route.name);
            props.onPressIn?.(event);
          }}
          onPressOut={event => {
            setPressedTab(current => current === route.name ? null : current);
            props.onPressOut?.(event);
          }}
          accessibilityState={{ ...props.accessibilityState, selected: props['aria-selected'], disabled: isTabInteractionBlocked }}
          accessibilityElementsHidden={isTabInteractionBlocked}
          importantForAccessibility={isTabInteractionBlocked ? 'no-hide-descendants' : 'auto'}
          style={[props.style, styles.button]} />
      ),
    })}>
      <Tab.Screen name="Home">
        {props => <HomeScreen {...props} onTabInteractionBlockedChange={handleTabInteractionBlockedChange}
          clearDeletedRefrigeratorRef={clearDeletedRefrigerator}
          takeIngredientFormResult={takeIngredientFormResult} takeIngredientSearchResult={takeIngredientSearchResult} />}
      </Tab.Screen>
      <Tab.Screen name="Shopping">
        {props => <ShoppingScreen {...props} onSelectionModeChange={handleShoppingSelectionChange} />}
      </Tab.Screen>
      {/* 검색은 별도 화면으로 열어 현재 탭의 선택 상태를 유지한다. */}
      <Tab.Screen name="Search" component={EmptySearchTab} listeners={({ navigation }) => ({
        tabPress: event => {
          event.preventDefault();
          navigateHomeRef.current = () => navigation.navigate('Home');
          openSearch();
        },
      })} />
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

function EmptySearchTab() { return null; }

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scene: { backgroundColor: colors.background },
  tabBar: {
    backgroundColor: colors.navigationBackground, paddingTop: 0,
    borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth,
    elevation: 0, shadowOpacity: 0,
  },
  item: { marginHorizontal: spacing.xs },
  button: { minHeight: 44, borderRadius: 18, paddingTop: 4, paddingBottom: 4, justifyContent: 'center' },
  // 선택 배경 전체를 아이콘 슬롯에 넣어 아래 라벨과 겹치지 않게 한다.
  icon: { width: 50, height: 34, alignItems: 'center', justifyContent: 'center' },
  shoppingIcon: { width: 32, height: 32, transform: [{ translateY: -1 }] },
  selectedIcon: { width: 46, height: 30, borderRadius: 15, backgroundColor: colors.chipSelected },
  label: { fontSize: 11, lineHeight: 13, fontWeight: '600', marginTop: 1, textAlign: 'center' },
  lightLabel: { fontWeight: '500' },
  selectedLightLabel: { fontWeight: '700' },
}));
