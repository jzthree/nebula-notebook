import React, { useMemo, useEffect } from 'react';
import { decodeHtmlParam, wrapHtmlDocument } from '../utils/htmlPreview';

interface HtmlPreviewProps {
  encodedHtml: string;
}

export const HtmlPreview: React.FC<HtmlPreviewProps> = ({ encodedHtml }) => {
  const { html, error } = useMemo(() => {
    try {
      const decoded = decodeHtmlParam(encodedHtml);
      return { html: decoded, error: null as string | null };
    } catch (err) {
      return { html: '', error: err instanceof Error ? err.message : 'Failed to decode HTML' };
    }
  }, [encodedHtml]);

  useEffect(() => {
    document.title = 'HTML Output - Nebula Notebook';
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-2">Unable to open HTML output</h1>
          <p className="text-sm text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  const srcDoc = wrapHtmlDocument(html);

  return (
    <div className="min-h-screen bg-white">
      <iframe
        title="HTML Output"
        className="w-full h-screen border-0"
        srcDoc={srcDoc}
      />
    </div>
  );
};
