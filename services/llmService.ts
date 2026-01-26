/**
 * LLM Service - Multi-provider LLM client
 * Supports Google Gemini, OpenAI, and Anthropic
 */
import { Cell } from '../types';
import {
  NebulaError,
  withRetry,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from '../types/errors';

const API_BASE = '/api';

/**
 * Parse error response from API and throw appropriate error
 */
const handleApiError = async (response: Response): Promise<never> => {
  const error = await NebulaError.fromResponse(response);
  throw error;
};

/**
 * Fetch with retry for transient errors (rate limits, timeouts)
 */
const fetchWithRetry = async (
  url: string,
  options: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delay: number) => void
): Promise<Response> => {
  return withRetry(
    async () => {
      const response = await fetch(url, options);
      if (!response.ok) {
        await handleApiError(response);
      }
      return response;
    },
    retryConfig,
    onRetry ? (attempt, delay) => onRetry(attempt, delay) : undefined
  );
};

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

// Structured response for cell generation
export interface CellGenerationResponse {
  code: string | null;        // The Python code to put in the cell
  explanation: string | null; // Explanation/notes about the code
  action: 'replace' | 'append' | 'explain_only'; // What to do with the response
}

// Default models per provider (updated Dec 2025)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  google: 'gemini-3.0-flash',
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5-20250929'
};

// Forward declaration - will be defined after getSettings
let getLLMHeaders: (provider?: LLMProvider) => Record<string, string>;

/**
 * Get available providers and models from backend
 */
export const getAvailableProviders = async (): Promise<ProvidersResponse> => {
  const response = await fetchWithRetry(`${API_BASE}/llm/providers`, {});
  return response.json();
};

/**
 * Truncate long text with head and tail
 */
const truncateWithHeadTail = (text: string, maxLines: number = 50): string => {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;

  const headLines = Math.floor(maxLines / 2);
  const tailLines = maxLines - headLines;
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const omitted = lines.length - maxLines;

  return `${head}\n... [${omitted} lines omitted] ...\n${tail}`;
};

/**
 * Format cell outputs for context
 */
const formatCellOutputs = (outputs: Cell['outputs']): string => {
  if (!outputs || outputs.length === 0) return '';

  const parts: string[] = [];

  for (const output of outputs) {
    switch (output.type) {
      case 'error':
        // Always include full errors - they're critical for debugging
        parts.push(`[ERROR]\n${truncateWithHeadTail(output.content, 300)}`);
        break;
      case 'stderr':
        parts.push(`[STDERR]\n${truncateWithHeadTail(output.content, 200)}`);
        break;
      case 'stdout':
        parts.push(`[OUTPUT]\n${truncateWithHeadTail(output.content, 300)}`);
        break;
      case 'html':
        // Just note that HTML output exists, don't include raw HTML
        parts.push(`[HTML OUTPUT: ${output.content.length} chars]`);
        break;
      case 'image':
        parts.push(`[IMAGE OUTPUT]`);
        break;
    }
  }

  return parts.length > 0 ? '\n' + parts.join('\n') : '';
};

/**
 * Get notebook context for LLM
 */
