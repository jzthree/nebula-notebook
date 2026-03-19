import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageModalViewer } from '../ImageModalViewer';

describe('ImageModalViewer', () => {
  it('keeps pinch-style zoom inside the modal viewer', () => {
    render(
      <ImageModalViewer
        src="https://example.com/test.png"
        alt="Preview"
        onClose={() => {}}
      />
    );

    const viewer = screen.getByLabelText('Image viewer');
    const image = screen.getByAltText('Preview');

    Object.defineProperty(viewer, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(viewer, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(image, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(image, 'clientHeight', { configurable: true, value: 400 });
    vi.spyOn(viewer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });

    act(() => {
      fireEvent.wheel(viewer, {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -200,
      });
    });

    expect((viewer as HTMLDivElement).style.touchAction).toBe('none');
    expect((image as HTMLImageElement).style.transform).not.toContain('scale(1)');
  });

  it('closes on escape', () => {
    const onClose = vi.fn();

    render(
      <ImageModalViewer
        src="https://example.com/test.png"
        alt="Preview"
        onClose={onClose}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
