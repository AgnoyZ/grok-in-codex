import fs from 'node:fs';
import path from 'node:path';

export function limitResult(text, maxChars = 20000, { outputFile, artifacts = [] } = {}) {
  const max = Number(maxChars);
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('maxChars must be a non-negative integer');
  const body = String(text ?? '');
  const truncated = max > 0 && body.length > max;
  if (truncated) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, body, 'utf8');
  }
  const artifactPaths = artifacts.map(item => typeof item === 'string' ? item : item.path).filter(Boolean);
  return { text: truncated ? body.slice(0, max) : body, totalChars: body.length, truncated,
    ...(truncated ? { fullOutputPath: outputFile, artifactPaths } : {}) };
}
