const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('./logger');
const keyManager = require('./keyManager');

// Small debounce helper so rapid successive change events only trigger one sync.
function createDebounced(fn, delay) {
  let timer = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delay);
  };
}

function parseEnvFile(envPath) {
  try {
    const fileContents = fs.readFileSync(envPath, 'utf8');
    return dotenv.parse(fileContents);
  } catch (err) {
    logger.error({ msg: 'Failed to read .env file for watcher', path: envPath, error: err.message });
    return null;
  }
}

function parseKeysFromEnv(envVars, envDir) {
  if (!envVars) {
    return [];
  }

  const defaultPlan = String(envVars.MAILTESTER_DEFAULT_PLAN || 'ultimate').toLowerCase();
  const normalizePlan = (plan) => (String(plan || '').toLowerCase() === 'pro' ? 'pro' : 'ultimate');

  let rawJson = envVars.MAILTESTER_KEYS_JSON || '';
  const jsonPath = envVars.MAILTESTER_KEYS_JSON_PATH;
  if (!rawJson && jsonPath) {
    try {
      const filePath = path.resolve(envDir || process.cwd(), jsonPath);
      rawJson = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.error({ msg: 'Failed to read MAILTESTER_KEYS_JSON_PATH for watcher', error: err.message, jsonPath });
    }
  }

  const jsonKeys = [];
  if (rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const id = String(entry?.id || '').trim();
          if (!id) continue;
          jsonKeys.push({ id, plan: normalizePlan(entry?.plan || defaultPlan) });
        }
      }
    } catch (err) {
      logger.error({ msg: 'Failed to parse MAILTESTER_KEYS_JSON while watching', error: err.message });
    }
  }
  if (jsonKeys.length) {
    return jsonKeys;
  }

  const csvRaw = envVars.MAILTESTER_KEYS_WITH_PLAN || '';
  if (csvRaw.trim()) {
    const csvKeys = [];
    const entries = csvRaw.split(',').map((pair) => pair.trim()).filter(Boolean);
    for (const entry of entries) {
      const [idPart, planPart] = entry.split(':');
      const id = String(idPart || '').trim();
      if (!id) continue;
      csvKeys.push({ id, plan: normalizePlan(planPart || defaultPlan) });
    }
    if (csvKeys.length) {
      return csvKeys;
    }
  }

  const listRaw = envVars.MAILTESTER_KEYS || '';
  if (listRaw.trim()) {
    const listKeys = listRaw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, plan: normalizePlan(defaultPlan) }));
    return listKeys;
  }

  return [];
}

async function performSync(envPath) {
  const envDir = path.dirname(envPath);
  const envVars = parseEnvFile(envPath);
  const desiredKeys = parseKeysFromEnv(envVars, envDir);

  const desiredMap = new Map();
  for (const key of desiredKeys) {
    desiredMap.set(key.id, key.plan);
  }
  const existing = await keyManager.getAllKeysStatus();
  const existingMap = new Map(existing.map((entry) => [entry.subscriptionId, entry.plan]));

  for (const [subscriptionId, plan] of desiredMap.entries()) {
    try {
      const currentPlan = existingMap.get(subscriptionId);
      if (currentPlan && currentPlan === plan) {
        logger.debug({ msg: 'Watcher: key already in desired state', subscriptionId });
        continue;
      }
      await keyManager.registerKey(subscriptionId, plan);
      logger.info({ msg: 'Watcher: applied key from .env', subscriptionId, plan });
    } catch (err) {
      logger.error({ msg: 'Watcher: failed to register key', subscriptionId, error: err.message });
    }
  }

  for (const subscriptionId of existingMap.keys()) {
    if (desiredMap.has(subscriptionId)) {
      continue;
    }
    try {
      await keyManager.deleteKey(subscriptionId);
      logger.info({ msg: 'Watcher: deleted key no longer in .env', subscriptionId });
    } catch (err) {
      logger.error({ msg: 'Watcher: failed to delete stale key', subscriptionId, error: err.message });
    }
  }
}

async function startWatching(dotenvPath) {
  const absolutePath = path.resolve(dotenvPath || path.join(process.cwd(), '.env'));
  if (!fs.existsSync(absolutePath)) {
    logger.warn({ msg: 'Watcher .env path does not exist; skipping', path: absolutePath });
    return async () => {};
  }

  let closed = false;
  const runSync = () => {
    performSync(absolutePath).catch((err) => {
      logger.error({ msg: 'Watcher sync error', error: err.message });
    });
  };

  const debouncedSync = createDebounced(runSync, 250);
  runSync();

  const watcher = fs.watch(absolutePath, (eventType) => {
    if (eventType === 'change' || eventType === 'rename') {
      debouncedSync();
    }
  });

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    watcher.close();
  };

  return cleanup;
}

module.exports = { startWatching };
