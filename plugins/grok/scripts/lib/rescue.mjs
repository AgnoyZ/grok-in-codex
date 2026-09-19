export function resolveRescueMode(options = {}, env = process.env) {
  const readOnly = Boolean(options['read-only']) || options['permission-mode'] === 'plan' || Boolean(options.plan);
  if (readOnly) return { mode: 'readOnly', worktree: false };
  const explicit = options['read-only'] !== undefined || options.worktree !== undefined || options.write !== undefined;
  const worktree = options['worktree-name'] || options.worktree || (!explicit && env.GROK_RESCUE_DEFAULT_WRITE !== '1');
  return { mode: worktree ? 'worktree' : 'direct', worktree: worktree || false };
}
