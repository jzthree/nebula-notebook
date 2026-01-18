/**
 * Multi-Provider LLM Service
 *
 * Supports Google Gemini, OpenAI, and Anthropic.
 * Node.js port of the Python LLMService.
 */

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  LLMConfig,
  LLMProvider,
  ImageInput,
  ChatMessage,
  GenerateOptions,
  ChatOptions,
  GenerateStructuredOptions,
  AVAILABLE_MODELS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from './types';

export class LLMService {
  private googleClient: GoogleGenAI | null = null;
  private openaiClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;

  /**
   * Get or create Google GenAI client
   */
  private getGoogleClient(apiKey?: string): GoogleGenAI {
    if (apiKey) {
      // Create new client with provided key (don't cache)
      return new GoogleGenAI({ apiKey });
    }

    if (!this.googleClient) {
      const envKey = process.env.GEMINI_API_KEY;
      if (!envKey) {
        throw new Error('GEMINI_API_KEY not found. Configure it in settings or server environment.');
      }
      this.googleClient = new GoogleGenAI({ apiKey: envKey });
    }
    return this.googleClient;
  }

  /**
   * Get or create OpenAI client
   */
  private getOpenaiClient(apiKey?: string): OpenAI {
    if (apiKey) {
      return new OpenAI({ apiKey });
    }

    if (!this.openaiClient) {
      const envKey = process.env.OPENAI_API_KEY;
      if (!envKey) {
        throw new Error('OPENAI_API_KEY not found. Configure it in settings or server environment.');
      }
      this.openaiClient = new OpenAI({ apiKey: envKey });
    }
    return this.openaiClient;
  }

  /**
   * Get or create Anthropic client
   */
  private getAnthropicClient(apiKey?: string): Anthropic {
    if (apiKey) {
      return new Anthropic({ apiKey });
    }

    if (!this.anthropicClient) {
      const envKey = process.env.ANTHROPIC_API_KEY;
      if (!envKey) {
        throw new Error('ANTHROPIC_API_KEY not found. Configure it in settings or server environment.');
      }
      this.anthropicClient = new Anthropic({ apiKey: envKey });
    }
    return this.anthropicClient;
  }

  /**
   * Get available providers based on configured API keys
   */
  getAvailableProviders(): Partial<Record<LLMProvider, string[]>> {
    const available: Partial<Record<LLMProvider, string[]>> = {};

    if (process.env.GEMINI_API_KEY) {
      available.google = AVAILABLE_MODELS.google;
    }
    if (process.env.OPENAI_API_KEY) {
      available.openai = AVAILABLE_MODELS.openai;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      available.anthropic = AVAILABLE_MODELS.anthropic;
    }

    return available;
  }

  /**
   * Normalize config with defaults
   */
  normalizeConfig(config: LLMConfig): Required<Omit<LLMConfig, 'apiKey'>> & { apiKey?: string } {
    return {
      provider: config.provider,
      model: config.model,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      apiKey: config.apiKey,
    };
  }

