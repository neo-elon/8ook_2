'use strict';

// Run with: node verify-book-writes.cjs
// Executes the production write functions and loadData against an isolated DB mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const writes = source.slice(source.indexOf('async function getBookWriteContext()'),
  source.indexOf('/* ==============================================', source.indexOf('async function doDeleteBook(')));
const schema = source.slice(source.indexOf('function handleSupabaseSchemaError('), source.indexOf('const DB_SQL_SCRIPT'));
const store = fs.readFileSync(path.join(__dirname, 'data-store.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const initial = [{ id: 'existing', user_id: 'user-1', title: 'Original', author: 'Author',
  scraps: [{ id: 'scrap-1', text: 'Keep this', tags: ['tag'] }], created_at: '2026-01-01' }];

function fixture(mode = 'ok', rows = initial) {
  const db = copy(rows);
  const queries = [], toasts = [], effects = [], storageCalls = [];
  const fields = Object.fromEntries(['bk-title', 'bk-subtitle', 'bk-author', 'bk-pages',
    'bk-date', 'bk-sentence', 'bk-kw1', 'bk-kw2', 'bk-kw3'].map(id => [id, { value: '' }]));
  Object.assign(fields['bk-title'], { value: 'Saved title' });
  fields['bk-is-public'] = { checked: true };
  fields['book-save-btn'] = { textContent: '저장', disabled: false };
  let attempts = 0;
  const client = {
    auth: { async getSession() {
      if (mode === 'auth-throw') throw new Error('Auth unavailable');
      if (mode === 'auth-error') return { data: { session: { user: { id: 'user-1' } } }, error: { message: 'Auth error' } };
      if (mode === 'auth-malformed') return {};
      return { data: { session: mode === 'no-session' ? null : { user: mode === 'no-id' ? {} : { id: 'user-1' } } }, error: null };
    } },
    from(table) {
      assert.equal(table, 'books');
      const query = { op: 'select', filters: [], payload: null };
      const builder = {
        insert(payload) { query.op = 'insert'; query.payload = copy(payload[0]); return this; },
        update(payload) { query.op = 'update'; query.payload = copy(payload); return this; },
        delete() { query.op = 'delete'; return this; },
        eq(key, value) { query.filters.push([key, value]); return this; },
        select() { return this; },
        order() { return this; },
        single() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };
      async function execute(single) {
        queries.push(copy(query));
        if (query.op !== 'select') {
          attempts++;
          if (mode === 'db-throw') throw new Error('Network failed');
          if (mode === 'db-error' || (mode === 'retry-error' && attempts > 1)) {
            return { data: null, error: { code: '42501', message: 'DB denied' } };
          }
          if (['retry-ok', 'retry-error'].includes(mode) && attempts === 1) {
            return { data: null, error: { code: 'PGRST204', message: 'Unknown is_public column' } };
          }
          if (mode === 'zero-rows') return { data: null, error: { code: 'PGRST116', message: 'No row returned' } };
          if (mode === 'pending') {
            await new Promise(resolve => { context.releaseWrite = resolve; });
          }
        }
        const matched = db.filter(row => query.filters.every(([key, value]) => row[key] === value));
        if (query.op === 'select') return { data: copy(matched), error: null };
        if (query.op === 'insert') db.unshift(copy(query.payload));
        else {
          if (single && matched.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'No row returned' } };
          if (query.op === 'update') Object.assign(matched[0], copy(query.payload));
          if (query.op === 'delete') db.splice(db.indexOf(matched[0]), 1);
        }
        return { data: { id: query.payload?.id || matched[0]?.id }, error: null };
      }
      return builder;
    },
  };
  const context = vm.createContext({
    books: copy(rows), supabaseClient: mode === 'no-client' ? null : mode === 'broken-client' ? {} : client,
    currentUser: { id: 'user-1' }, editingBookId: null, currentBookId: null,
    modalCover: 'cover', modalSpineCover: 'spine', currentRating: 4,
    dbSupportsSpineCover: true, dbSupportsIsPublic: true,
    document: { getElementById: id => fields[id] },
    toast: message => toasts.push(message), console: { error() {}, warn() {}, log() {} },
    confirm: () => { effects.push('confirm'); return true; },
    localStorage: { getItem: key => { storageCalls.push(['get', key]); return null; },
      setItem: (key, value) => storageCalls.push(['set', key, value]) },
  });
  for (const name of ['closeModal', 'updateSidebar', 'renderCommunityBooks', 'renderCommunityScraps',
    'showDetail', 'renderGallery', 'showGallery', 'markGalleryDirty', 'loadCommunityCommentsFromStorage',
    'cleanBookScraps', 'ensureUserGuideBook', 'bootstrapTagLearningFromLibrary', 'fetchCommunityLikes',
    'initCommunityLikesChannel', 'fetchCommunityComments', 'initCommunityCommentsChannel', 'preheatSpineCache']) {
    context[name] = () => effects.push(name);
  }
  vm.runInContext(schema + '\n' + store + '\n' + writes, context);
  return { context, db, queries, toasts, effects, fields, storageCalls };
}

