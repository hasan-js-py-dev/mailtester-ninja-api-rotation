const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const keyManager = require('./keyManager');
const logger = require('./logger');

const TEST_EMAIL = 'contact@daddy-leads.com';
const HEALTHCHECK_INTERVAL_CRON = '0 0 * * *';
const DEFAULT_DELAY_MS = 200;

function readEnv(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    return content;
  } catch (err) {
    logger.error({ msg: 'HealthChecker: failed to read .env', path: envPath, error: err.message });
    return null;
  }
}

function writeEnv(envPath, content) {
  try {
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    logger.error({ msg: 'HealthChecker: failed to write .env', path: envPath, error: err.message });
  }
}

function parseEnvLines(content) {
  const lines = content.split(/\r?\n/);
  const result = { lines, map: new Map() };
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      result.map.set(match[1], { value: match[2], index: idx });
    }
  });
  return result;
}

function stringifyEnv(parsed) {
  return parsed.lines.join('\n');
}

function sanitizeValue(value) {
  if (!value) return '';
  return value.trim();
}

function removeIdFromJson(value, id) {
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) {
      const filtered = arr.filter((item) => item?.id !== id);
      if (filtered.length !== arr.length) {
        return JSON.stringify(filtered);
      }
    }
  } catch (err) {
    logger.warn({ msg: 'HealthChecker: failed to parse MAILTESTER_KEYS_JSON while removing id', error: err.message });
  }
  return value;
}

function removeIdFromCsv(value, id) {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((entry) => entry.split(':')[0]?.trim() !== id);
  return entries.join(',');
}

function removeIdFromList(value, id) {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((entry) => entry !== id);
  return entries.join(',');
}

function updateEnvVariable(parsed, key, newValue) {
  const entry = parsed.map.get(key);
  if (!entry) {
    return;
  }
  parsed.lines[entry.index] = `${key}=${newValue}`;
  entry.value = newValue;
}

function removeSubscriptionFromEnv(envContent, id) {
  const parsed = parseEnvLines(envContent);
  const priorityKeys = ['MAILTESTER_KEYS_JSON', 'MAILTESTER_KEYS_WITH_PLAN', 'MAILTESTER_KEYS'];
  let modified = false;
  for (const envKey of priorityKeys) {
    const entry = parsed.map.get(envKey);
    if (!entry) continue;
    const originalValue = sanitizeValue(entry.value);
    if (!originalValue) continue;
    let updatedValue = originalValue;
    if (envKey === 'MAILTESTER_KEYS_JSON') {
      updatedValue = removeIdFromJson(originalValue, id);
    } else if (envKey === 'MAILTESTER_KEYS_WITH_PLAN') {
      updatedValue = removeIdFromCsv(originalValue, id);
    } else if (envKey === 'MAILTESTER_KEYS') {
      updatedValue = removeIdFromList(originalValue, id);
    }
    if (updatedValue !== originalValue) {
      updateEnvVariable(parsed, envKey, updatedValue);
      modified = true;
      break;
    }
  }
  return { content: stringifyEnv(parsed), modified };
}

async function validateKey(subscriptionId) {
  try {
    const url = `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(TEST_EMAIL)}&key=${encodeURIComponent(subscriptionId)}`;
    const response = await axios.get(url, { timeout: 10000 });
    if (response.status === 200 && response.data) {
      const code = response.data.code;
      return code === 'ok';
    }
    return false;
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      return false;
    }
    logger.warn({ msg: 'HealthChecker: API request error', subscriptionId, error: err.message });
    return false;
  }
}

async function performHealthCheck(envPath) {
  const keys = await keyManager.getAllKeysStatus();
  if (!keys.length) {
    return;
  }
  let envContent = readEnv(envPath);
  if (envContent === null) {
    envContent = '';
  }
  const cleanedIds = [];
  for (const key of keys) {
    const subscriptionId = key.subscriptionId;
    const isValid = await validateKey(subscriptionId);
    if (!isValid) {
      try {
        await keyManager.deleteKey(subscriptionId);
        cleanedIds.push(subscriptionId);
        const result = removeSubscriptionFromEnv(envContent, subscriptionId);
        if (result.modified) {
          envContent = result.content;
        }
        logger.warn({ msg: 'HealthChecker: removed inactive key', subscriptionId });
      } catch (err) {
        logger.error({ msg: 'HealthChecker: failed to delete key', subscriptionId, error: err.message });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_DELAY_MS));
  }
  if (cleanedIds.length) {
    writeEnv(envPath, envContent);
  }
}

function startScheduler(dotenvPath) {
  const envPath = path.resolve(dotenvPath || path.join(process.cwd(), '.env'));
  const runCheck = () => {
    performHealthCheck(envPath).catch((err) => {
      logger.error({ msg: 'HealthChecker: unexpected error', error: err.message });
    });
  };
  runCheck();
  const task = cron.schedule(HEALTHCHECK_INTERVAL_CRON, runCheck, { timezone: 'UTC' });
  const stop = async () => {
    task.stop();
  };
  return stop;
}

module.exports = { startScheduler };
