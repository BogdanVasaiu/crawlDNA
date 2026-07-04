// Disk output (§9): a flat bundle of AI-grouped .md files plus a stable
// manifest.json. The grouping (one file by default, several when the task asks
// to split) is decided upstream in lib/layout.mjs; this module only writes a
// pre-built `files` list and the manifest to a directory.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a bundle of grouped Markdown files + manifest.json to `dir`. When `documents`
 * is given (the opt-in #10 per-page format), it ALSO writes one .md per page under a
 * `documents/` subfolder plus a root `index.md` and `documents.jsonl` — pure repackaging
 * of the same content, so a programmatic consumer can load pages individually.
 *
 * @param {string} dir
 * @param {object} bundle
 * @param {Array<{ filename: string, markdown: string }>} [bundle.files]
 * @param {object} bundle.manifest
 * @param {{ files?: Array<{filename,markdown}>, index?: {filename,markdown}, jsonl?: {filename,content} }} [bundle.documents]
 * @param {{ files?: Array<{filename,markdown}> }} [bundle.states]  faithful per-state record (states/)
 * @returns {Promise<{ dir: string, manifestPath: string, files: number, documents: number }>}
 */
export async function writeBundle(dir, { files = [], manifest, documents = null, states = null }) {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });

  for (const f of files) {
    // basename guards against any stray path separators in a filename.
    const abs = path.join(root, path.basename(f.filename));
    await writeFile(abs, f.markdown, 'utf8');
  }

  let docCount = 0;
  if (documents) {
    if (documents.files && documents.files.length) {
      const docDir = path.join(root, 'documents');
      await mkdir(docDir, { recursive: true });
      for (const f of documents.files) {
        await writeFile(path.join(docDir, path.basename(f.filename)), f.markdown, 'utf8');
        docCount++;
      }
    }
    if (documents.index) {
      await writeFile(path.join(root, path.basename(documents.index.filename)), documents.index.markdown, 'utf8');
    }
    if (documents.jsonl) {
      await writeFile(path.join(root, path.basename(documents.jsonl.filename)), documents.jsonl.content, 'utf8');
    }
  }

  // The faithful per-state record (reveal snapshots) — one .md per multi-state page.
  if (states && states.files && states.files.length) {
    const statesDir = path.join(root, 'states');
    await mkdir(statesDir, { recursive: true });
    for (const f of states.files) {
      await writeFile(path.join(statesDir, path.basename(f.filename)), f.markdown, 'utf8');
    }
  }

  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return { dir: root, manifestPath, files: files.length, documents: docCount };
}
