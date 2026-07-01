// isDocsTask (item #3) — the multilingual docs-intent backstop that picks the docs
// profile (sitemap/llms-full) and keeps pages whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocsTask } from '../src/lib/task.mjs';

test('recognises documentation tasks across languages (stem match)', () => {
  const docTasks = [
    'Extract the complete documentation.',
    'estrai la documentazione relativa alla programmazione web di firebase',
    'extrae la documentación de la API',
    'extraia a documentação completa',
    'Dokumentation extrahieren',
    'get the docs for this library',
    'crawl the API reference',
    'extract the SDK guides',
  ];
  for (const t of docTasks) assert.equal(isDocsTask(t), true, `should be docs: "${t}"`);
});

test('does NOT fire on data tasks (menus, prices, calendars, "documents" as data)', () => {
  const dataTasks = [
    'extract the documents list from the portal', // "documents" ≠ the documentation stem
    'trova il menu ed estrai le pizze per categoria',
    'get the prices as a table',
    'estrai tutti gli eventi del calendario di settembre 2026',
    'find the contact information',
  ];
  for (const t of dataTasks) assert.equal(isDocsTask(t), false, `should NOT be docs: "${t}"`);
});

test('empty/absent task is not a docs task', () => {
  assert.equal(isDocsTask(''), false);
  assert.equal(isDocsTask(undefined), false);
});
