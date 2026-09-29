// ============================================================
// Utils Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import { generateId, formatDate, truncate, sleep, deepClone } from './index';

describe('Utils', () => {
  // generateId tests
  describe('generateId()', () => {
    it('should return a string', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      expect(ids.size).toBe(100); // All should be unique
    });
  });

  // formatDate tests
  describe('formatDate()', () => {
    it('should format a date as string', () => {
      const date = new Date('2024-01-15T14:30:00');
      const formatted = formatDate(date);

      expect(typeof formatted).toBe('string');
      // Should contain the year, month, day, hour, minute
      expect(formatted).toContain('2024');
    });

    it('should handle current date', () => {
      const now = new Date();
      const formatted = formatDate(now);

      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(5);
    });
  });

  // truncate tests
  describe('truncate()', () => {
    it('should not modify short strings', () => {
      const result = truncate('Hello', 10);
      expect(result).toBe('Hello');
    });

    it('should truncate long strings', () => {
      const longString = 'This is a very long string that needs to be truncated';
      const result = truncate(longString, 20);

      expect(result.length).toBe(20);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should add ellipsis when truncating', () => {
      const result = truncate('Hello World!', 8); // 5 chars + '...' = 8 total
      
      expect(result).toBe('Hello...');
    });

    it('should handle exact length match', () => {
      const result = truncate('Hello', 5);
      expect(result).toBe('Hello');
    });
  });

  // sleep tests
  describe('sleep()', () => {
    it('should resolve after given milliseconds', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });

    it('should not block execution (returns Promise)', async () => {
      let resolved = false;
      
      const promise = sleep(10).then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false); // Should not be resolved immediately
      
      await promise;
      expect(resolved).toBe(true);
    });
  });

  // deepClone tests
  describe('deepClone()', () => {
    it('should clone a simple object', () => {
      const original = { name: 'Test', value: 42 };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original); // Different reference
    });

    it('should handle nested objects', () => {
      const original = {
        user: {
          name: 'Alice',
          settings: { theme: 'dark' },
        },
      };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned.user.settings).not.toBe(original.user.settings); // Deep clone
    });

    it('should handle arrays', () => {
      const original = [1, 2, { nested: true }];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned[2]).not.toBe(original[2]); // Deep clone array elements
    });

    it('should handle empty objects and arrays', () => {
      expect(deepClone({})).toEqual({});
      expect(deepClone([])).toEqual([]);
    });

    it('should preserve null values', () => {
      const original = { value: null };
      const cloned = deepClone(original);

      expect(cloned.value).toBeNull();
    });
  });
});
