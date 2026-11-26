/**
 * @file
 * 재료 검색 결과가 홈의 보관 위치 또는 위치 미지정 목록으로 연결되는지 검증한다.
 * 일괄 입고의 위치 선택을 검증하며 도면 측정값과 전환 완료는 테스트에서 전달한다.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader, loadSource } = require('./helpers/load-source.cjs');
const { createRenderer } = require('./helpers/render-source.cjs');

const { createRefrigeratorDraft } = loadSource('src/features/fridge/model/fridgeLayout');
const { defaultTranslate } = loadSource('src/i18n/translations');
const { getAppTheme } = loadSource('src/theme/tokens');
const viewport = { x: 0, y: 0, width: 375, height: 700 };

function find(node, matches) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, matches);
      if (result) return result;
    }
  }
  if (!node?.props) return undefined;
  return matches(node) ? node : find(node.props.children, matches);
}

const byType = type => node => node.type === type;
const measure = ({ x, y, width, height }) => ({ measureInWindow: callback => callback(x, y, width, height) });

function createFixture() {
  const { hooks, mount } = createRenderer();
  const refrigerator = { ...createRefrigeratorDraft(), id: 'fridge' };
  const body = refrigerator.rows[0].compartments[0];
  const slot = Object.assign(body.slots[0], { id: 'split-slot', drawerCount: 2 });
  const milk = { id: 'milk', name: '딸기우유', quantity: '1개', slotId: slot.id, drawerNumber: 1, expirationDate: null };
  const unassigned = { ...milk, id: 'unassigned', name: '두유' };
  const subscription = { remove() {} };
  const keepQueue = () => {};
  const load = createSourceLoader({
    react: hooks,
    'react-native': {
      View: 'View', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', FlatList: 'FlatList',
      ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
      Animated: {
        View: 'Animated.View', ScrollView: 'Animated.ScrollView',
        timing() {}, sequence() {}, loop: () => ({ start() {}, stop() {} }),
      },
      useAnimatedValue: initial => hooks.useState(() => ({ value: initial,
        setValue(value) { this.value = value; }, interpolate: value => value,
      }))[0],
      StyleSheet: { create: styles => styles, hairlineWidth: 1, absoluteFill: {} },
      AppState: { addEventListener: () => subscription }, BackHandler: { addEventListener: () => subscription },
      Platform: { OS: 'android' }, Keyboard: { dismiss() {} },
      useWindowDimensions: () => ({ ...viewport, fontScale: 1 }),
    },
    '@expo/ui/community/masked-view': { MaskedView: 'MaskedView' },
    '@react-native-vector-icons/material-design-icons': { MaterialDesignIcons: 'Icon' },
    '@react-navigation/native': {
      useFocusEffect: effect => hooks.useEffect(effect, [effect]), usePreventRemove() {},
    },
    'react-native-safe-area-context': {
      SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    expo: {},
    'expo-sqlite': { useSQLiteContext: () => null },
    'expo-sqlite/kv-store': { async getItemAsync() { return null; } },
    '@/db/refrigeratorRepository': { async getRefrigerator() { return refrigerator; } },
    '@/db/ingredientRepository': {
      async getIngredients() { return [milk]; },
      async getUnassignedIngredients() { return [unassigned]; },
    },
    '@/db/ingredientTagRepository': { async getSearchableIngredientTags() {
      return [{ id: 'tag', name: '아침', ingredientId: milk.id }];
    } },
    '@/theme/ThemeProvider': { useAppTheme: () => ({ ...getAppTheme('light'), mode: 'light' }) },
    '@/i18n/LanguageProvider': { useTranslation: () => ({ t: defaultTranslate }) },
    '@/components/FeedbackPressable': { FeedbackPressable: 'FeedbackPressable' },
    '@/components/PrimaryButton': { PrimaryButton: 'PrimaryButton' },
    '@/components/Toast': { Toast: 'Toast' },
    '@/components/ToastProvider': { useToast: () => () => {} },
    '@/features/fridge/components/FridgeIngredientLegend': { FridgeIngredientLegend: 'FridgeIngredientLegend' },
    '@/features/ingredient/components/IngredientListSheet': { IngredientListSheet: 'IngredientListSheet' },
    '@/features/ingredient/components/IngredientMoveQueueSheet': { IngredientMoveQueueSheet: 'IngredientMoveQueueSheet' },
    '@/features/ingredient/IngredientMoveQueueProvider': { useIngredientMoveQueue: () => ({ ingredientIds: [], retain: keepQueue }) },
    '@/screens/ConsumedIngredientsScreen': { ConsumedIngredientsScreen: 'ConsumedIngredientsScreen' },
  });

  const { HomeScreen } = load('src/screens/HomeScreen');
  const { IngredientSearchScreen } = load('src/screens/IngredientSearchScreen');
  const { IngredientPositionScreen } = load('src/screens/IngredientPositionScreen');
  const { FridgeFocusView, FridgeInteriorMap } = load('src/features/fridge/components/FridgeInteriorMap');
  const shopping = load('src/db/shoppingRepository');
  return { body, slot, milk, unassigned, mount, HomeScreen, IngredientSearchScreen,
    IngredientPositionScreen, FridgeFocusView, FridgeInteriorMap, shopping };
}

const waitForLoad = () => new Promise(setImmediate);

async function selectSearchResult(t, fixture, query, expectedResult) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const search = fixture.mount(t, fixture.IngredientSearchScreen, {
    navigation: { goBack: () => events.push('back') },
    onSelectIngredient: id => events.push(id),
  });
  await waitForLoad();
  find(search.render(), byType('TextInput')).props.onChangeText(query);
  assert.equal(find(search.render(), byType('FlatList')), undefined);
  t.mock.timers.tick(250);
  const list = find(search.render(), byType('FlatList')).props;
  assert.deepEqual(list.data.map(result => result.ingredient.id), [expectedResult.id]);
  list.renderItem({ item: list.data[0] }).props.onPress();
  assert.deepEqual(events, [expectedResult.id, 'back']);
  return events[0];
}

async function openHome(t, fixture, ingredientId) {
  const home = fixture.mount(t, fixture.HomeScreen, {
    navigation: {},
    takeIngredientFormResult: () => null,
    takeIngredientSearchResult: () => ingredientId,
  });
  await waitForLoad();
  home.render();
  return home;
}

test('태그 검색에서 선택한 재료의 최신 좌우 위치를 홈에서 열고 강조한다', async t => {
  const fixture = createFixture();
  const id = await selectSearchResult(t, fixture, '# 아침', fixture.milk);
  fixture.milk.drawerNumber = 2;
  const home = await openHome(t, fixture, id);
  const view = find(home.tree, node => node.type === 'View' && node.props.ref && node.props.onLayout);
  view.props.ref.current = measure(viewport);

  const map = fixture.mount(t, fixture.FridgeInteriorMap, find(home.tree, byType(fixture.FridgeInteriorMap)).props);
  const canvas = find(map.tree, node => node.type === 'View' && node.props.ref);
  canvas.props.ref.current = measure({ x: 52, y: 130, width: 270, height: 540 });
  map.tree.props.onLayout({ nativeEvent: { layout: viewport } });
  map.render();

  const focus = () => find(home.render(), byType(fixture.FridgeFocusView)).props;
  assert.equal(focus().target.areaId, fixture.body.id);
  assert.equal(focus().selectedPositionId, fixture.slot.id + '-right');
  focus().onPhaseChange('open');
  assert.equal(focus().markedPositionId, fixture.slot.id + '-right');

  find(home.tree, byType(fixture.FridgeInteriorMap)).props.onCanvasOffsetChange(20);
  focus().onClose();
  assert.equal(focus().phase, 'closing');
  assert.equal(focus().target.canvas.y, 130 - 20);
  focus().onPhaseChange('closed');
  assert.equal(find(home.render(), byType(fixture.FridgeFocusView)), undefined);
  assert.equal(find(home.tree, byType(fixture.FridgeInteriorMap)).props.selectedAreaId, fixture.body.id);
});

test('이름 검색에서 위치 미지정 재료를 선택하면 홈에서 재배치할 목록을 연다', async t => {
  const fixture = createFixture();
  const id = await selectSearchResult(t, fixture, ' 두유 ', fixture.unassigned);
  const home = await openHome(t, fixture, id);
  const sheet = find(home.tree, byType('IngredientMoveQueueSheet')).props;
  assert.deepEqual(sheet.ingredients.map(item => item.id), [id]);
  assert.equal(typeof sheet.onAssign, 'function');
});

test('구매한 품목을 선택한 분할 칸에 한 번만 일괄 등록한다', async t => {
  const fixture = createFixture();
  const register = t.mock.method(fixture.shopping, 'registerPurchasedIngredients', async () => []);
  const items = ['우유', '달걀'].map((name, index) => ({
    id: String(index), name, quantity: '1개', memo: null, purchasedAt: '2026-11-26T00:00:00.000Z',
  }));
  const goBack = t.mock.fn();
  const screen = fixture.mount(t, fixture.IngredientPositionScreen, {
    route: { params: { items } }, navigation: { goBack },
  });
  await waitForLoad();
  const button = () => find(screen.render(), node =>
    node.props.accessibilityLabel === defaultTranslate('shopping.registerHere', { count: items.length })).props;
  assert.equal(button().disabled, true);

  const view = find(screen.tree, node => node.type === 'View' && node.props.ref && node.props.onLayout);
  view.props.ref.current = measure(viewport);
  find(screen.tree, byType(fixture.FridgeInteriorMap)).props.onFocus({
    areaId: fixture.body.id, returnAreaId: fixture.body.id, canvas: viewport,
  });
  const focus = () => find(screen.render(), byType(fixture.FridgeFocusView)).props;
  focus().onPhaseChange('open');
  focus().onSelectSlot(fixture.body.id, 0, fixture.slot.id + '-left');

  const { disabled, onPress } = button();
  assert.equal(disabled, false);
  await Promise.all([onPress(), onPress()]);
  assert.equal(register.mock.callCount(), 1);
  const [, registrations, position] = register.mock.calls[0].arguments;
  assert.deepEqual(registrations.map(({ item }) => item.id), items.map(item => item.id));
  assert.deepEqual(position, { slotId: fixture.slot.id, drawerNumber: 1 });
  assert.equal(goBack.mock.callCount(), 1);
});
