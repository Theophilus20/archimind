import { describe, expect, it } from 'vitest';
import { parseLength } from '../detect/units';

describe('parseLength', () => {
  it('reads feet and inches as drawn on imperial plans', () => {
    expect(parseLength(`41'0"`, 'm')).toBeCloseTo(12496.8, 1);
    expect(parseLength(`30' 10"`, 'mm')).toBeCloseTo(9398, 0);
    expect(parseLength('41 ft 6 in', 'm')).toBeCloseTo(12649.2, 1);
  });
  it('uses the chosen unit for bare numbers', () => {
    expect(parseLength('12.5', 'm')).toBe(12500);
    expect(parseLength('12000', 'mm')).toBe(12000);
    expect(parseLength('41', 'ft')).toBeCloseTo(12496.8, 1);
  });
  it('accepts explicit metric units', () => {
    expect(parseLength('3.6 m', 'mm')).toBe(3600);
    expect(parseLength('360 cm', 'm')).toBe(3600);
    expect(parseLength('', 'm')).toBe(0);
  });
});
