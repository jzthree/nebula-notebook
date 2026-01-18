/**
 * LLM Service Types
 */

export type LLMProvider = 'google' | 'openai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string; // Optional override from environment
}

export interface ImageInput {
  mimeType: string;
  data: string; // base64 encoded
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  prompt: string;
  systemPrompt: string;
  config: LLMConfig;
  images?: ImageInput[];
}

export interface ChatOptions {
  message: string;
  history: ChatMessage[];
  systemPrompt: string;
  config: LLMConfig;
  images?: ImageInput[];
}

export interface GenerateStructuredOptions {
  prompt: string;
  systemPrompt: string;
  config: LLMConfig;
}

// Available models per provider (Dec 2025)
export const AVAILABLE_MODELS: Record<LLMProvider, string[]> = {
  google: ['gemini-3.0-flash', 'gemini-3.0-pro', 'gemini-2.5-flash'],
  openai: ['gpt-5.2', 'gpt-5-mini', 'gpt-4o'],
  anthropic: ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251101'],
};

// Default configuration
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.2;
