/**
 * Adaptive polling utility with exponential backoff
 *
 * Starts with fast intervals (50ms) and gradually increases to max (1000ms)
 * to balance responsiveness for quick operations with efficiency for long waits.
 */

export interface PollerConfig {
  /** Initial polling interval in milliseconds (default: 50) */
  initialInterval?: number;
  /** Maximum polling interval in milliseconds (default: 1000) */
  maxInterval?: number;
  /** Backoff multiplier (default: 2 for exponential) */
  backoffFactor?: number;
}

export class AdaptivePoller {
  private currentInterval: number;
  private config: Required<PollerConfig>;

  constructor(config: PollerConfig = {}) {
    this.config = {
      initialInterval: config.initialInterval ?? 50,
      maxInterval: config.maxInterval ?? 1000,
      backoffFactor: config.backoffFactor ?? 2
    };
    this.currentInterval = this.config.initialInterval;
  }

  /**
   * Get current polling interval in milliseconds
   */
  getCurrentInterval(): number {
    return this.currentInterval;
  }

  /**
   * Increase polling interval using exponential backoff
   */
  incrementInterval(): void {
    this.currentInterval = Math.min(
      this.currentInterval * this.config.backoffFactor,
      this.config.maxInterval
    );
  }

  /**
   * Reset polling interval to initial value
   */
  reset(): void {
    this.currentInterval = this.config.initialInterval;
  }

  /**
   * Async sleep for current interval duration
   */
  async wait(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.currentInterval));
  }
}

/**
 * Factory function for creating adaptive pollers
 */
export function createAdaptivePoller(config?: PollerConfig): AdaptivePoller {
  return new AdaptivePoller(config);
}
