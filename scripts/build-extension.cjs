// Simple build script for ReviveL - works on Node 18
// Runs after tsc to produce a loadable unpacked extension in dist/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  ensureDir(destDir);
  for (const file of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, dest);
    } else {
      copyFile(src, dest);
    }
  }
}

console.log('Building ReviveL extension...');

// tsc has already emitted JS to dist/ (do not clean here)
ensureDir(DIST);

const compiledJs = path.join(DIST, 'background.js');
if (!fs.existsSync(compiledJs)) {
  console.error('tsc did not produce expected JS. Run tsc first.');
  process.exit(1);
}

// 3. Copy icons
copyDir(path.join(ROOT, 'icons'), path.join(DIST, 'icons'));

// Fix ESM import specifiers for files that are in subdirs (popup/player)
// When loaded via html at root, using absolute /utils/... ensures correct resolution
// regardless of whether browser resolves relative to script or document.
function fixImportsForSubdirModules() {
  const filesToFix = [
    path.join(DIST, 'popup', 'popup.js'),
    path.join(DIST, 'player', 'player.js'),
  ];
  for (const file of filesToFix) {
    if (fs.existsSync(file)) {
      let content = fs.readFileSync(file, 'utf8');
      // Replace relative import of lbryApi with absolute from extension root
      content = content.replace(
        /from ['"]\.\.\/utils\/lbryApi(\.js)?['"]/g,
        "from '/utils/lbryApi.js'"
      );
      fs.writeFileSync(file, content);
    }
  }
}
fixImportsForSubdirModules();

// 4. Copy and adjust popup html
let popupHtml = fs.readFileSync(path.join(SRC, 'popup/index.html'), 'utf8');
// The script src in html is ./popup.ts -> we need to point to the compiled
popupHtml = popupHtml.replace('src="./popup.ts"', 'src="./popup/popup.js"');
fs.writeFileSync(path.join(DIST, 'popup.html'), popupHtml);  // flat for action

// Also keep structure
ensureDir(path.join(DIST, 'src/popup'));
fs.writeFileSync(path.join(DIST, 'src/popup/index.html'), popupHtml.replace('./popup/popup.js', '../popup/popup.js'));

// 5. Copy player html
let playerHtml = fs.readFileSync(path.join(SRC, 'player/index.html'), 'utf8');
playerHtml = playerHtml.replace('src="./player.ts"', 'src="./player/player.js"');
fs.writeFileSync(path.join(DIST, 'player.html'), playerHtml);
ensureDir(path.join(DIST, 'src/player'));
fs.writeFileSync(path.join(DIST, 'src/player/index.html'), playerHtml.replace('./player/player.js', '../player/player.js'));

// 5b. Copy overlay html (small floating iframe player)
let overlayHtml = fs.readFileSync(path.join(SRC, 'overlay.html'), 'utf8');
overlayHtml = overlayHtml.replace('src="./overlay/overlay.ts"', 'src="./overlay/overlay.js"');
fs.writeFileSync(path.join(DIST, 'overlay.html'), overlayHtml);
ensureDir(path.join(DIST, 'src/overlay'));
fs.writeFileSync(path.join(DIST, 'src/overlay/index.html'), overlayHtml.replace('./overlay/overlay.js', '../overlay/overlay.js'));

// 6. Copy options
let optionsHtml = fs.readFileSync(path.join(SRC, 'options/index.html'), 'utf8');
optionsHtml = optionsHtml.replace('src="./options.ts"', 'src="./options/options.js"');
fs.writeFileSync(path.join(DIST, 'options.html'), optionsHtml);
ensureDir(path.join(DIST, 'src/options'));
fs.writeFileSync(path.join(DIST, 'src/options/index.html'), optionsHtml.replace('./options/options.js', '../options/options.js'));

// 7. Create manifest for dist (adjust paths to match output layout)
let manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// Preserve the 'key' field (if present in src/manifest.json).
// This is only needed if you want unpacked loads to use the exact same ID
// as your published Chrome Web Store item.
// 
// IMPORTANT:
// - Do NOT put a placeholder or comment in "key" — Chrome will reject the manifest.
// - Only add the real public key (the long base64 string starting with MIIBIjAN...)
//   when you have extracted it from a .crx downloaded from your store item.
// - For normal development, leave "key" out of manifest.json.
//   Unpacked extensions will get a path-based ID (that's normal and fine).
const sourceKey = manifest.key;

// Full rewrite for packaged extension (all assets at dist root or subdirs)
manifest.action = {
  default_popup: "popup.html",
  default_title: "ReviveL - LBRY",
  default_icon: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png"
  }
};
manifest.background = {
  service_worker: "background.js",
  type: "module"
};
manifest.content_scripts = [
  {
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }
];
manifest.options_page = "options.html";
manifest.web_accessible_resources = [
  {
    "resources": ["player.html", "overlay.html", "icons/*"],
    "matches": ["<all_urls>"]
  }
];

manifest.permissions = [
  "contextMenus",
  "storage",
  "downloads",
  "tabs",
  "activeTab",
  "omnibox",
  "scripting",
  "nativeMessaging"
];

// Restore the key only if it looks like a real public key (starts with MIIBIjAN)
// This prevents broken placeholders from breaking the load.
if (sourceKey && typeof sourceKey === 'string' && sourceKey.startsWith('MIIBIjAN')) {
  manifest.key = sourceKey;
} else if (sourceKey) {
  console.warn('⚠️  Ignored invalid "key" value from source manifest (must be a real public key).');
}

// Keep other fields (permissions, host_permissions, protocol_handlers, name, etc.)
// Icons stay the same

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 8. Cleanup: remove unnecessary src/ copies (we use flat root files for the packaged extension)
const extraSrc = path.join(DIST, 'src');
if (fs.existsSync(extraSrc)) {
  fs.rmSync(extraSrc, { recursive: true, force: true });
}

console.log('✅ Build complete! dist/ is ready for unpacked load.');
console.log('Load in Chrome/Edge: chrome://extensions (enable Developer mode) -> Load unpacked -> choose the dist folder');
console.log('Protocol handler may need browser-specific flags (see README). New transparent logo applied.');
