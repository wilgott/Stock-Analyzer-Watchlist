const fs = require('node:fs');
const path = require('node:path');

function parseEnvContent(content) {
  const env = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[match[1]] = value;
  }

  return env;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvContent(fs.readFileSync(filePath, 'utf8'));
}

function loadProjectEnv(projectDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    ...loadEnvFile(path.join(projectDir, '.env')),
    ...loadEnvFile(path.join(projectDir, '.env.local')),
  };
}

module.exports = {
  loadEnvFile,
  loadProjectEnv,
  parseEnvContent,
};
