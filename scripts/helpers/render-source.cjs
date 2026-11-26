/**
 * @file
 * 네이티브 렌더러 없이 컴포넌트의 상태와 effect를 검사한다.
 * 테스트에서 렌더와 네이티브 완료 이벤트를 명시적으로 진행한다.
 */
function createRenderer() {
  let current;

  function nextSlot() {
    const slots = current.slots;
    const index = current.cursor++;
    return slots[index] ??= {};
  }

  function hasChanged(previous, dependencies) {
    return !previous || !dependencies || previous.length !== dependencies.length
      || previous.some((value, index) => !Object.is(value, dependencies[index]));
  }

  const hooks = {
    createContext: value => ({ value, Provider: 'Provider' }),
    useContext: context => context.value,
    useState(initial) {
      const slot = nextSlot();
      if (!Object.hasOwn(slot, 'value')) slot.value = typeof initial === 'function' ? initial() : initial;
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useRef: initial => hooks.useState(() => ({ current: initial }))[0],
    useMemo(factory, dependencies) {
      const slot = nextSlot();
      if (hasChanged(slot.dependencies, dependencies)) {
        slot.value = factory();
        slot.dependencies = dependencies;
      }
      return slot.value;
    },
    useCallback: (callback, dependencies) => hooks.useMemo(() => callback, dependencies),
    useEffect(effect, dependencies) {
      const slot = nextSlot();
      if (hasChanged(slot.dependencies, dependencies)) {
        current.effects.push(() => {
          slot.cleanup?.();
          slot.dependencies = dependencies;
          slot.cleanup = effect();
        });
      }
    },
    useLayoutEffect: (effect, dependencies) => hooks.useEffect(effect, dependencies),
  };

  function mount(t, Component, props = {}) {
    const instance = {
      slots: [], cursor: 0, effects: [], tree: null,
      render() {
        instance.cursor = 0;
        current = instance;
        try { instance.tree = Component(props); }
        finally { current = undefined; }
        for (const effect of instance.effects.splice(0)) effect();
        return instance.tree;
      },
    };
    t.after(() => instance.slots.forEach(slot => slot.cleanup?.()));
    instance.render();
    return instance;
  }

  return { hooks, mount };
}

module.exports = { createRenderer };