async function act(f, op) {
  f.context.editingBookId = op === 'update' ? 'existing' : null;
  if (op === 'delete') await f.context.doDeleteBook('existing');
  else await f.context.saveBook();
}

function unchanged(f, before, expectedError) {
  assert.deepEqual(copy(f.context.books), before);
  assert.deepEqual(f.db, before);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], expectedError);
  assert.equal(f.toasts.some(message => /추가되었습니다|수정되었습니다|삭제되었습니다/.test(message)), false);
  assert.deepEqual(f.effects.filter(name => name !== 'confirm'), []);
  assert.equal(f.fields['book-save-btn'].disabled, false);
  assert.equal(f.fields['book-save-btn'].textContent, '저장');
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  for (const op of ['insert', 'update', 'delete']) {
    await test(`normal ${op}: DB, UI and reload`, async () => {
      const f = fixture();
      await act(f, op);
      assert.deepEqual(copy(f.context.books), f.db);
      assert.match(f.toasts[0], /추가되었습니다|수정되었습니다|삭제되었습니다/);
      assert.ok(f.effects.includes('markGalleryDirty'));
      assert.ok(f.effects.includes(op === 'delete' ? 'showGallery' : 'renderGallery'));
      if (op !== 'delete') assert.ok(f.effects.includes('closeModal'));
      if (op === 'update') assert.deepEqual(f.db[0].scraps, initial[0].scraps);
      if (op !== 'insert') assert.deepEqual(f.queries[0].filters, [['id', 'existing'], ['user_id', 'user-1']]);
      const fresh = fixture('ok', f.db);
      fresh.context.books = [];
      await fresh.context.loadData();
      assert.deepEqual(copy(fresh.context.books), f.db);
      assert.deepEqual(fresh.storageCalls, []);
    });
    for (const mode of ['no-client', 'broken-client', 'no-session', 'no-id', 'auth-error', 'auth-throw', 'auth-malformed',
      'db-error', 'db-throw', 'zero-rows']) {
      await test(`${mode} blocks ${op}`, async () => {
        const f = fixture(mode);
        await act(f, op);
        unchanged(f, initial, ['no-session', 'no-id'].includes(mode) ? /로그인이 필요/ :
          mode.startsWith('db-') || mode === 'zero-rows' ? /실패:/ : /서버 연결/);
        if (!mode.startsWith('db-') && mode !== 'zero-rows') {
          assert.equal(f.queries.length, 0);
          assert.deepEqual(f.effects, []);
        }
      });
    }
    await test(`pending ${op} does not change memory before DB completion`, async () => {
      const f = fixture('pending');
      const work = act(f, op);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(copy(f.context.books), initial);
      assert.deepEqual(f.toasts, []);
      assert.deepEqual(f.effects.filter(name => name !== 'confirm'), []);
      f.context.releaseWrite();
      await work;
      assert.deepEqual(copy(f.context.books), f.db);
    });
    if (op !== 'delete') {
      for (const mode of ['retry-ok', 'retry-error']) {
        await test(`${mode} ${op}`, async () => {
          const f = fixture(mode);
          await act(f, op);
          assert.equal(f.queries.length, 2);
          if (mode === 'retry-error') unchanged(f, initial, /저장 실패:/);
          else {
            assert.equal(f.context.books.length, op === 'insert' ? 2 : 1);
            assert.match(f.toasts[0], /추가되었습니다|수정되었습니다/);
            assert.deepEqual(copy(f.context.books[0].scraps), op === 'insert' ? [] : initial[0].scraps);
          }
        });
      }
    }
  }
  await test('reload excludes failed insert and retains saved book', async () => {
    const f = fixture('db-error');
    await act(f, 'insert');
    f.context.books = [{ id: 'memory-only', title: 'Discard me' }];
    await f.context.loadData();
    assert.deepEqual(copy(f.context.books), initial);
    assert.deepEqual(f.storageCalls, []);
  });
  await test('empty remote library stays empty without upload or local restore', async () => {
    const f = fixture('ok', []);
    f.context.books = copy(initial);
    await f.context.loadData();
    assert.deepEqual(copy(f.context.books), []);
    assert.deepEqual(f.queries.map(query => query.op), ['select']);
    assert.deepEqual(f.storageCalls, []);
  });
  await test('missing edit target does not run success effects', async () => {
    const f = fixture('ok', []);
    await act(f, 'update');
    unchanged(f, [], /수정할 도서를 찾을 수 없습니다/);
    assert.deepEqual(f.queries, []);
  });
  process.stdout.write(`\n${passed} tests passed.\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
