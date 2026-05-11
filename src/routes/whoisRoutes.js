'use strict';

const { Router } = require('express');
const whois = require('whois');
const { successResponse, ApiError } = require('../utils/apiResponse');

const router = Router();

// WHOIS lookup endpoint
router.get('/whois', async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    throw new ApiError(400, 'domain query parameter is required');
  }

  // Clean domain
  const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];

  // Parse whois result manually
  const raw = await new Promise((resolve, reject) => {
    whois.lookup(cleanDomain, { timeout: 10000 }, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

  // Parse key fields from raw WHOIS text
  const parsed = parseWhoisText(raw, cleanDomain);

  return successResponse(res, {
    domain: cleanDomain,
    registrar: parsed.registrar || 'Unknown',
    createdDate: parsed.created || 'Unknown',
    expiryDate: parsed.expires || 'Unknown',
    updatedDate: parsed.updated || 'Unknown',
    nameservers: parsed.nameServers || [],
    status: parsed.status || 'Unknown',
    dnssec: parsed.dnssec || 'Unknown',
    raw: raw.substring(0, 2000), // First 2000 chars for reference
  }, 'WHOIS lookup successful');
});

// ─── Parse WHOIS text into structured data ───────────────────────────────────

function parseWhoisText(text, domain) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    if (
      key.includes('registrar') ||
      key.includes('sponsoring registrar') ||
      key.includes('registration service')
    ) {
      if (!result.registrar) result.registrar = value;
    }

    if (
      key.includes('created') ||
      key.includes('creation date') ||
      key.includes('registered')
    ) {
      if (!result.created) result.created = value;
    }

    if (
      key.includes('expir') ||
      key.includes('expiration date') ||
      key.includes('expires')
    ) {
      if (!result.expires) result.expires = value;
    }

    if (
      key.includes('updated') ||
      key.includes('modified') ||
      key.includes('last updated')
    ) {
      if (!result.updated) result.updated = value;
    }

    if (
      key.includes('name server') ||
      key.includes('nserver') ||
      key.includes('nameserver') ||
      key.includes('dns')
    ) {
      if (!result.nameServers) result.nameServers = [];
      result.nameServers.push(value);
    }

    if (key.includes('status') || key.includes('domain status')) {
      if (!result.status) result.status = value;
    }

    if (key.includes('dnssec')) {
      result.dnssec = value;
    }
  }

  // Deduplicate nameservers
  if (result.nameServers) {
    result.nameServers = [...new Set(result.nameServers)];
  }

  return result;
}

module.exports = router;
