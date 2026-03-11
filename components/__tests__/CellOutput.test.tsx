import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CellOutput } from '../CellOutput';
import { CellOutput as Output } from '../../types';

const htmlOutput: Output = {
  id: 'output-1',
  type: 'html',
  content: '<audio controls autoplay src="test.mp3"></audio>',
  timestamp: 1,
};

describe('CellOutput', () => {
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
});
