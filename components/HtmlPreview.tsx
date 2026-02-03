import React, { useMemo, useEffect, useState } from 'react';
import { decodeHtmlParam, wrapHtmlDocument } from '../utils/htmlPreview';
import { readFile } from '../services/fileService';

interface HtmlPreviewProps {
  encodedHtml?: string;
  filePath?: string;
}

export const HtmlPreview: React.FC<HtmlPreviewProps> = ({ encodedHtml, filePath }) => {
  const [htmlFromFile, setHtmlFromFile] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const { html: htmlFromParam, error: paramError } = useMemo(() => {
    if (!encodedHtml) {
      return { html: '', error: null as string | null };
    }
    try {
      const decoded = decodeHtmlParam(encodedHtml);
      return { html: decoded, error: null as string | null };
    } catch (err) {
      return { html: '', error: err instanceof Error ? err.message : 'Failed to decode HTML' };
    }
  }, [encodedHtml]);

  useEffect(() => {
    if (!filePath) return;
    let mounted = true;
    setIsLoading(true);
    setFileError(null);
    readFile(filePath)
      .then((result) => {
        if (!mounted) return;
        if (result.type !== 'text' || typeof result.content !== 'string') {
          setFileError('HTML file could not be read as text.');
          return;
        }
        setHtmlFromFile(result.content);
      })
      .catch((err: Error) => {
        if (!mounted) return;
        setFileError(err.message || 'Failed to load HTML file');
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [filePath]);

  useEffect(() => {
    document.title = 'HTML Output - Nebula Notebook';
  }, []);

  const html = filePath ? htmlFromFile : htmlFromParam;
  const error = filePath ? fileError : paramError;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="text-sm text-slate-500">Loading HTML…</div>
      </div>
    );
  }

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
