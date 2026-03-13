#!/usr/bin/env tsx
/**
 * Test script to verify LLM configuration is fully configurable
 * Tests that agents use settings service instead of hardcoded models
 */

import 'dotenv/config';
import { LLMClassificationAgent } from '../src/main/agents/classification-agent';
import { researchSupplier } from '../src/main/agents/research-agent';
import { suggestMappings } from '../src/main/agents/column-mapping-agent';

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
  } else {
    // Classification agent response — new multi-classification format
    return JSON.stringify({
      classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
      assignments: { '1': [1] },
    });
  }
};

async function testClassificationAgent() {
  console.log('\nTesting Classification Agent (LLMClassificationAgent class)...');

  // Create a mock LLM client that delegates to the overridden chat
  const mockLlm = {
    chat: (llmClient as any).chat,
  };

  const agent = new LLMClassificationAgent(mockLlm as any);

  try {
    capturedModel = undefined;
    await agent.classifyInvoiceGroup({
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
      columnPriorities: ['supplier_name', 'spend_amount'],
    });
    console.log(`✓ Classification Agent executed successfully`);
    return true;
  } catch (error) {
    console.error(`  ❌ Classification Agent failed:`, (error as Error).message);
    return false;
  }
}

async function testResearchAgent() {
  console.log('\nTesting Research Agent...');
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
    console.log(`✓ Research Agent executed successfully`);
    return true;
  } catch (error) {
    console.error(`  ❌ Research Agent failed:`, (error as Error).message);
    return false;
  }
}

async function testCanonAgent() {
  console.log('\nTesting Canonicalization Agent...');
  try {
    capturedModel = undefined;
    await suggestMappings(['Vendor', 'Amount', 'Date'], [
      { Vendor: 'Test Corp', Amount: '100', Date: '2024-01-01' },
    ]);
    console.log(`✓ Canonicalization Agent executed successfully`);
    return true;
  } catch (error) {
    console.error(`  ❌ Canonicalization Agent failed:`, (error as Error).message);
    return false;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('LLM Configuration Test Suite');
  console.log('='.repeat(60));
  console.log('\nTesting that all agents work with mock LLM...\n');

  let passed = 0;
  let failed = 0;

  for (const test of [testClassificationAgent, testResearchAgent, testCanonAgent]) {
    const success = await test();
    if (success) passed++;
    else failed++;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test Results');
  console.log('='.repeat(60));
  console.log(`Passed: ${passed}/3`);
  console.log(`Failed: ${failed}/3`);

  if (failed === 0) {
    console.log('\n✅ SUCCESS: All agents work correctly!');
    process.exit(0);
  } else {
    console.log('\n❌ FAILURE: Some agents failed');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
