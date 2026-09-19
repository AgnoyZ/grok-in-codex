import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function binaryAvailable(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 && Boolean(result.stdout.trim());
}

export function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeout,
    windowsHide: true,
    stdio: options.stdio
  });
}

export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result, command, args));
  }
  return result;
}

export function formatCommandFailure(result, command, args = []) {
  const label = [command, ...args].filter(Boolean).join(" ");
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const details = stderr || stdout || `exit code ${result.status}`;
  return `${label || "command"} failed: ${details}`;
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: options.stdio ?? "ignore"
  });
  child.unref();
  return child;
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch { return null; }
}

export function isSameProcess(pid, pidStartTime, { alive = isProcessRunning, startTime = getProcessStartTime } = {}) {
  if (!alive(pid)) return false;
  if (pidStartTime == null) return true;
  const current = startTime(pid);
  // Unknown identity (permissions/platform) is conservatively still alive.
  return current == null || current === pidStartTime;
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).status === 0;
  }
  try {
    // Negative PID targets the process group when the child was detached.
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function writePidFile(filePath, pid) {
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

export function readPidFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) ? pid : null;
}
