/**
 * LLM API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { LLMService } from '../llm/llm-service';
import { LLMProvider, ChatMessage, ImageInput } from '../llm/types';

const llmService = new LLMService();

export default async function llmRoutes(fastify: FastifyInstance) {
  /**
   * List available LLM providers and models
   */
  fastify.get('/llm/providers', async (_request: FastifyRequest, reply: FastifyReply) => {
    const providers = llmService.getAvailableProviders();
    return reply.send({ providers });
  });

  /**
   * Generate text/code from LLM
   */
  fastify.post('/llm/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const {
        prompt,
        system_prompt,
        provider = 'google',
        model = 'gemini-2.5-flash',
        temperature = 0.2,
        images,
      } = request.body as any;

      // Check for API key from header
      const apiKey = request.headers['x-api-key'] as string | undefined;
      const apiProvider = request.headers['x-api-provider'] as string | undefined;

      const response = await llmService.generate({
        prompt,
        systemPrompt: system_prompt,
        config: {
          provider: provider as LLMProvider,
          model,
          temperature,
          apiKey: apiProvider === provider ? apiKey : undefined,
        },
        images: images as ImageInput[] | undefined,
      });

      return reply.send({ response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Generate structured JSON response from LLM
   */
  fastify.post('/llm/generate-structured', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const {
        prompt,
        system_prompt,
        provider = 'google',
        model = 'gemini-2.5-flash',
        temperature = 0.2,
      } = request.body as any;

      // Check for API key from header
      const apiKey = request.headers['x-api-key'] as string | undefined;
      const apiProvider = request.headers['x-api-provider'] as string | undefined;

      const response = await llmService.generateStructured({
        prompt,
        systemPrompt: system_prompt,
        config: {
          provider: provider as LLMProvider,
          model,
          temperature,
          apiKey: apiProvider === provider ? apiKey : undefined,
        },
      });

      return reply.send({ response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Chat with LLM including history
   */
  fastify.post('/llm/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const {
        message,
        history = [],
        system_prompt,
        provider = 'google',
        model = 'gemini-2.5-flash',
        temperature = 0.2,
        images,
      } = request.body as any;

      // Check for API key from header
      const apiKey = request.headers['x-api-key'] as string | undefined;
      const apiProvider = request.headers['x-api-provider'] as string | undefined;

      // Convert history format
      const chatHistory: ChatMessage[] = history.map((h: { role: string; content: string }) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      }));

      const response = await llmService.chat({
        message,
        history: chatHistory,
        systemPrompt: system_prompt,
        config: {
          provider: provider as LLMProvider,
          model,
          temperature,
          apiKey: apiProvider === provider ? apiKey : undefined,
        },
        images: images as ImageInput[] | undefined,
      });

      return reply.send({ response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });
}

export { llmService };
