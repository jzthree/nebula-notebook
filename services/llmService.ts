/**
 * LLM Service - Multi-provider LLM client
 * Supports Google Gemini, OpenAI, and Anthropic
 */
import { Cell } from '../types';

const API_BASE = '/api';

export type LLMProvider = 'google' | 'openai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProvidersResponse {
  providers: Record<LLMProvider, string[]>;
}

// Default models per provider
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5-20250929'
};

/**
 * Get available providers and models from backend
 */
export const getAvailableProviders = async (): Promise<ProvidersResponse> => {
  const response = await fetch(`${API_BASE}/llm/providers`);
  if (!response.ok) {
    throw new Error('Failed to fetch providers');
  }
  return response.json();
};

/**
 * Get notebook context for LLM
 */
const getNotebookContext = (cells: Cell[]) => {
  return cells
    .map((c, i) => `Cell ${i + 1} [Type: ${c.type}]:\n${c.content}`)
    .join('\n\n');
};

/**
 * Clean response - remove markdown code blocks if present
 */
const cleanResponse = (text: string) => {
  if (!text) return '';
  if (text.startsWith('```python')) {
    return text.replace(/^```python\n/, '').replace(/\n```$/, '');
  } else if (text.startsWith('```')) {
    return text.replace(/^```\n/, '').replace(/\n```$/, '');
  }
  return text.trim();
};

/**
 * Generate cell content using LLM
 */
export const generateCellContent = async (
  prompt: string,
  contextCells: Cell[],
  targetCellId: string,
  config: LLMConfig = { provider: 'google', model: 'gemini-2.5-flash' }
): Promise<string> => {
  const codeContext = contextCells
    .filter(c => c.type === 'code' && c.id !== targetCellId)
    .map((c, i) => `Cell ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const systemPrompt = `
    You are an expert Python data science assistant embedded in a Jupyter Notebook.
    Rules:
    1. If asked for code, return ONLY the Python code. No backticks.
    2. If asked for explanation, return Markdown.
    3. Use context.
    4. Be concise.
  `;

  const userContent = `
    Context (Previous Cells):
    ${codeContext}

    Current Request:
    ${prompt}
  `;

  const response = await fetch(`${API_BASE}/llm/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: userContent,
      system_prompt: systemPrompt,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature || 0.2
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to generate content');
  }

  const data = await response.json();
  return cleanResponse(data.response);
};

/**
 * Fix cell error using LLM
 */
export const fixCellError = async (
  code: string,
  error: string,
  contextCells: Cell[],
  config: LLMConfig = { provider: 'google', model: 'gemini-2.5-flash' }
): Promise<string> => {
  const context = getNotebookContext(contextCells);

  const systemPrompt = `
    You are a debugging assistant. Fix the Python code based on the error message.
    Return ONLY the corrected code block. No explanations.
  `;

  const userContent = `
    Notebook Context:
    ${context}

    Broken Code:
    ${code}

    Error:
    ${error}

    Please provide the fixed code.
  `;

  const response = await fetch(`${API_BASE}/llm/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: userContent,
      system_prompt: systemPrompt,
      provider: config.provider,
      model: config.model,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to fix error');
  }

  const data = await response.json();
  return cleanResponse(data.response);
};

/**
 * Chat with notebook context
 */
export const chatWithNotebook = async (
  message: string,
  history: ChatMessage[],
  cells: Cell[],
  config: LLMConfig = { provider: 'google', model: 'gemini-2.5-flash' }
): Promise<string> => {
  const context = getNotebookContext(cells);

  const systemPrompt = `
    You are Nebula AI, a helpful data science assistant.
    You have access to the user's current notebook code.

    Rules for Actionable Responses:
    1. Cells are numbered #1, #2, etc.

    2. INSERTING CODE:
       Start the code block with "# Insert after Cell [N]" to suggest location.
       Example:
       \`\`\`python
       # Insert after Cell 2
       import pandas as pd
       \`\`\`

    3. EDITING CODE (Full Replacement):
       To completely replace a specific cell's content, start the code block with "# Edit Cell [N]".
       Example:
       \`\`\`python
       # Edit Cell 3
       df['new_col'] = df['old_col'] * 2
       \`\`\`

    4. PATCHING CODE (Partial Edit):
       For small changes in large cells, use "# Patch Cell [N]" with a search/replace block.
       Format:
       \`\`\`python
       # Patch Cell 1
       <<<<
       [exact code to find]
       ====
       [replacement code]
       >>>>
       \`\`\`

    5. DELETING CELLS:
       To suggest deleting a cell, include the text "[DELETE CELL N]" on a separate line in your response.

    Capabilities:
    - Explain code.
    - Debug errors.
    - Suggest edits, deletions, or new code.
    - Analyze plots and images from the notebook.
  `;

  // Gather images from notebook outputs
  const images = cells.flatMap((cell, idx) =>
    cell.outputs
      .filter(o => o.type === 'image')
      .map(o => ({
        mime_type: 'image/png',
        data: o.content
      }))
  );

  // Convert history to backend format
  const historyFormatted = history.map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.content
  }));

  const response = await fetch(`${API_BASE}/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Notebook Context:\n${context}\n\nUser Question: ${message}`,
      history: historyFormatted,
      system_prompt: systemPrompt,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature || 0.2,
      images: images.length > 0 ? images : undefined
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to chat');
  }

  const data = await response.json();
  return data.response;
};

// Settings storage
const SETTINGS_KEY = 'nebula-settings';

export interface NebulaSettings {
  rootDirectory: string;
  llmProvider: LLMProvider;
  llmModel: string;
  lastKernel: string;
}

export const getSettings = (): NebulaSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Default settings
  return {
    rootDirectory: '~',
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-5-20250929',
    lastKernel: 'python3'
  };
};

export const saveSettings = (settings: Partial<NebulaSettings>): void => {
  const current = getSettings();
  const updated = { ...current, ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
};
