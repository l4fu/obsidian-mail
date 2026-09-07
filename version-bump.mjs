const fs = require('fs');
const { execSync } = require('child_process');

// Read the current version from manifest.json
const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));
// Read the current version from package.json
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

// Increment the version number
const currentVersion = manifest.version;
const versionParts = currentVersion.split('.');
versionParts[2] = parseInt(versionParts[2]) + 1;
const newVersion = versionParts.join('.');

// Update manifest.json
manifest.version = newVersion;
fs.writeFileSync('./manifest.json', JSON.stringify(manifest, null, 2));

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync('./package.json', JSON.stringify(packageJson, null, 2));

// Commit the changes
execSync('git add manifest.json package.json');
execSync(`git commit -m "Bump version to ${newVersion}"`);

console.log(`Version bumped to ${newVersion}`);