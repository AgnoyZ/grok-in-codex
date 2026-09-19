import { runCommand } from './process.mjs';

export const CLI_FLAGS = ['--prompt-file', '-p', '--output-format', '--json-schema', '-m', '--effort', '--cwd', '-r', '-c', '--max-turns', '--best-of-n', '--worktree', '--worktree-ref', '--sandbox', '--permission-mode', '--no-subagents', '--agent', '--agents', '--allow', '--deny', '--disable-web-search', '--fork-session', '--experimental-memory', '--no-memory', '--no-plan', '--tools', '--disallowed-tools', '--always-approve', '--rules', '--verbatim'];

export function probeCapabilities(binary, run = runCommand) {
  const result = binary ? run(binary, ['--help'], { maxBuffer: 2 * 1024 * 1024, timeout: 10000 }) : null;
  const text = String(result?.stdout || '') + '\n' + String(result?.stderr || '');
  const usable = result?.status === 0 && /(?:options|flags|usage)\s*:/i.test(text) && /--[a-z]/i.test(text);
  const advertised = new Set(text.match(/--?[a-z][a-z0-9-]*/gi) || []);
  return Object.fromEntries(CLI_FLAGS.map(flag => [flag, usable ? advertised.has(flag) ? 'supported' : 'unsupported' : 'unknown']));
}
