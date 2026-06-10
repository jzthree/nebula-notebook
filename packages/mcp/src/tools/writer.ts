/**
 * Nebula Writer MCP tools
 *
 * These tools talk to the local Writer sidecar. They intentionally do not use
 * NebulaClient because Writer is a local DOCX revision workspace, not a
 * notebook server.
 */

import type { Tool } from './types.js';

type AiProviderName = 'codex' | 'claude';
type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

interface WriterToolParams {
  writer_url?: string;
}

interface WriterSession {
  documentText: string;
  features: Record<string, unknown>;
  id: string;
  importMessages: string[];
  name: string;
  pendingSuggestions: number;
  suggestions: WriterSuggestion[];
  title: string;
  updatedAt: string;
}

interface WriterSuggestion {
  confidence: number;
  id: string;
  original: string;
  rationale: string;
  replacement: string;
  status: SuggestionStatus;
  title: string;
}

interface WriterSessionEnvelope {
  session: WriterSession | null;
}

interface WriterSuggestEnvelope {
  ai: {
    message: string;
    provider: AiProviderName;
    suggestions: WriterSuggestion[];
  };
  session: WriterSession;
}

interface WriterExportEnvelope {
  outputPath: string;
  report: {
    commentedSuggestionTitles: string[];
    commentedSuggestions: number;
    matchedSuggestions: number;
    totalSuggestions: number;
    unmatchedSuggestionTitles: string[];
    unmatchedSuggestions: number;
  } | null;
  session: WriterSession;
}

const DEFAULT_WRITER_URL = 'http://127.0.0.1:8787';

