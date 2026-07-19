import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ComputeAllocationModal from '../ComputeAllocationModal';
import type { ComputePartitions } from '../../services/computeService';

vi.mock('../../services/onboardingService', () => ({
  markOnboardingStep: vi.fn(),
}));

vi.mock('../../services/computeService', () => ({
  getComputePartitions: vi.fn(),
  getPartitionQos: vi.fn(),
  listAllocations: vi.fn(),
  createAllocation: vi.fn(),
  cancelAllocation: vi.fn(),
}));

import {
  getComputePartitions,
  getPartitionQos,
  listAllocations,
} from '../../services/computeService';

const partitionsFixture: ComputePartitions = {
  enabled: true,
  associations: {
    account: 'lab',
    partitions: ['main'],
    qoses: ['normal'],
    defaultQos: 'normal',
  },
  load: {
    partitions: [
      {
        name: 'main',
        up: true,
        timeLimit: '7-00:00:00',
        cpus: { alloc: 0, idle: 64, other: 0, total: 64 },
        nodes: { idle: 2, mixed: 0, alloc: 0, down: 0, total: 2 },
        jobs: { pending: 0, running: 0 },
      },
    ],
    qoses: [],
    fetchedAt: 0,
  },
};

/** The number input inside the form field whose label reads `labelText`. */
async function findNumberInput(labelText: string): Promise<HTMLInputElement> {
  const label = await screen.findByText(labelText);
  const input = label.parentElement!.querySelector('input[type="number"]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

describe('ComputeAllocationModal number inputs', () => {
  beforeEach(() => {
    vi.mocked(getComputePartitions).mockResolvedValue(partitionsFixture);
    vi.mocked(getPartitionQos).mockResolvedValue(null as any);
    vi.mocked(listAllocations).mockResolvedValue([]);
  });

  const renderModal = () =>
    render(<ComputeAllocationModal isOpen={true} onClose={() => {}} />);

  it('lets the CPUs field be emptied and retyped from scratch', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');
    expect(cpusInput.value).toBe('4');

    // Clearing must not snap back to the minimum mid-edit
    fireEvent.change(cpusInput, { target: { value: '' } });
    expect(cpusInput.value).toBe('');

    fireEvent.change(cpusInput, { target: { value: '16' } });
    expect(cpusInput.value).toBe('16');

    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('16');
  });

  it('restores the last committed value when the field is left empty', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');

    fireEvent.change(cpusInput, { target: { value: '' } });
    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('4');
  });

  it('clamps below-minimum values on blur, not per keystroke', async () => {
    renderModal();
    const cpusInput = await findNumberInput('CPUs');

    fireEvent.change(cpusInput, { target: { value: '0' } });
    expect(cpusInput.value).toBe('0'); // free to keep typing (e.g. heading for "0" -> "08")

    fireEvent.blur(cpusInput);
    expect(cpusInput.value).toBe('1'); // committed value clamped to min
  });

  it('lets every numeric field in the form be emptied while editing', async () => {
    renderModal();
    for (const labelText of ['Walltime (hours)', 'CPUs', 'Memory (GB)', 'GPUs (0 = none)']) {
      const input = await findNumberInput(labelText);
      fireEvent.change(input, { target: { value: '' } });
      expect(input.value, `${labelText} should stay empty mid-edit`).toBe('');
      fireEvent.blur(input);
      expect(input.value, `${labelText} should restore its value on blur`).not.toBe('');
    }
  });
});
