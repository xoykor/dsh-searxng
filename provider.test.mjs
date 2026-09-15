import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.mjs';
function provider(config) {
  let result;
  apply({ web: { registerSearchProvider(p) { result = p; } } }, config);
  return result;
}
test('registers the SearXNG provider', () => {
  const p = provider(); assert.equal(p.id, 'searxng'); assert.equal(p.available(), true);
});
test('encodes query, passes cancellation and maps valid results', async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.origin, 'http://127.0.0.1:8888');
    assert.equal(url.searchParams.get('q'), 'a & b');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(init.signal, signal);
    return { ok: true, json: async () => ({ results: [{url:'https://example.org',title:'Example',content:'Snippet'}, {title:'missing URL'}] }) };
  });
  assert.deepEqual(await provider().search({query:'a & b'}, signal), {sources:[{url:'https://example.org',title:'Example',snippet:'Snippet'}],truncated:false});
});
test('surfaces HTTP failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ok:false,status:503}));
  await assert.rejects(provider().search({query:'test'}), /HTTP 503/);
});
test('preserves transport cancellation error', async t => {
  const error = new DOMException('Cancelled', 'AbortError');
  t.mock.method(globalThis, 'fetch', async () => {throw error;});
  await assert.rejects(provider().search({query:'test'}), e => e === error);
});