  /**
   * Repair common JSON formatting issues
   */
  repairJson(s: string): string {
    let result = s;
    // Replace : 'value' with : "value"
    result = result.replace(/:\s*'([^']*)'/g, ': "$1"');
    // Remove trailing commas before } or ]
    result = result.replace(/,(\s*[}\]])/g, '$1');
    return result;
  }

  /**
   * Parse JSON with automatic repair on failure
   */
  private parseJsonWithRepair(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      try {
        const repaired = this.repairJson(s);
        return JSON.parse(repaired);
      } catch {
        throw new Error('Failed to parse JSON');
      }
    }
  }

  /**
   * Extract JSON from a response that may contain markdown code blocks
   */
  extractJsonFromResponse(response: string): unknown {
    // Try to find JSON in code block first
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      return this.parseJsonWithRepair(codeBlockMatch[1]);
    }

    // Try to find raw JSON object
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return this.parseJsonWithRepair(jsonMatch[0]);
    }

    throw new Error('No JSON found in response');
  }

  /**
   * Generate response from Google Gemini
   */
  private async generateGoogle(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getGoogleClient(config.apiKey);

    // Build content parts
    const contents: Array<string | { inlineData: { mimeType: string; data: string } }> = [prompt];

    if (images) {
      for (const img of images) {
        contents.push({
          inlineData: {
            mimeType: img.mimeType || 'image/png',
            data: img.data,
          },
        });
      }
    }

    const response = await client.models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    });

    return response.text || '';
  }

  /**
   * Generate response from OpenAI
   */
  private async generateOpenai(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getOpenaiClient(config.apiKey);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Build user message content
    if (images && images.length > 0) {
      const content: OpenAI.ChatCompletionContentPart[] = [
        { type: 'text', text: prompt },
      ];
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mimeType || 'image/png'};base64,${img.data}`,
          },
        });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    const response = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_completion_tokens: config.maxTokens,
    });

    return response.choices[0]?.message?.content || '';
  }

  /**
   * Generate response from Anthropic Claude
   */
  private async generateAnthropic(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getAnthropicClient(config.apiKey);

    // Build user message content
    let content: Anthropic.MessageCreateParams['messages'][0]['content'];

    if (images && images.length > 0) {
      const parts: Anthropic.ContentBlockParam[] = [];
      for (const img of images) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (img.mimeType || 'image/png') as 'image/png' | 'image/gif' | 'image/webp' | 'image/jpeg',
            data: img.data,
          },
        });
      }
      parts.push({ type: 'text', text: prompt });
      content = parts;
    } else {
      content = prompt;
    }

    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
      temperature: config.temperature,
    });

    const textBlock = response.content.find(c => c.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '';
  }

  /**
   * Generate a response from the LLM
   */
  async generate(options: GenerateOptions): Promise<string> {
    const { prompt, systemPrompt, config, images } = options;
    const normalizedConfig = this.normalizeConfig(config);

    switch (config.provider) {
      case 'google':
        return this.generateGoogle(prompt, systemPrompt, normalizedConfig, images);
      case 'openai':
        return this.generateOpenai(prompt, systemPrompt, normalizedConfig, images);
      case 'anthropic':
        return this.generateAnthropic(prompt, systemPrompt, normalizedConfig, images);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  /**
   * Generate structured JSON response
   */
  async generateStructured(options: GenerateStructuredOptions): Promise<unknown> {
    const { prompt, systemPrompt, config } = options;
    const normalizedConfig = this.normalizeConfig(config);

    switch (config.provider) {
      case 'google':
        return this.generateStructuredGoogle(prompt, systemPrompt, normalizedConfig);
      case 'openai':
        return this.generateStructuredOpenai(prompt, systemPrompt, normalizedConfig);
      case 'anthropic':
        return this.generateStructuredAnthropic(prompt, systemPrompt, normalizedConfig);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  private async generateStructuredGoogle(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>
  ): Promise<unknown> {
    const client = this.getGoogleClient(config.apiKey);

    const response = await client.models.generateContent({
      model: config.model,
      contents: [prompt],
      config: {
        systemInstruction: systemPrompt,
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
        responseMimeType: 'application/json',
      },
    });

    return this.extractJsonFromResponse(response.text || '');
  }

  private async generateStructuredOpenai(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>
  ): Promise<unknown> {
    const client = this.getOpenaiClient(config.apiKey);

    const response = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: config.temperature,
      max_completion_tokens: config.maxTokens,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  }

  private async generateStructuredAnthropic(
    prompt: string,
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>
  ): Promise<unknown> {
    const client = this.getAnthropicClient(config.apiKey);

    // Anthropic doesn't have native JSON mode, so we enforce via prompt
    const enhancedSystem = systemPrompt +
      '\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no explanation outside the JSON.';

    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: enhancedSystem,
      messages: [{ role: 'user', content: prompt }],
      temperature: config.temperature,
    });

    const textBlock = response.content.find(c => c.type === 'text');
    const text = textBlock && 'text' in textBlock ? textBlock.text : '';
    return this.extractJsonFromResponse(text);
  }

  /**
   * Chat with conversation history
   */
  async chat(options: ChatOptions): Promise<string> {
    const { message, history, systemPrompt, config, images } = options;
    const normalizedConfig = this.normalizeConfig(config);

    switch (config.provider) {
      case 'google':
        return this.chatGoogle(message, history, systemPrompt, normalizedConfig, images);
      case 'openai':
        return this.chatOpenai(message, history, systemPrompt, normalizedConfig, images);
      case 'anthropic':
        return this.chatAnthropic(message, history, systemPrompt, normalizedConfig, images);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  private async chatGoogle(
    message: string,
    history: ChatMessage[],
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getGoogleClient(config.apiKey);

    // Convert history to Gemini format
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }

    // Add current message with images
    const currentParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: message },
    ];

    if (images) {
      for (const img of images) {
        currentParts.push({
          inlineData: {
            mimeType: img.mimeType || 'image/png',
            data: img.data,
          },
        });
      }
    }

    contents.push({
      role: 'user',
      parts: currentParts as Array<{ text: string }>,
    });

    const response = await client.models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    });

    return response.text || '';
  }

  private async chatOpenai(
    message: string,
    history: ChatMessage[],
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getOpenaiClient(config.apiKey);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add history
    for (const msg of history) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add current message with images
    if (images && images.length > 0) {
      const content: OpenAI.ChatCompletionContentPart[] = [
        { type: 'text', text: message },
      ];
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mimeType || 'image/png'};base64,${img.data}`,
          },
        });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: message });
    }

    const response = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_completion_tokens: config.maxTokens,
    });

    return response.choices[0]?.message?.content || '';
  }

  private async chatAnthropic(
    message: string,
    history: ChatMessage[],
    systemPrompt: string,
    config: ReturnType<typeof this.normalizeConfig>,
    images?: ImageInput[]
  ): Promise<string> {
    const client = this.getAnthropicClient(config.apiKey);

    const messages: Anthropic.MessageCreateParams['messages'] = [];

    // Add history
    for (const msg of history) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add current message with images
    if (images && images.length > 0) {
      const parts: Anthropic.ContentBlockParam[] = [];
      for (const img of images) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (img.mimeType || 'image/png') as 'image/png' | 'image/gif' | 'image/webp' | 'image/jpeg',
            data: img.data,
          },
        });
      }
      parts.push({ type: 'text', text: message });
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: message });
    }

    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages,
      temperature: config.temperature,
    });

    const textBlock = response.content.find(c => c.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '';
  }
}

// Global instance
export const llmService = new LLMService();
