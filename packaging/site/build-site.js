'use strict';

/**
 * Stages the landing page for deployment.
 *
 * The site source (site/) is what is committed: an HTML file, a stylesheet and
 * an icon, with no build step, exactly like ui/. This script only lays those
 * files out the way the host wants them:
 *
 *   dist-site/index.js        the Worker that serves the page
 *   dist-site/public/         the files a browser downloads
 *   dist-site/manifest.json   what to upload, and where each piece lives
 *
 * The staging folder is deliberately not hidden and is not committed: a deploy
 * reads it and throws it away. (.build/ does not work for this - the uploader
 * walks past directories whose name starts with a dot.)
 *
 * Usage:  node packaging/site/build-site.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'dist-site');

const pgk = require(path.join(ROOT, 'package.json'));

const ASSETS = ['index.html', 'styles.css', 'icon.png'];

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'public'), { recursive: true });

  const missing = ASSETS.filter((name) => !fs.existsSync(path.join(SOURCE, name)));
  if (missing.length) throw new Error(`site/ is missing: ${missing.join(', ')}`);

  for (const name of ASSETS) {
    fs.copyFileSync(path.join(SOURCE, name), path.join(OUT, 'public', name));
  }

  fs.copyFileSync(path.join(__dirname, 'worker.js'), path.join(OUT, 'index.js'));

  const manifest = {
    entrypoint: 'index.js',
    // Kept with the compatibility date the deployment was first tested against.
    compatibilityDate: '2026-10-17',
    modules: [{ name: 'index.js', type: 'esm', path: './index.js' }],
    assetsDirectory: './public',
    spa: false,
  };

  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // A page that links to nothing is the one failure mode a static site can have
  // and a deploy will not catch, so check every local reference resolves.
  const html = fs.readFileSync(path.join(SOURCE, 'index.html'), 'utf8');
  const referenced = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value && !value.startsWith('http') && !value.startsWith('mailto'));

  const broken = referenced.filter((value) => !fs.existsSync(path.join(SOURCE, value)));
  if (broken.length) throw new Error(`index.html points at files that do not exist: ${broken.join(', ')}`);

  console.log(`Staged dist-site/ for AirChat ${pgk.version}`);
  console.log(`  ${ASSETS.length} assets, ${referenced.length} local references, none broken`);
}

main();
