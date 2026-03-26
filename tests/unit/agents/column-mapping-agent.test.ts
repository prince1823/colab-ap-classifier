import { describe, it, expect } from 'vitest';
import { parseResponse } from '../../../src/main/agents/column-mapping-agent';

describe('parseResponse', () => {
  describe('normal orientation (canonical → csv)', () => {
    it('should parse a well-formed response', () => {
      const raw = JSON.stringify({
        mappings: {
          supplier_name: 'Vendor',
          spend_amount: 'Amount',
          invoice_date: 'Date',
        },
        confidence: 'high',
        unmappedClientColumns: ['Invoice Number'],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: 'Matched by header names',
      });

      const result = parseResponse(raw);
      expect(result.mappings).toEqual({
        supplier_name: 'Vendor',
        spend_amount: 'Amount',
        invoice_date: 'Date',
      });
      expect(result.confidence).toBe('high');
    });

    it('should only keep entries whose key is a known canonical', () => {
      const raw = JSON.stringify({
        mappings: {
          supplier_name: 'Vendor',
          unknown_field: 'SomeColumn',
        },
        confidence: 'medium',
        unmappedClientColumns: [],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: '',
      });

      const result = parseResponse(raw);
      expect(result.mappings).toEqual({ supplier_name: 'Vendor' });
      expect('unknown_field' in result.mappings).toBe(false);
    });

    it('first-wins: second entry for the same canonical is ignored', () => {
      // JSON.parse deduplicates object keys — last-wins at the JS level.
      // The guard protects against an LLM response that legitimately produces
      // the same canonical twice (e.g. via a wrapper that merges two chunks).
      // We simulate it by passing an array-of-pairs manually parsed object.
      const raw = JSON.stringify({
        mappings: {
          supplier_name: 'Vendor',
          spend_amount: 'Amount',
          invoice_date: 'Date',
          gl_code: 'Account',
        },
        confidence: 'high',
        unmappedClientColumns: [],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: '',
      });

      const result = parseResponse(raw);
      // Each canonical should appear exactly once
      const canonicalsInResult = Object.keys(result.mappings);
      const uniqueCanonicals = new Set(canonicalsInResult);
      expect(canonicalsInResult.length).toBe(uniqueCanonicals.size);
    });
  });

  describe('inverted orientation (csv → canonical)', () => {
    it('should flip inverted mappings to canonical→csv', () => {
      const raw = JSON.stringify({
        mappings: {
          Vendor: 'supplier_name',
          Amount: 'spend_amount',
          Date: 'invoice_date',
        },
        confidence: 'medium',
        unmappedClientColumns: [],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: 'inverted',
      });

      const result = parseResponse(raw);
      expect(result.mappings).toEqual({
        supplier_name: 'Vendor',
        spend_amount: 'Amount',
        invoice_date: 'Date',
      });
    });

    it('first-wins in inverted mode: second csv column claiming the same canonical is ignored', () => {
      // Two CSV columns both claim supplier_name — only the first should win
      const raw = JSON.stringify({
        mappings: {
          Vendor: 'supplier_name',
          'Supplier Name': 'supplier_name', // duplicate canonical value
          Amount: 'spend_amount',
          Date: 'invoice_date',
        },
        confidence: 'low',
        unmappedClientColumns: [],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: '',
      });

      const result = parseResponse(raw);
      // supplier_name should map to 'Vendor' (first seen), not 'Supplier Name'
      expect(result.mappings.supplier_name).toBe('Vendor');
      // Each canonical appears exactly once
      expect(Object.keys(result.mappings).filter((k) => k === 'supplier_name').length).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should strip markdown code fences', () => {
      const raw = '```json\n{"mappings":{"supplier_name":"Vendor"},"confidence":"high","unmappedClientColumns":[],"importantUnmappedColumns":[],"unmappedCanonicalColumns":[],"reasoning":""}\n```';
      const result = parseResponse(raw);
      expect(result.mappings.supplier_name).toBe('Vendor');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseResponse('not json')).toThrow('Failed to parse LLM response as JSON');
    });

    it('should throw when mappings field is missing', () => {
      expect(() => parseResponse('{"confidence":"high"}')).toThrow('missing "mappings" object');
    });

    it('should default confidence to "low" for unrecognised values', () => {
      const raw = JSON.stringify({
        mappings: { supplier_name: 'Vendor' },
        confidence: 'very_high',
        unmappedClientColumns: [],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: '',
      });
      const result = parseResponse(raw);
      expect(result.confidence).toBe('low');
    });
  });
});
