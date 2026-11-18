import { describe, it, expect } from 'vitest';
import { lowlight } from './highlight';

describe('lowlight highlightAuto 复现', () => {
  it("highlightAuto('test line') 不抛异常", () => {
    expect(() => lowlight.highlightAuto('test line')).not.toThrow();
  });
  it("highlight('plaintext', ...) 不抛异常", () => {
    expect(() => lowlight.highlight('plaintext', 'test line')).not.toThrow();
  });
  it('plaintext 已注册', () => {
    expect(lowlight.registered('plaintext')).toBe(true);
  });
});
