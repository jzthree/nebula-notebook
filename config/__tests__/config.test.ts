/**
 * Tests for frontend configuration modules.
 *
 * TDD: These tests define expected configuration behavior.
 */
import { describe, it, expect } from 'vitest';
import * as autosaveConfig from '../autosave.config';
import * as displayConfig from '../display.config';
import * as pollingConfig from '../polling.config';

describe('autosave configuration', () => {
  it('MIN_AUTOSAVE_DELAY_MS should be 1000', () => {
    expect(autosaveConfig.MIN_AUTOSAVE_DELAY_MS).toBe(1000);
  });

  it('MAX_AUTOSAVE_DELAY_MS should be 60000', () => {
    expect(autosaveConfig.MAX_AUTOSAVE_DELAY_MS).toBe(60000);
  });

  it('AUTOSAVE_CHECK_DELAY_MS should be 300', () => {
    expect(autosaveConfig.AUTOSAVE_CHECK_DELAY_MS).toBe(300);
  });

  it('AUTOSAVE_RETRY_DELAY_MS should be 5000', () => {
    expect(autosaveConfig.AUTOSAVE_RETRY_DELAY_MS).toBe(5000);
  });

  it('MAX_AUTOSAVE_DELAY_MS should be greater than MIN', () => {
    expect(autosaveConfig.MAX_AUTOSAVE_DELAY_MS).toBeGreaterThan(
      autosaveConfig.MIN_AUTOSAVE_DELAY_MS
    );
  });
});

describe('display configuration', () => {
  describe('output limits', () => {
    it('MAX_OUTPUT_LINES should be 10000', () => {
      expect(displayConfig.MAX_OUTPUT_LINES).toBe(10000);
    });

    it('MAX_OUTPUT_CHARS should be 100MB', () => {
      expect(displayConfig.MAX_OUTPUT_CHARS).toBe(100_000_000);
    });

    it('OUTPUT_TRUNCATION_THRESHOLD should be 2000', () => {
      expect(displayConfig.OUTPUT_TRUNCATION_THRESHOLD).toBe(2000);
    });
  });

  describe('cell dimensions', () => {
    it('DEFAULT_CELL_HEIGHT_PX should be 150', () => {
      expect(displayConfig.DEFAULT_CELL_HEIGHT_PX).toBe(150);
    });

    it('output height constraints should be ordered correctly', () => {
      expect(displayConfig.OUTPUT_MIN_HEIGHT_PX).toBeLessThan(
        displayConfig.OUTPUT_DEFAULT_HEIGHT_PX
      );
      expect(displayConfig.OUTPUT_DEFAULT_HEIGHT_PX).toBeLessThan(
        displayConfig.OUTPUT_MAX_HEIGHT_PX
      );
    });

    it('OUTPUT_MIN_HEIGHT_PX should be 50', () => {
      expect(displayConfig.OUTPUT_MIN_HEIGHT_PX).toBe(50);
    });

    it('OUTPUT_DEFAULT_HEIGHT_PX should be 200', () => {
      expect(displayConfig.OUTPUT_DEFAULT_HEIGHT_PX).toBe(200);
    });

    it('OUTPUT_MAX_HEIGHT_PX should be 600', () => {
      expect(displayConfig.OUTPUT_MAX_HEIGHT_PX).toBe(600);
    });
  });

  describe('animation durations', () => {
    it('SCROLL_ANIMATION_DURATION_MS should be 150', () => {
      expect(displayConfig.SCROLL_ANIMATION_DURATION_MS).toBe(150);
    });

    it('HIGHLIGHT_ANIMATION_DURATION_MS should be 1500', () => {
      expect(displayConfig.HIGHLIGHT_ANIMATION_DURATION_MS).toBe(1500);
    });

    it('TRANSITION_DURATION_MS should be 300', () => {
      expect(displayConfig.TRANSITION_DURATION_MS).toBe(300);
    });

    it('OUTPUT_FLUSH_INTERVAL_MS should be 100', () => {
      expect(displayConfig.OUTPUT_FLUSH_INTERVAL_MS).toBe(100);
    });

    it('EXECUTION_TIMER_INTERVAL_MS should be 100', () => {
      expect(displayConfig.EXECUTION_TIMER_INTERVAL_MS).toBe(100);
    });

    it('all animation durations should be positive', () => {
      expect(displayConfig.SCROLL_ANIMATION_DURATION_MS).toBeGreaterThan(0);
      expect(displayConfig.HIGHLIGHT_ANIMATION_DURATION_MS).toBeGreaterThan(0);
      expect(displayConfig.TRANSITION_DURATION_MS).toBeGreaterThan(0);
      expect(displayConfig.OUTPUT_FLUSH_INTERVAL_MS).toBeGreaterThan(0);
    });
  });
});

describe('polling configuration', () => {
  it('DIRECTORY_POLL_INTERVAL_MS should be 5000', () => {
    expect(pollingConfig.DIRECTORY_POLL_INTERVAL_MS).toBe(5000);
  });

  it('WEBSOCKET_RECONNECT_INTERVAL_MS should be 1000', () => {
    expect(pollingConfig.WEBSOCKET_RECONNECT_INTERVAL_MS).toBe(1000);
  });

  it('MTIME_TOLERANCE_SECONDS should be 0.5', () => {
    expect(pollingConfig.MTIME_TOLERANCE_SECONDS).toBe(0.5);
  });

  it('all polling intervals should be positive', () => {
    expect(pollingConfig.DIRECTORY_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(pollingConfig.WEBSOCKET_RECONNECT_INTERVAL_MS).toBeGreaterThan(0);
    expect(pollingConfig.MTIME_TOLERANCE_SECONDS).toBeGreaterThan(0);
  });
});

describe('config index exports', () => {
  it('should export all autosave config values', async () => {
    const config = await import('../index');
    expect(config.MIN_AUTOSAVE_DELAY_MS).toBeDefined();
    expect(config.MAX_AUTOSAVE_DELAY_MS).toBeDefined();
    expect(config.AUTOSAVE_CHECK_DELAY_MS).toBeDefined();
    expect(config.AUTOSAVE_RETRY_DELAY_MS).toBeDefined();
  });

  it('should export all display config values', async () => {
    const config = await import('../index');
    expect(config.MAX_OUTPUT_LINES).toBeDefined();
    expect(config.MAX_OUTPUT_CHARS).toBeDefined();
    expect(config.DEFAULT_CELL_HEIGHT_PX).toBeDefined();
    expect(config.OUTPUT_MIN_HEIGHT_PX).toBeDefined();
    expect(config.OUTPUT_DEFAULT_HEIGHT_PX).toBeDefined();
    expect(config.OUTPUT_MAX_HEIGHT_PX).toBeDefined();
  });

  it('should export all polling config values', async () => {
    const config = await import('../index');
    expect(config.DIRECTORY_POLL_INTERVAL_MS).toBeDefined();
    expect(config.WEBSOCKET_RECONNECT_INTERVAL_MS).toBeDefined();
    expect(config.MTIME_TOLERANCE_SECONDS).toBeDefined();
  });

});
