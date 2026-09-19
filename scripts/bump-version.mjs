import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bumpVersion(version, root = fileURLToPath(new URL('../', import.meta.url))) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version || '')) {
    throw new Error('Provide a semantic version, e.g. npm run version:bump -- 0.7.0');
  }
  const files = ['package.json', 'plugins/grok/.codex-plugin/plugin.json', '.agents/plugins/marketplace.json'];
  const documents = files.map(file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  const entry = documents[2].plugins.find(plugin => plugin.name === 'grok');
  if (!entry) throw new Error('Marketplace is missing the grok entry');
  for (const document of documents) document.version = version;
  if (documents[2].metadata) documents[2].metadata.version = version;
  entry.version = version;
  documents.forEach((document, index) => fs.writeFileSync(path.join(root, files[index]), JSON.stringify(document, null, 2) + '\n'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) bumpVersion(process.argv[2]);
