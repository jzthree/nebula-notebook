import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CellOutput } from '../CellOutput';
import { CellOutput as Output } from '../../types';
import { loadExternalLibrary } from '../../utils/externalLibraryLoader';

vi.mock('../../utils/externalLibraryLoader', () => ({
  loadExternalLibrary: vi.fn(),
}));

const htmlOutput: Output = {
  id: 'output-1',
  type: 'html',
  content: '<audio controls autoplay src="test.mp3"></audio>',
  timestamp: 1,
};

describe('CellOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves existing html media DOM when the parent rerenders for unrelated state', () => {
    const outputs = [htmlOutput];

    const Harness = ({ editorText }: { editorText: string }) => (
      <div data-editor-text={editorText}>
        <CellOutput outputs={outputs} executionMs={125} />
      </div>
    );

    const { container, rerender } = render(<Harness editorText="print(1)" />);

    const htmlContainer = container.querySelector('.overflow-x-auto') as HTMLDivElement | null;
    const audioBefore = container.querySelector('audio');
    expect(htmlContainer).toBeTruthy();
    expect(audioBefore).toBeTruthy();

    let innerHtmlWrites = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    expect(descriptor?.get).toBeTruthy();
    expect(descriptor?.set).toBeTruthy();

    Object.defineProperty(htmlContainer!, 'innerHTML', {
      configurable: true,
      get() {
        return descriptor!.get!.call(this);
      },
      set(value: string) {
        innerHtmlWrites += 1;
        descriptor!.set!.call(this, value);
      },
    });

    rerender(<Harness editorText="print(12)" />);

    const htmlContainerAfter = container.querySelector('.overflow-x-auto');
    const audioAfter = container.querySelector('audio');
    expect(htmlContainerAfter).toBe(htmlContainer);
    expect(audioAfter).toBe(audioBefore);
    expect(innerHtmlWrites).toBe(0);
  });

  it('still updates the media subtree when outputs actually change', () => {
    const initialOutputs: Output[] = [htmlOutput];
    const updatedOutputs: Output[] = [
      {
        ...htmlOutput,
        content: '<audio controls autoplay src="updated.mp3"></audio>',
        timestamp: 2,
      },
    ];

    const { container, rerender } = render(
      <CellOutput outputs={initialOutputs} executionMs={125} />
    );

    expect(container.querySelector('audio')?.getAttribute('src')).toBe('test.mp3');

    rerender(<CellOutput outputs={updatedOutputs} executionMs={125} />);

    expect(container.querySelector('audio')?.getAttribute('src')).toBe('updated.mp3');
  });

  it('renders Plotly MIME bundle outputs through the shared library loader', async () => {
    const reactMock = vi.fn();
    vi.mocked(loadExternalLibrary).mockResolvedValue({
      react: reactMock,
      purge: vi.fn(),
    });

    const plotlyOutput: Output = {
      id: 'plotly-output',
      type: 'display_data',
      content: 'Figure({ ... })',
      timestamp: 3,
      preferredMimeType: 'application/vnd.plotly.v1+json',
      mimeBundle: {
        'application/vnd.plotly.v1+json': {
          data: [{ x: [1, 2], y: [3, 4], type: 'scatter' }],
          layout: { title: 'Demo' },
        },
        'text/plain': 'Figure({ ... })',
      },
    };

    render(<CellOutput outputs={[plotlyOutput]} executionMs={125} />);

    await waitFor(() => {
      expect(loadExternalLibrary).toHaveBeenCalledWith('plotly');
      expect(reactMock).toHaveBeenCalled();
    });
  });

  it('executes nebula web outputs with loaded libraries', async () => {
    vi.mocked(loadExternalLibrary).mockResolvedValue({
      value: 42,
    });

    const webOutput: Output = {
      id: 'web-output',
      type: 'display_data',
      content: '{"html":"<div data-nebula-root></div>"}',
      timestamp: 4,
      preferredMimeType: 'application/vnd.nebula.web+json',
      mimeBundle: {
        'application/vnd.nebula.web+json': {
          html: '<div data-nebula-root></div>',
          libraries: ['plotly'],
          js: 'container.textContent = String(libraries.plotly.value);',
        },
      },
    };

    const { container } = render(<CellOutput outputs={[webOutput]} executionMs={125} />);

    await waitFor(() => {
      const host = container.querySelector('.shadow-sm');
      expect(host?.shadowRoot?.textContent).toContain('42');
    });
  });
});
