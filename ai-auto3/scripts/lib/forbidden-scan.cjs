'use strict';

const fs = require('fs');

/**
 * @param {object} obj
 * @param {string[]} patterns lower-case substrings for keys/values (leaf strings)
 * @returns {{ hit: boolean, path: string, detail: string }[]}
 */
function scanJsonForForbidden(obj, patterns, pathPrefix = '$') {
  const hits = [];
  const pats = (patterns || []).map((p) => String(p).toLowerCase());

  function walk(node, pth) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const low = node.toLowerCase();
      for (const pat of pats) {
        if (pat && low.includes(pat)) {
          hits.push({ hit: true, path: pth, detail: `value contains forbidden pattern "${pat}"` });
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pth}[${i}]`));
      return;
    }
    for (const k of Object.keys(node)) {
      const kl = k.toLowerCase();
      for (const pat of pats) {
        if (pat && kl.includes(pat)) {
          hits.push({ hit: true, path: `${pth}.${k}`, detail: `key matches forbidden pattern "${pat}"` });
        }
      }
      walk(node[k], `${pth}.${k}`);
    }
  }

  walk(obj, pathPrefix);
  return hits;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { scanJsonForForbidden, loadJson };