export const writerStatusTool: Tool<WriterToolParams, { health: unknown; session: WriterSession | null }> = {
  definition: {
    name: 'writer_status',
    description: 'Check the Nebula Writer sidecar and summarize the active shared Writer session.',
    inputSchema: {
      type: 'object',
      properties: {
        writer_url: { type: 'string', description: 'Writer sidecar URL. Defaults to NEBULA_WRITER_URL, WRITER_SIDECAR_URL, or http://127.0.0.1:8787.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    const baseUrl = writerUrl(params);
    const [health, session] = await Promise.all([
      requestWriterJson<unknown>(baseUrl, '/api/health'),
      requestWriterJson<WriterSessionEnvelope>(baseUrl, '/api/session'),
    ]);
    return { success: true, data: { health, session: session.session } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { session } = result.data!;
    const sessionText = session
      ? `Active document: ${session.name}\nCharacters: ${session.documentText.length}\nPending suggestions: ${session.pendingSuggestions}\nUpdated: ${session.updatedAt}`
      : 'No active Writer document.';
    return [{ type: 'text', text: `${sessionText}\n\nHealth:\n${JSON.stringify(result.data!.health, null, 2)}` }];
  },
};

export const writerOpenDocxTool: Tool<WriterToolParams & { path: string }, WriterSession> = {
  definition: {
    name: 'writer_open_docx',
    description: 'Open a local DOCX in the shared Nebula Writer sidecar session so both the user UI and agent tools can inspect/review it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or working-directory-relative path to the .docx file.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session/open-docx', {
      method: 'POST',
      body: { path: params.path },
    });
    if (!result.session) {
      return { success: false, error: 'Writer sidecar did not return a session.' };
    }
    return { success: true, data: result.session };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const session = result.data!;
    return [{
      type: 'text',
      text: [
        `Opened: ${session.name}`,
        `Characters: ${session.documentText.length}`,
        `Pending suggestions: ${session.pendingSuggestions}`,
        `Features: ${formatFeatures(session.features)}`,
      ].join('\n'),
    }];
  },
};

export const writerGetDocumentTool: Tool<WriterToolParams & { max_chars?: number }, { maxChars: number; session: WriterSession }> = {
  definition: {
    name: 'writer_get_document',
    description: 'Read the active Nebula Writer document text, imported DOCX feature summary, and suggestion counts.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'number', description: 'Maximum document text characters to include in the MCP response. Defaults to 6000.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session');
    if (!result.session) {
      return { success: false, error: 'No active Writer document. Call writer_open_docx first or import a DOCX in the web UI.' };
    }
    return {
      success: true,
      data: {
        maxChars: typeof params.max_chars === 'number' && Number.isFinite(params.max_chars)
          ? Math.max(500, Math.min(100000, Math.round(params.max_chars)))
          : 6000,
        session: result.session,
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { maxChars, session } = result.data!;
    return [{
      type: 'text',
      text: [
        `Document: ${session.name}`,
        `Characters: ${session.documentText.length}`,
        `Pending suggestions: ${session.pendingSuggestions}`,
        `Features: ${formatFeatures(session.features)}`,
        '',
        truncate(session.documentText, maxChars),
      ].join('\n'),
    }];
  },
};

export const writerProposeChangesTool: Tool<WriterToolParams & {
  instruction: string;
  mode?: 'global' | 'selection';
  provider?: AiProviderName;
  selection_text?: string;
}, WriterSuggestEnvelope> = {
  definition: {
    name: 'writer_propose_changes',
    description: 'Ask Codex CLI or Claude Code to propose anchored revisions against the active Writer document and add them to the shared review queue.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Revision instruction for the local AI provider.' },
        mode: { type: 'string', enum: ['global', 'selection'], default: 'global', description: 'Use global for whole-document review or selection for a specific text span.' },
        provider: { type: 'string', enum: ['codex', 'claude'], default: 'codex', description: 'Local AI provider to run through the Writer sidecar.' },
        selection_text: { type: 'string', description: 'Exact selected text to revise when mode is selection.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['instruction'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSuggestEnvelope>(writerUrl(params), '/api/session/suggest', {
      method: 'POST',
      body: {
        provider: params.provider ?? 'codex',
        instruction: params.instruction,
        mode: params.mode ?? 'global',
        selectionText: params.selection_text,
      },
    });
    return { success: true, data: result };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { ai, session } = result.data!;
    return [{
      type: 'text',
      text: [
        ai.message,
        '',
        `Added ${ai.suggestions.length} suggestion${ai.suggestions.length === 1 ? '' : 's'} to ${session.name}.`,
        formatSuggestions(ai.suggestions),
      ].filter(Boolean).join('\n'),
    }];
  },
};

export const writerListSuggestionsTool: Tool<WriterToolParams, { sessionId: string | null; suggestions: WriterSuggestion[] }> = {
  definition: {
    name: 'writer_list_suggestions',
    description: 'List AI suggestions currently held in the shared Nebula Writer review queue.',
    inputSchema: {
      type: 'object',
      properties: {
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params) {
    return { success: true, data: await requestWriterJson<{ sessionId: string | null; suggestions: WriterSuggestion[] }>(writerUrl(params), '/api/session/suggestions') };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const suggestions = result.data!.suggestions;
    return [{
      type: 'text',
      text: suggestions.length ? formatSuggestions(suggestions) : 'No Writer suggestions in the active review queue.',
    }];
  },
};

export const writerSetSuggestionStatusTool: Tool<WriterToolParams & { id: string; status: SuggestionStatus }, WriterSession> = {
  definition: {
    name: 'writer_set_suggestion_status',
    description: 'Mark a Writer suggestion as pending, accepted, or rejected in the shared review queue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Suggestion id from writer_list_suggestions.' },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected'], description: 'New suggestion status.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
      required: ['id', 'status'],
    },
  },

  async execute(params) {
    const result = await requestWriterJson<WriterSessionEnvelope>(writerUrl(params), '/api/session/suggestion-status', {
      method: 'POST',
      body: { id: params.id, status: params.status },
    });
    if (!result.session) {
      return { success: false, error: 'Writer sidecar did not return a session.' };
    }
    return { success: true, data: result.session };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: `Suggestion status updated. Pending suggestions: ${result.data!.pendingSuggestions}` }];
  },
};

export const writerExportReviewDocxTool: Tool<WriterToolParams & { output_path?: string; pending_only?: boolean }, WriterExportEnvelope> = {
  definition: {
    name: 'writer_export_review_docx',
    description: 'Export the active Writer document as a DOCX review copy with matched suggestions as tracked changes and unsafe/unmatched suggestions as Word comments.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Where to write the review DOCX. Defaults to apps/writer/tmp/<title>-review.docx in the sidecar process.' },
        pending_only: { type: 'boolean', default: true, description: 'Only export pending suggestions. Defaults to true.' },
        writer_url: { type: 'string', description: 'Writer sidecar URL. Optional.' },
      },
    },
  },

  async execute(params) {
    return {
      success: true,
      data: await requestWriterJson<WriterExportEnvelope>(writerUrl(params), '/api/session/export-review', {
        method: 'POST',
        body: {
          outputPath: params.output_path,
          pendingOnly: params.pending_only ?? true,
        },
      }),
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { outputPath, report } = result.data!;
    const reportText = report
      ? `Matched ${report.matchedSuggestions}/${report.totalSuggestions}; comments ${report.commentedSuggestions}; unresolved ${report.unmatchedSuggestions}.`
      : 'Exported DOCX.';
    return [{ type: 'text', text: `Review DOCX written: ${outputPath}\n${reportText}` }];
  },
};

export const writerTools: Tool<any, any>[] = [
  writerStatusTool,
  writerOpenDocxTool,
  writerGetDocumentTool,
  writerProposeChangesTool,
  writerListSuggestionsTool,
  writerSetSuggestionStatusTool,
  writerExportReviewDocxTool,
];

function writerUrl(params: WriterToolParams): string {
  return (params.writer_url || process.env.NEBULA_WRITER_URL || process.env.WRITER_SIDECAR_URL || DEFAULT_WRITER_URL).replace(/\/+$/, '');
}

async function requestWriterJson<T>(
  baseUrl: string,
  path: string,
  options: { body?: unknown; method?: string } = {}
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function formatFeatures(features: Record<string, unknown>): string {
  const visible = Object.entries(features)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([key, value]) => `${key}=${value}`);
  return visible.length ? visible.join(', ') : 'basic text';
}

function formatSuggestions(suggestions: WriterSuggestion[]): string {
  return suggestions.map((suggestion, index) => [
    `${index + 1}. ${suggestion.title} (${suggestion.status}, ${Math.round(suggestion.confidence * 100)}%, id=${suggestion.id})`,
    `Original: ${truncate(suggestion.original, 280)}`,
    `Replacement: ${truncate(suggestion.replacement, 280)}`,
    `Rationale: ${truncate(suggestion.rationale, 220)}`,
  ].join('\n')).join('\n\n');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n... [truncated]`;
}
