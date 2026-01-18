/**
 * LLM Service Tests
 *
 * Tests for multi-provider LLM functionality.
 * Note: Integration tests require API keys and are skipped by default.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMService } from '../llm/llm-service';
import { LLMConfig, AVAILABLE_MODELS } from '../llm/types';

describe('LLMService', () => {
  let service: LLMService;

  beforeEach(() => {
    service = new LLMService();
  });

  describe('Available Models', () => {
    it('should have Google models', () => {
      expect(AVAILABLE_MODELS.google).toContain('gemini-2.5-flash');
      expect(AVAILABLE_MODELS.google.length).toBeGreaterThan(0);
    });

    it('should have OpenAI models', () => {
      expect(AVAILABLE_MODELS.openai).toContain('gpt-4o');
      expect(AVAILABLE_MODELS.openai.length).toBeGreaterThan(0);
    });

    it('should have Anthropic models', () => {
      expect(AVAILABLE_MODELS.anthropic.some(m => m.includes('claude'))).toBe(true);
      expect(AVAILABLE_MODELS.anthropic.length).toBeGreaterThan(0);
    });
  });

  describe('Provider Detection', () => {
    it('should get available providers based on environment', () => {
      // This depends on actual environment variables
      const providers = service.getAvailableProviders();
      expect(typeof providers).toBe('object');
    });

    it('should detect Google provider when GEMINI_API_KEY is set', () => {
      // Mock environment
      const originalEnv = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'test-key';

      const newService = new LLMService();
      const providers = newService.getAvailableProviders();

      expect(providers.google).toBeDefined();

      // Restore
      if (originalEnv !== undefined) {
        process.env.GEMINI_API_KEY = originalEnv;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    });

    it('should detect OpenAI provider when OPENAI_API_KEY is set', () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      const newService = new LLMService();
      const providers = newService.getAvailableProviders();

      expect(providers.openai).toBeDefined();

      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('should detect Anthropic provider when ANTHROPIC_API_KEY is set', () => {
      const originalEnv = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const newService = new LLMService();
      const providers = newService.getAvailableProviders();

      expect(providers.anthropic).toBeDefined();

      if (originalEnv !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });
  });

  describe('JSON Parsing Utilities', () => {
    it('should repair single quotes to double quotes', () => {
      const input = "{'key': 'value'}";
      const repaired = service.repairJson(input);
      // The repair function converts : 'value' to : "value"
      expect(repaired).toContain('"value"');
    });

    it('should remove trailing commas', () => {
      const input = '{"key": "value",}';
      const repaired = service.repairJson(input);
      expect(repaired).not.toContain(',}');
    });

    it('should extract JSON from markdown code block', () => {
      const response = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
      const extracted = service.extractJsonFromResponse(response);
      expect(extracted).toEqual({ key: 'value' });
    });

    it('should extract raw JSON object', () => {
      const response = 'Some text {"key": "value"} more text';
      const extracted = service.extractJsonFromResponse(response);
      expect(extracted).toEqual({ key: 'value' });
    });

    it('should throw on no JSON found', () => {
      const response = 'No JSON here at all';
      expect(() => service.extractJsonFromResponse(response)).toThrow('No JSON found');
    });
  });

  describe('Config Validation', () => {
    it('should use default temperature if not provided', () => {
      const config: LLMConfig = {
        provider: 'google',
        model: 'gemini-2.5-flash',
      };
      const normalized = service.normalizeConfig(config);
      expect(normalized.temperature).toBe(0.2);
    });

    it('should use default maxTokens if not provided', () => {
      const config: LLMConfig = {
        provider: 'google',
        model: 'gemini-2.5-flash',
      };
      const normalized = service.normalizeConfig(config);
      expect(normalized.maxTokens).toBe(4096);
    });

    it('should preserve provided values', () => {
      const config: LLMConfig = {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.5,
        maxTokens: 2048,
      };
      const normalized = service.normalizeConfig(config);
      expect(normalized.temperature).toBe(0.5);
      expect(normalized.maxTokens).toBe(2048);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown provider', async () => {
      const config: LLMConfig = {
        provider: 'unknown' as any,
        model: 'test',
      };

      await expect(
        service.generate({
          prompt: 'test',
          systemPrompt: 'test',
          config,
        })
      ).rejects.toThrow('Unknown provider');
    });

    it('should throw error when API key is not configured', async () => {
      // Temporarily remove any API key
      const originalGemini = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      const newService = new LLMService();
      const config: LLMConfig = {
        provider: 'google',
        model: 'gemini-2.5-flash',
      };

      await expect(
        newService.generate({
          prompt: 'test',
          systemPrompt: 'test',
          config,
        })
      ).rejects.toThrow();

      // Restore
      if (originalGemini !== undefined) {
        process.env.GEMINI_API_KEY = originalGemini;
      }
    });
  });

  // Integration tests - only run if API keys are available
  describe.skipIf(!process.env.GEMINI_API_KEY)('Google Integration', () => {
    it('should generate response from Gemini', async () => {
      const config: LLMConfig = {
        provider: 'google',
        model: 'gemini-2.5-flash',
        temperature: 0.1,
        maxTokens: 100,
      };

      const response = await service.generate({
        prompt: 'Say "hello" and nothing else.',
        systemPrompt: 'You are a helpful assistant.',
        config,
      });

      expect(response.toLowerCase()).toContain('hello');
    }, 30000);
  });

  describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAI Integration', () => {
    it('should generate response from GPT', async () => {
      const config: LLMConfig = {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.1,
        maxTokens: 100,
      };

      const response = await service.generate({
        prompt: 'Say "hello" and nothing else.',
        systemPrompt: 'You are a helpful assistant.',
        config,
      });

      expect(response.toLowerCase()).toContain('hello');
    }, 30000);
  });

  describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Anthropic Integration', () => {
    it('should generate response from Claude', async () => {
      const config: LLMConfig = {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251101',
        temperature: 0.1,
        maxTokens: 100,
      };

      const response = await service.generate({
        prompt: 'Say "hello" and nothing else.',
        systemPrompt: 'You are a helpful assistant.',
        config,
      });

      expect(response.toLowerCase()).toContain('hello');
    }, 30000);
  });
});
