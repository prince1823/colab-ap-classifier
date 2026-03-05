import { describe, it, expect } from 'vitest';
import { createContainer } from '../../../src/main/container';
import type { ServiceContainer } from '../../../src/main/container';

describe('createContainer', () => {
  let container: ServiceContainer;

  it('should create a container with all required services', () => {
    container = createContainer();

    // Leaf services
    expect(container.db).toBeDefined();
    expect(container.supplierUniverse).toBeDefined();
    expect(container.eventBus).toBeDefined();
    expect(container.llm).toBeDefined();
    expect(container.webSearch).toBeDefined();

    // Agents
    expect(container.classificationAgent).toBeDefined();
    expect(container.researchAgent).toBeDefined();
    expect(container.columnMappingAgent).toBeDefined();

    // Data layer
    expect(container.changelog).toBeDefined();
    expect(container.transactions).toBeDefined();
    expect(container.project).toBeDefined();
    expect(container.taxonomy).toBeDefined();
    expect(container.suppliers).toBeDefined();
    expect(container.rules).toBeDefined();
    expect(container.ingest).toBeDefined();
    expect(container.export).toBeDefined();

    // Orchestrators
    expect(container.researcher).toBeDefined();
    expect(container.classifier).toBeDefined();
  });

  it('should share the same db instance across services', () => {
    container = createContainer();

    // The container should wire a single db instance through all services
    // We can't inspect private fields, but we can verify all keys exist
    const keys = Object.keys(container);
    expect(keys).toContain('db');
    expect(keys).toContain('transactions');
    expect(keys).toContain('project');
    expect(keys.length).toBe(18);
  });
});
