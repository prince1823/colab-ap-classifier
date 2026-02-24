import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReviewPage } from '../../src/renderer/components/review/ReviewPage';

const SAMPLE_CSV = `supplier_name,gl_description,line_description,amount,L1,L2,L3,L4,cumulative_spend_percentile,override_rule_applied,invoice_key
massey services,6600:repair & maintenance,commm pest prevention /3035 lakeland,53.5,non clinical,facilities,facilities maintenance services,pest control,0.8,,inv1
cintas corporation,6350:other expenses,"lab coats, gowns, scrubs",10000,non clinical,facilities,mro supplies,uniforms,0.3,manual_reclassification,inv2
`;

describe('ReviewPage integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => SAMPLE_CSV,
    })) as unknown as typeof fetch);
  });

  it('updates metrics when filters are applied', async () => {
    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/Classification Taxonomy/i)).toBeInTheDocument(),
    );

    const initialFilteredRowsCard = screen.getByText(/Filtered Rows/).closest(
      '.metric-card',
    )!;
    const initialValue = initialFilteredRowsCard.querySelector(
      '.metric-value',
    )!.textContent;

    const addFilterButton = screen.getByText('+ Add Filter');
    fireEvent.click(addFilterButton);

    const valueInput = screen.getByPlaceholderText('Value');
    fireEvent.change(valueInput, { target: { value: 'massey' } });

    await waitFor(() => {
      const card = screen.getByText(/Filtered Rows/).closest('.metric-card')!;
      const value = card.querySelector('.metric-value')!.textContent;
      expect(value).not.toEqual(initialValue);
    });
  });

  it('applies tail spend threshold when toggle is enabled', async () => {
    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/massey services/i)).toBeInTheDocument(),
    );

    const thresholdInput = screen.getByDisplayValue('10000');
    fireEvent.change(thresholdInput, { target: { value: '60' } });

    const hideTailCheckbox = screen.getByLabelText(
      /Hide tail spend suppliers/i,
    ) as HTMLInputElement;
    fireEvent.click(hideTailCheckbox);

    await waitFor(() =>
      expect(screen.queryByText(/massey services/i)).not.toBeInTheDocument(),
    );
  });
});

