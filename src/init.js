#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');

/**
 * Anyone who knows the ntfy topic can read every alert, which includes your
 * approximate location. So it is generated per install and never committed:
 * .env.example ships a blank, and this fills it in.
 */
const newTopic = () => `lookup-${crypto.randomBytes(6).toString('hex')}`;

if (fs.existsSync(TARGET)) {
  console.error('.env already exists - refusing to overwrite it.');
  console.error('Delete it first if you really want a fresh one.');
  process.exit(1);
}

if (!fs.existsSync(EXAMPLE)) {
  console.error('.env.example is missing; cannot generate .env from it.');
  process.exit(1);
}

const topic = newTopic();
const content = fs
  .readFileSync(EXAMPLE, 'utf8')
  .replace(/^NTFY_TOPIC=.*$/m, `NTFY_TOPIC=${topic}`);

fs.writeFileSync(TARGET, content);

console.log('Created .env');
console.log(`Generated a private ntfy topic: ${topic}`);
console.log('');
console.log('Next:');
console.log('  1. Set LAT and LON in .env to your coordinate.');
console.log(`  2. Install the ntfy app and subscribe to:  ${topic}`);
console.log('  3. npm run test-notify');
console.log('');
console.log('Keep that topic private - it is the only thing protecting your alerts.');
