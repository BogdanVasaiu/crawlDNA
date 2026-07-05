// End-to-end reshape (#11) against a real on-disk run and a local OpenAI-compatible
// stub — a miniature of the live failure: a source far beyond the model budget, a
// request about content DEEP inside it, and a model that mixes real and invented
// values. Proves: retrieval sends the right section, the invented value is flagged
// in the saved file, and a re-emitted near-identical file is skipped, not saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { reshape } from '../src/reshape.mjs';

// --- stub model -------------------------------------------------------------
let handler = () => '';
let prompts = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    try {
      prompts.push(JSON.parse(data).messages.at(-1).content);
    } catch {
      prompts.push('');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: handler() } }], usage: {} }));
  });
});

// --- on-disk run fixture ------------------------------------------------------
let tmp;
let llmOpts;
const runId = '20990101-000000-test01';
const sid = '01-ex-com';
const FILLER = ('changelog filler line with nothing on topic here\n'.repeat(40) + '\n').repeat(40); // ~75k chars
const SOURCE =
  `# Changelog\n\n${FILLER}\n\n` +
  '# Alerts v-alert\n\n' +
  "The v-alert props: `close-label` defaults to `'$vuetify.close'`.\n";

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llmOpts = {
    model: 'stub',
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'k',
  };
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crawldna-reshape-test-'));
  const scanDir = path.join(tmp, runId, sid);
  await mkdir(scanDir, { recursive: true });
  await writeFile(path.join(scanDir, 'docs.md'), SOURCE, 'utf8');
  const manifest = {
    runId,
    createdAt: '2099-01-01T00:00:00.000Z',
    targets: [{ url: 'https://ex.com', task: 'docs' }],
    stats: { pages: 1 },
    scans: [
      {
        scanId: sid,
        url: 'https://ex.com',
        task: 'docs',
        title: 'ex.com',
        files: [{ filename: 'docs.md', title: 'Docs', bytes: SOURCE.length, pages: ['https://ex.com/docs'] }],
        pages: [],
      },
    ],
  };
  await writeFile(path.join(tmp, runId, 'manifest.json'), JSON.stringify(manifest), 'utf8');
});
after(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

const MODEL_FILE =
  '===FILE: v-alert.md===\n' +
  '| Prop | Default |\n| --- | --- |\n' +
  "| `close-label` | `'$vuetify.close'` |\n" +
  "| `variant` | `'elevated'` |\n" +
  '===END===';

test('deep request: retrieval feeds the right section; the invented value is flagged in the saved file', async () => {
  handler = () => MODEL_FILE;
  prompts = [];
  const out = await reshape({ runId, scanId: sid, message: 'dammi i props del v-alert', cacheDir: tmp, ...llmOpts });

  // the model was shown the DEEP on-topic section, not the blind head of the source
  assert.ok(prompts[0].includes("'$vuetify.close'"), 'the v-alert section must reach the model');
  assert.ok(!prompts[0].includes('changelog filler line'), 'the off-topic head must NOT fill the budget');
  assert.equal(out.contextMode, 'retrieval');
  assert.equal(out.truncated, true);

  // fidelity: the real default passes, the invented variant is flagged
  assert.equal(out.files.length, 1);
  const fid = out.files[0].fidelity;
  assert.ok(fid && fid.unverified.includes("'elevated'"), 'the invented value must be reported');
  assert.ok(!fid.unverified.includes("'$vuetify.close'"), 'the real value must verify');

  // the warning lives INSIDE the saved file, before the content
  const onDisk = await readFile(path.join(tmp, runId, sid, 'chat', out.files[0].filename), 'utf8');
  assert.ok(onDisk.startsWith('> ⚠️ **Fidelity check (crawldna):**'));
  assert.ok(onDisk.includes("`'elevated'`"));
  assert.ok(onDisk.includes("| `close-label` | `'$vuetify.close'` |"), 'content itself is untouched');
});

test('re-emitting the same deliverable is skipped with a note, not saved again', async () => {
  handler = () => MODEL_FILE; // the model re-delivers the identical file
  const out = await reshape({ runId, scanId: sid, message: 'e per gli altri componenti?', cacheDir: tmp, ...llmOpts });
  assert.equal(out.files.length, 0, 'the near-identical re-emission must not be saved');
  assert.ok(/Skipped "v-alert\.md"/.test(out.reply), 'the skip is reported, never silent');
});

test('verify: false disables the banner and the fidelity metadata', async () => {
  handler = () =>
    '===FILE: other.md===\n' + "A different deliverable citing `'invented-thing'` entirely.\n" + '===END===';
  const out = await reshape({ runId, scanId: sid, message: 'altro file', cacheDir: tmp, verify: false, ...llmOpts });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].fidelity, undefined);
  const onDisk = await readFile(path.join(tmp, runId, sid, 'chat', out.files[0].filename), 'utf8');
  assert.ok(!onDisk.includes('Fidelity check'));
});
