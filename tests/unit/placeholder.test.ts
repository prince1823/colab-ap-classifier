import { describe, it, expect } from 'vitest';

describe('Project scaffolding', () => {
  it('should pass a basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have correct project name', () => {
    const projectName = 'colab-ap-classifier';
    expect(projectName).toContain('colab');
    expect(projectName).toContain('classifier');
  });
});
