#!/usr/bin/env node
import { resolveConfig, loadDotEnv, prepareStorage, readProfile } from '../lib/config.mjs';
import { writeFavicon, writeMonogram, writeOg } from '../lib/assets.mjs';

loadDotEnv();

const force = process.argv.includes('--force');
const config = resolveConfig();
prepareStorage(config);
const profile = readProfile(config.linksFile);

const created = writeMonogram({ name: profile.name, file: config.avatarFile, force });
if (!created) {
  console.log(
    `Avatar existente conservado: ${config.avatarFile} (usa --force para regenerar el monograma)`,
  );
}

writeFavicon({ name: profile.name, file: config.faviconFile });
await writeOg({ profile, config });

console.log('\nListo. Si cambiaste el avatar o el perfil, reinicia el contenedor o el servidor.');