const getNotebookContext = (cells: Cell[]) => {
  return cells
    .map((c, i) => {
      const outputs = formatCellOutputs(c.outputs);
      return `Cell ${i + 1} [Type: ${c.type}]:\n${c.content}${outputs}`;
    })
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
  config: LLMConfig = { provider: 'google', model: 'gemini-3.0-flash' }
): Promise<string> => {
  // Find current cell to include its content
  const currentCell = contextCells.find(c => c.id === targetCellId);
  const currentCellContent = currentCell?.content?.trim() || '';

  // Get other cells as context
  const otherCellsContext = contextCells
    .filter(c => c.type === 'code' && c.id !== targetCellId)
    .map((c, i) => `Cell ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const systemPrompt = `
    You are an expert Python data science assistant embedded in a Jupyter Notebook.
    Rules:
    1. If asked for code, return ONLY the Python code. No backticks.
    2. If asked for explanation, return Markdown.
    3. Use context from other cells and current cell content.
    4. Be concise.
  `;

  const userContent = `
    Context (Other Cells):
    ${otherCellsContext || '(no other cells)'}

    Current Cell Content:
    ${currentCellContent || '(empty)'}

    Request:
    ${prompt}
  `;

  const response = await fetchWithRetry(
    `${API_BASE}/llm/generate`,
    {
      method: 'POST',
      headers: getLLMHeaders(config.provider),
      body: JSON.stringify({
        prompt: userContent,
        system_prompt: systemPrompt,
        provider: config.provider,
        model: config.model,
        temperature: config.temperature || 0.2
      })
    }
  );

  const data = await response.json();
  return cleanResponse(data.response);
};

/**
 * Generate cell content with structured JSON response
 * Returns separate code and explanation fields
 */
export const generateCellContentStructured = async (
  prompt: string,
  contextCells: Cell[],
  targetCellId: string,
  config: LLMConfig = { provider: 'google', model: 'gemini-3.0-flash' }
): Promise<CellGenerationResponse> => {
  // Find current cell to include its content
  const currentCell = contextCells.find(c => c.id === targetCellId);
  const currentCellContent = currentCell?.content?.trim() || '';

  // Get other cells as context
  const otherCellsContext = contextCells
    .filter(c => c.type === 'code' && c.id !== targetCellId)
    .map((c, i) => `Cell ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const systemPrompt = `You are an expert Python data science assistant embedded in a Jupyter Notebook.

You must respond with a JSON object with this exact structure:
{
  "code": "string or null - the Python code to put in the cell (no markdown backticks)",
  "explanation": "string or null - brief explanation of what the code does or why you made certain choices",
  "action": "replace | append | explain_only"
}

Rules:
- "action" must be one of: "replace" (replace cell content), "append" (add to existing), "explain_only" (no code change)
- If the user asks for code, provide it in "code" field WITHOUT backticks or markdown
- If the user asks for explanation only, set "code" to null and "action" to "explain_only"
- Keep explanations concise (1-3 sentences)
- Use context from other cells and current cell content`;

  const userContent = `Context (Other Cells):
${otherCellsContext || '(no other cells)'}

Current Cell Content:
${currentCellContent || '(empty)'}

Request:
${prompt}`;

  const response = await fetchWithRetry(
    `${API_BASE}/llm/generate-structured`,
    {
      method: 'POST',
      headers: getLLMHeaders(config.provider),
      body: JSON.stringify({
        prompt: userContent,
        system_prompt: systemPrompt,
        provider: config.provider,
        model: config.model,
        temperature: config.temperature || 0.2
      })
    }
  );

  const data = await response.json();
  const result = data.response as CellGenerationResponse;

  // Validate and sanitize response
  return {
    code: result.code ? cleanResponse(result.code) : null,
    explanation: result.explanation || null,
    action: result.action || 'replace'
  };
};

/**
 * Fix cell error using LLM
 */
export const fixCellError = async (
  code: string,
  error: string,
  contextCells: Cell[],
  config: LLMConfig = { provider: 'google', model: 'gemini-3.0-flash' }
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

  const response = await fetchWithRetry(
    `${API_BASE}/llm/generate`,
    {
      method: 'POST',
      headers: getLLMHeaders(config.provider),
      body: JSON.stringify({
        prompt: userContent,
        system_prompt: systemPrompt,
        provider: config.provider,
        model: config.model,
        temperature: 0.1
      })
    }
  );

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
  config: LLMConfig = { provider: 'google', model: 'gemini-3.0-flash' }
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

  const response = await fetchWithRetry(
    `${API_BASE}/llm/chat`,
    {
      method: 'POST',
      headers: getLLMHeaders(config.provider),
      body: JSON.stringify({
        message: `Notebook Context:\n${context}\n\nUser Question: ${message}`,
        history: historyFormatted,
        system_prompt: systemPrompt,
        provider: config.provider,
        model: config.model,
        temperature: config.temperature || 0.2,
        images: images.length > 0 ? images : undefined
      })
    }
  );

  const data = await response.json();
  return data.response;
};

// Settings storage
const SETTINGS_KEY = 'nebula-settings';

export type IndentationPreference = 'auto' | '2' | '4' | '8' | 'tab';

export interface NebulaSettings {
  rootDirectory: string;
  llmProvider: LLMProvider;
  llmModel: string;
  lastKernel: string;
  useAIAvatars?: boolean; // Use AI to generate notebook icons (requires API credits)
  notifyOnLongRun?: boolean; // Send browser notification when long-running jobs complete
  notifyThresholdSeconds?: number; // Threshold in seconds for "long-running" (default 60)
  notifySoundEnabled?: boolean; // Play sound when long-running jobs complete
  indentation?: IndentationPreference; // Indentation style: 'auto' (detect), '2', '4', '8', or 'tab'
  showLineNumbers?: boolean; // Show line numbers in code cells
  showCellIds?: boolean; // Show cell IDs in the cell header
  // API Keys (stored in localStorage - use with caution on shared machines)
  apiKeys?: {
    google?: string;    // Gemini API key
    openai?: string;    // OpenAI API key
    anthropic?: string; // Anthropic API key
  };
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
    lastKernel: 'python3',
    notifyOnLongRun: true,
    notifySoundEnabled: true,
    notifyThresholdSeconds: 60,
    indentation: 'auto',
    showCellIds: false
  };
};

export const saveSettings = (settings: Partial<NebulaSettings>): void => {
  const current = getSettings();
  const updated = { ...current, ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
};

/**
 * Get API key for the specified provider from settings
 */
export const getApiKey = (provider: LLMProvider): string | undefined => {
  const settings = getSettings();
  return settings.apiKeys?.[provider];
};

/**
 * Get headers with API key for current provider (if configured in settings)
 */
export const getApiKeyHeaders = (): Record<string, string> => {
  const settings = getSettings();
  const apiKey = settings.apiKeys?.[settings.llmProvider];
  if (apiKey) {
    return { 'X-API-Key': apiKey };
  }
  return {};
};

/**
 * Get headers for LLM requests including Content-Type and API key if configured
 */
getLLMHeaders = (provider?: LLMProvider): Record<string, string> => {
  const settings = getSettings();
  const targetProvider = provider || settings.llmProvider;
  const apiKey = settings.apiKeys?.[targetProvider];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
    headers['X-API-Provider'] = targetProvider;
  }
  return headers;
};
