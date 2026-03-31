import { describe, it, expect } from 'vitest';
import { detectMasterDateFormat } from '../../../src/main/utils/date-format';

describe('detectMasterDateFormat', () => {
  describe('ISO formats', () => {
    it('detects YYYY-MM-DD', () => {
      expect(detectMasterDateFormat(['2024-01-15', '2024-03-20'])).toBe('%Y-%m-%d');
    });

    it('detects YYYY/MM/DD', () => {
      expect(detectMasterDateFormat(['2024/01/15', '2024/03/20'])).toBe('%Y/%m/%d');
    });
  });

  describe('named month formats', () => {
    it('detects DD-Mon-YYYY', () => {
      expect(detectMasterDateFormat(['15-Jan-2024', '20-Mar-2024'])).toBe('%d-%b-%Y');
    });

    it('detects Mon DD YYYY', () => {
      expect(detectMasterDateFormat(['Jan 15 2024', 'Mar 20 2024'])).toBe('%b %d %Y');
    });

    it('detects Mon DD, YYYY (with comma)', () => {
      expect(detectMasterDateFormat(['Jan 15, 2024', 'Mar 20, 2024'])).toBe('%b %d %Y');
    });
  });

  describe('US slash format', () => {
    it('detects MM/DD/YYYY when day > 12 in position 2', () => {
      expect(detectMasterDateFormat(['01/15/2024', '03/25/2024'])).toBe('%m/%d/%Y');
    });

    it('returns US default when all values are ambiguous (all ≤ 12)', () => {
      expect(detectMasterDateFormat(['01/02/2024', '03/04/2024'])).toBe('%m/%d/%Y');
    });
  });

  describe('EU slash format', () => {
    it('detects DD/MM/YYYY when day > 12 in position 1', () => {
      expect(detectMasterDateFormat(['15/01/2024', '25/03/2024'])).toBe('%d/%m/%Y');
    });
  });

  describe('dash-separated ambiguous', () => {
    it('detects MM-DD-YYYY when day > 12 in position 2', () => {
      expect(detectMasterDateFormat(['01-15-2024', '03-25-2024'])).toBe('%m-%d-%Y');
    });

    it('detects DD-MM-YYYY when day > 12 in position 1', () => {
      expect(detectMasterDateFormat(['15-01-2024', '25-03-2024'])).toBe('%d-%m-%Y');
    });
  });

  describe('null cases', () => {
    it('returns null for empty array', () => {
      expect(detectMasterDateFormat([])).toBeNull();
    });

    it('returns null for all empty strings', () => {
      expect(detectMasterDateFormat(['', '  ', ''])).toBeNull();
    });

    it('returns null for garbled values', () => {
      expect(detectMasterDateFormat(['not-a-date', 'also-not', 'hello'])).toBeNull();
    });
  });

  describe('mixed valid/empty values', () => {
    it('ignores empty strings and detects from non-empty', () => {
      expect(detectMasterDateFormat(['2024-01-15', '', '2024-03-20'])).toBe('%Y-%m-%d');
    });

    it('ignores null-ish values', () => {
      expect(detectMasterDateFormat([undefined as unknown as string, '2024-01-15'])).toBe('%Y-%m-%d');
    });
  });
});
