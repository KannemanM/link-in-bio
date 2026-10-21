#!/usr/bin/env node
import path from 'node:path';
import { loadDotEnv, readProfile, resolveConfig } from '../lib/config.mjs';

loadDotEnv();

try {
  const config = resolveConfig();
  const file = process.argv[2] ? path.resolve(process.argv[2]) : config.linksFile;
  const profile = readProfile(file);
  console.log(`links.json válido: ${profile.links.length} enlaces, ${profile.name}.`);
  console.log(`Archivo: ${file}`);
  for (const link of profile.links) {
    console.log(`  /go/${link.slug} → ${link.url}`);
  }
} catch (error) {
  console.error(`Error en links.json: ${error.message}`);
  process.exit(1);
}
