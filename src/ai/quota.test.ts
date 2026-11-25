import { describe, expect, it } from 'vitest';
import { isQuotaError, quotaRetrySeconds } from './hybrid';

describe('the AI running out of its daily quota', () => {
  const msg = 'Error fetching ...: [429 ] You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20 ... Please retry in 17h13m6.988975703s. "retryDelay":"61986s"';
  it('is told apart from the model being busy', () => {
    expect(isQuotaError(msg)).toBe(true);
    expect(isQuotaError('[500 ] This model is currently experiencing high demand.')).toBe(false);
  });
  it('reads how long Google says to wait', () => {
    expect(Math.round(quotaRetrySeconds(msg))).toBe(17 * 3600 + 13 * 60 + 7);
    expect(quotaRetrySeconds('"retryDelay":"120s"')).toBe(120);
    expect(quotaRetrySeconds('no hint')).toBe(3600);
  });
});
