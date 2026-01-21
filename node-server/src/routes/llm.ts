/**
 * LLM API Routes
 */

import { Router, Request, Response } from 'express';
import { LLMService } from '../llm/llm-service';
import { LLMProvider, ChatMessage, ImageInput } from '../llm/types';

const router = Router();
const llmService = new LLMService();

/**
 * List available LLM providers and models
 */
router.get('/llm/providers', (_req: Request, res: Response) => {
  const providers = llmService.getAvailableProviders();
  res.json({ providers });
});

/**
 * Generate text/code from LLM
 */
router.post('/llm/generate', async (req: Request, res: Response) => {
  try {
    const {
      prompt,
      system_prompt,
      provider = 'google',
      model = 'gemini-2.5-flash',
      temperature = 0.2,
      images,
    } = req.body;

    // Check for API key from header
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const apiProvider = req.headers['x-api-provider'] as string | undefined;

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

    res.json({ response });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Generate structured JSON response from LLM
 */
router.post('/llm/generate-structured', async (req: Request, res: Response) => {
  try {
    const {
      prompt,
      system_prompt,
      provider = 'google',
      model = 'gemini-2.5-flash',
      temperature = 0.2,
    } = req.body;

    // Check for API key from header
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const apiProvider = req.headers['x-api-provider'] as string | undefined;

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

    res.json({ response });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Chat with LLM including history
 */
router.post('/llm/chat', async (req: Request, res: Response) => {
  try {
    const {
      message,
      history = [],
      system_prompt,
      provider = 'google',
      model = 'gemini-2.5-flash',
      temperature = 0.2,
      images,
    } = req.body;

    // Check for API key from header
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const apiProvider = req.headers['x-api-provider'] as string | undefined;

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

    res.json({ response });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

export { llmService };
export default router;
