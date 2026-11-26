/**
 * @file
 * 테마 설정 저장과 시스템 색상 변경 시 실제 적용 모드를 검증한다.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./helpers/load-source.cjs');
const { createRenderer } = require('./helpers/render-source.cjs');

function createThemeFixture(t, savedValue, systemMode = 'light') {
  let current = systemMode;
  let stored = savedValue;
  let rejectSave = false;
  const { hooks, mount } = createRenderer();
  const storage = {
    async getItemAsync(key) { assert.equal(key, 'settings.theme'); return stored; },
    async setItemAsync(key, value) {
      assert.equal(key, 'settings.theme');
      if (rejectSave) throw new Error('save failed');
      stored = value;
    },
  };
  const load = createSourceLoader({
    react: hooks,
    'react-native': { useColorScheme: () => current },
    'expo-sqlite/kv-store': storage,
  });
  const { ThemeProvider } = load('src/theme/ThemeProvider');
  const screen = mount(t, ThemeProvider);
  return {
    render: () => screen.render()?.props.value ?? null,
    setSystemMode(value) { current = value; },
    failSave() { rejectSave = true; },
    saved() { return stored; },
  };
}

test('시스템 설정은 기기 테마 변경을 따르고 선택값을 저장한다', async t => {
  const fixture = createThemeFixture(t, null);
  assert.equal(fixture.render(), null);
  await Promise.resolve();
  const light = fixture.render();
  assert.equal(light.preference, 'light');
  await light.changeTheme('system');
  assert.equal(fixture.saved(), 'system');
  assert.equal(fixture.render().mode, 'light');
  fixture.setSystemMode('dark');
  assert.equal(fixture.render().mode, 'dark');
  assert.equal(fixture.render().preference, 'system');
  fixture.setSystemMode('light');
  assert.equal(fixture.render().mode, 'light');
});

test('저장한 시스템 테마를 복원하고 수동 선택과 저장 실패를 처리한다', async t => {
  const fixture = createThemeFixture(t, 'system', 'dark');
  await Promise.resolve();
  let theme = fixture.render();
  assert.equal(theme.mode, 'dark');
  await theme.changeTheme('light');
  fixture.setSystemMode('dark');
  theme = fixture.render();
  assert.equal(theme.mode, 'light');
  assert.equal(theme.preference, 'light');
  fixture.failSave();
  await assert.rejects(theme.changeTheme('system'), /save failed/);
  assert.equal(fixture.render().preference, 'light');
  assert.equal(fixture.saved(), 'light');
});
