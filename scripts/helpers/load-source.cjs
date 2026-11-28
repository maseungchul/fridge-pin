/**
 * @file
 * 검증 스크립트에서 TypeScript 소스를 읽고, 네이티브 경계만 지정한 대역으로 연결한다.
 * 검증 환경마다 모듈을 캐시해 여러 저장소에서 쓰는 오류 타입과 상태를 공유한다.
 */
const { readFileSync, existsSync } = require('node:fs');
const { dirname, extname, resolve } = require('node:path');
const ts = require('typescript');

const root = resolve(__dirname, '../..');
function createSourceLoader(overrides = {}) {
  const modules = new Map();

  function load(path) {
    const base = resolve(root, path);
    const filename = [`${base}.ts`, `${base}.tsx`].find(existsSync) ?? base;
    // Metro가 처리하는 SVG는 네이티브 렌더러 없는 검증에서 파일 경로로 대신한다.
    if (extname(filename) === '.svg' && existsSync(filename)) return filename;
    if (modules.has(filename)) return modules.get(filename).exports;
    const source = readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const module = { exports: {} };
    modules.set(filename, module);
    try {
      new Function('require', 'module', 'exports', output)(name => {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name.startsWith('@/')) return load(`src/${name.slice(2)}`);
        if (name.startsWith('.')) return load(resolve(dirname(filename), name));
        return require(name);
      }, module, module.exports);
      return module.exports;
    } catch (error) {
      modules.delete(filename);
      throw error;
    }
  }

  return load;
}

module.exports = { createSourceLoader, loadSource: createSourceLoader() };
