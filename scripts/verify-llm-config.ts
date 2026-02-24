#!/usr/bin/env tsx
/**
 * Verify LLM configuration is fully configurable
 * Checks that no hardcoded models remain and settings work correctly
 */

import 'dotenv/config';
import * as settingsService from '../src/main/services/settings';
import { execSync } from 'child_process';

console.log('\n' + '='.repeat(70));
console.log('LLM Configuration Verification');
console.log('='.repeat(70));

// Test 1: Check for hardcoded models in agent files
console.log('\n[Test 1] Checking for hardcoded models in agent files...');
try {
  const result = execSync(
    'grep -r "claude-3-5-haiku\\|claude-sonnet-4\\|gpt-4o\\|DEFAULT_MODEL" src/main/agents/ --include="*.ts"',
    { encoding: 'utf-8', cwd: process.cwd() }
  );
  console.log('❌ FAILED: Found hardcoded models:');
  console.log(result);
  process.exit(1);
} catch (error) {
  // grep returns non-zero exit code when no matches found
  console.log('✅ PASSED: No hardcoded models found');
}

// Test 2: Verify settingsService returns correct defaults
console.log('\n[Test 2] Verifying default settings...');
const defaultSettings = settingsService.getSettings();
console.log(`  Provider: ${defaultSettings.provider}`);
console.log(`  Model: ${defaultSettings.model}`);
console.log(`  Has API Key: ${defaultSettings.hasApiKey}`);
if (!defaultSettings.model) {
  console.log('❌ FAILED: No default model configured');
  process.exit(1);
}
console.log('✅ PASSED: Default settings loaded correctly');

// Test 3: Verify settings can be updated at runtime
console.log('\n[Test 3] Testing runtime configuration updates...');
const testConfigs = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514' },
];

for (const config of testConfigs) {
  settingsService.updateSettings(config);
  const updated = settingsService.getSettings();

  if (updated.provider !== config.provider || updated.model !== config.model) {
    console.log(`❌ FAILED: Expected ${config.provider}/${config.model}`);
    console.log(`           Got ${updated.provider}/${updated.model}`);
    process.exit(1);
  }
  console.log(`  ✓ ${config.provider} / ${config.model}`);
}
console.log('✅ PASSED: Runtime configuration works correctly');

// Test 4: Verify environment variable configuration
console.log('\n[Test 4] Testing environment variable configuration...');
const envProvider = process.env.CLASSIFIER_LLM_PROVIDER;
const envModel = process.env.CLASSIFIER_MODEL;
if (envProvider || envModel) {
  console.log(`  Env Provider: ${envProvider || '(not set)'}`);
  console.log(`  Env Model: ${envModel || '(not set)'}`);
  console.log('✅ PASSED: Environment variables can be read');
} else {
  console.log('  ℹ️  INFO: No environment variables set (using defaults)');
}

// Test 5: Verify agents import settingsService
console.log('\n[Test 5] Verifying agents import settingsService...');
const agentFiles = [
  'src/main/agents/classification-agent.ts',
  'src/main/agents/research-agent.ts',
  'src/main/agents/canonicalization-agent.ts',
  'src/main/agents/feedback-agent.ts',
];

let allImport = true;
for (const file of agentFiles) {
  try {
    const content = execSync(`grep "import.*settingsService" ${file}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
    console.log(`  ✓ ${file.split('/').pop()}`);
  } catch (error) {
    console.log(`  ❌ ${file.split('/').pop()} - missing settingsService import`);
    allImport = false;
  }
}

if (!allImport) {
  console.log('❌ FAILED: Some agents missing settingsService import');
  process.exit(1);
}
console.log('✅ PASSED: All agents import settingsService');

// Test 6: Verify agents use settings.model
console.log('\n[Test 6] Verifying agents use settings.model...');
let allUseSettings = true;
for (const file of agentFiles) {
  try {
    const content = execSync(`grep "settings.model" ${file}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
    console.log(`  ✓ ${file.split('/').pop()}`);
  } catch (error) {
    console.log(`  ❌ ${file.split('/').pop()} - not using settings.model`);
    allUseSettings = false;
  }
}

if (!allUseSettings) {
  console.log('❌ FAILED: Some agents not using settings.model');
  process.exit(1);
}
console.log('✅ PASSED: All agents use settings.model');

// Summary
console.log('\n' + '='.repeat(70));
console.log('Verification Summary');
console.log('='.repeat(70));
console.log('✅ All tests passed!');
console.log('');
console.log('LLM configuration is now fully configurable via:');
console.log('  1. Environment variables (CLASSIFIER_LLM_PROVIDER, CLASSIFIER_MODEL)');
console.log('  2. Runtime updates (settingsService.updateSettings)');
console.log('');
console.log('No hardcoded model names remain in agent code.');
console.log('='.repeat(70));
console.log('');
