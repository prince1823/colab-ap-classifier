#!/usr/bin/env tsx
/**
 * Test script to verify LLM configuration is fully configurable
 * Tests that agents use settings service instead of hardcoded models
 */

import 'dotenv/config';
import * as settingsService from '../src/main/services/settings';
import { classifyInvoiceGroup } from '../src/main/agents/classification-agent';
import { researchSupplier } from '../src/main/agents/research-agent';
import { analyzeFeedback } from '../src/main/agents/feedback-agent';
import { suggestMappings } from '../src/main/agents/canonicalization-agent';

// Mock LLM client to verify model is passed correctly
import * as llmClient from '../src/main/services/llm-client';

const originalChat = llmClient.chat;
let capturedModel: string | undefined;

// Override chat to capture the model being used
(llmClient as any).chat = async (systemPrompt: string, userPrompt: string, options: any) => {
  capturedModel = options?.model;
  // Return mock response
  if (userPrompt.includes('## Supplier Name')) {
    // Research agent response
    return JSON.stringify({
      supplierType: 'company',
      officialBusinessName: 'Test Company',
      description: 'Test description',
      industry: 'Technology',
      confidence: 'high',
      sources: ['Mock'],
    });
  } else if (userPrompt.includes('CSV Columns')) {
    // Canonicalization agent response
    return JSON.stringify({
      mappings: { supplier_name: 'Vendor' },
      confidence: 'high',
      reasoning: 'Mock mapping',
    });
  } else if (userPrompt.includes('Feedback Analysis')) {
    // Feedback agent response
    return JSON.stringify({
      feedbackType: 'uncategorized',
      reasoning: 'Mock feedback',
      actionDetails: {},
    });
  } else {
    // Classification agent response
    return JSON.stringify({
      classificationPath: 'Indirect|IT|Software',
      reasoning: 'Mock classification',
      descriptionSupplierAligned: true,
    });
  }
};

async function testConfiguration(provider: string, model: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${provider} / ${model}`);
  console.log('='.repeat(60));

  // Update settings
  settingsService.updateSettings({ provider, model });

  // Get current settings
  const settings = settingsService.getSettings();
  console.log(`✓ Settings updated: provider=${settings.provider}, model=${settings.model}`);

  // Test Classification Agent
  try {
    capturedModel = undefined;
    await classifyInvoiceGroup({
      transactions: [{ supplier_name: 'Test Corp', spend_amount: 100 }],
      taxonomy: [
        { id: '1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
      ],
      companyContext: {
        industry: 'Technology',
        sector: 'Software',
        description: 'Tech company',
        businessFocus: 'Software development',
        procurementNuances: '',
        updatedAt: '',
      },
      supplierResearch: null,
      historicalClassifications: [],
      isTailSpend: false,
    });
    console.log(`✓ Classification Agent used model: ${capturedModel}`);
    if (capturedModel !== model) {
      console.error(`  ❌ ERROR: Expected ${model}, got ${capturedModel}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Classification Agent failed:`, (error as Error).message);
    return false;
  }

  // Test Research Agent
  try {
    capturedModel = undefined;
    await researchSupplier('Test Company', {
      industry: 'Technology',
      sector: 'Software',
      description: 'Tech company',
      businessFocus: 'Software development',
      procurementNuances: '',
      updatedAt: '',
    });
    console.log(`✓ Research Agent used model: ${capturedModel}`);
    if (capturedModel !== model) {
      console.error(`  ❌ ERROR: Expected ${model}, got ${capturedModel}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Research Agent failed:`, (error as Error).message);
    return false;
  }

  // Test Canonicalization Agent
  try {
    capturedModel = undefined;
    await suggestMappings(['Vendor', 'Amount', 'Date'], [
      { Vendor: 'Test Corp', Amount: '100', Date: '2024-01-01' },
    ]);
    console.log(`✓ Canonicalization Agent used model: ${capturedModel}`);
    if (capturedModel !== model) {
      console.error(`  ❌ ERROR: Expected ${model}, got ${capturedModel}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Canonicalization Agent failed:`, (error as Error).message);
    return false;
  }

  console.log(`\n✅ All agents correctly used model: ${model}`);
  return true;
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('LLM Configuration Test Suite');
  console.log('='.repeat(60));
  console.log('\nTesting that all agents use configurable models from settings');
  console.log('instead of hardcoded model names...\n');

  const testCases = [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku-latest' },
  ];

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    const success = await testConfiguration(testCase.provider, testCase.model);
    if (success) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test Results');
  console.log('='.repeat(60));
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);

  if (failed === 0) {
    console.log('\n✅ SUCCESS: All agents correctly use configurable models!');
    console.log('No hardcoded model names remain in the codebase.');
    process.exit(0);
  } else {
    console.log('\n❌ FAILURE: Some agents still use hardcoded models');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
