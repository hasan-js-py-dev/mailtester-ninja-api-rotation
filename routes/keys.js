/**
 * keys.js (router)
 *
 * Defines REST endpoints for interacting with MailTester subscription keys.
 * Routes include:
 *   - GET /key/available - obtain an available key within rate limits
 *   - GET /status - list status and counters for all keys
 *   - POST /keys - register or update a key
 *   - DELETE /keys/:id - remove a key
 *
 * Each handler delegates core logic to the keyManager and provides
 * comprehensive error handling and consistent JSON responses.
 */

const express = require('express');
const keyManager = require('../src/keyManager');
const logger = require('../src/logger');

const router = express.Router();
/**
 * GET /key/available
 *
 * Returns all available MailTester keys within rate limits. If none are
 * currently available the client receives an empty array with a status note.
 */
router.get('/key/available', async (req, res) => {
  try {
    const keys = await keyManager.getAvailableKeysSnapshot();
    const now = Date.now();
    const payload = keys.map((key) => ({
      ...key,
      nextRequestInMs: Math.max((key.nextRequestAllowedAt || 0) - now, 0)
    }));
    if (!payload.length) {
      return res.json({ status: 'wait', keys: [] });
    }
    return res.json({ status: 'ok', keys: payload });
  } catch (err) {
    logger.error({ msg: 'Error in /key/available', error: err?.message || err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /status
 *
 * Returns the status and usage metrics for all keys in the system.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await keyManager.getAllKeysStatus();
    return res.json(status);
  } catch (err) {
    logger.error({ msg: 'Error in /status', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/limits', async (_req, res) => {
  try {
    const limits = await keyManager.getKeyLimits();
    return res.json(limits);
  } catch (err) {
    logger.error({ msg: 'Error in /limits', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /keys
 *
 * Registers a new key or updates an existing one.  The request body must
 * include a `subscriptionId` and a valid `plan` ("pro" or "ultimate").
 */
router.post('/keys', async (req, res) => {
  // Accept either "subscriptionId" or "id" to support multiple naming conventions.
  const { subscriptionId, id, plan } = req.body || {};
  const subId = (subscriptionId || id || '').trim();
  if (!subId) {
    return res.status(400).json({ error: 'subscriptionId or id is required' });
  }
  const normalizedPlan = String(plan || '').toLowerCase();
  if (!['pro', 'ultimate'].includes(normalizedPlan)) {
    return res.status(400).json({ error: 'plan must be "pro" or "ultimate"' });
  }
  try {
    await keyManager.registerKey(subId, normalizedPlan);
    return res.status(201).json({ message: `Key ${subId} registered` });
  } catch (err) {
    logger.error({ msg: 'Error in POST /keys', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /keys/:id
 *
 * Deletes a key by subscription ID.  Returns a 200 status even if the key did
 * not previously exist.
 */
router.delete('/keys/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'id parameter is required' });
  }
  try {
    await keyManager.deleteKey(id);
    return res.json({ message: `Key ${id} deleted` });
  } catch (err) {
    logger.error({ msg: 'Error in DELETE /keys/:id', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
