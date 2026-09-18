const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_PRESETS = new Set(["fast", "default", "deep", "grok"]);
const PRESET_EFFORT = new Map([
  ["fast", "low"],
  ["deep", "high"]
]);

export function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_PRESETS.has(normalized.toLowerCase()) ? null : normalized;
}

export function normalizeEffort(effort, modelPreset) {
  if (effort == null && modelPreset && PRESET_EFFORT.has(String(modelPreset).toLowerCase())) {
    return PRESET_EFFORT.get(String(modelPreset).toLowerCase());
  }
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Invalid --effort value: ${effort}. Expected one of ${[...VALID_EFFORTS].join(", ")}`);
  }
  return normalized === "max" ? "xhigh" : normalized;
}
