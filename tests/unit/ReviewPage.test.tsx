import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReviewPage } from '../../src/renderer/components/review/ReviewPage';

const SAMPLE_CSV = `supplier_name,gl_description,line_description,amount,L1,L2,L3,L4,cumulative_spend_percentile,override_rule_applied,invoice_key
massey services,6600:repair & maintenance,commm pest prevention /3035 lakeland,53.5,non clinical,facilities,facilities maintenance services,pest control,0.8,,inv1
cintas corporation,6350:other expenses,"lab coats, gowns, scrubs",48.07,non clinical,facilities,mro supplies,uniforms,0.3,manual_reclassification,inv2
`;

describe('ReviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => SAMPLE_CSV,
    })) as unknown as typeof fetch);
  });

  it('renders table rows from CSV', async () => {
    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/Classification Taxonomy/i)).toBeInTheDocument(),
    );

    expect(screen.getByText(/massey services/i)).toBeInTheDocument();
    expect(screen.getByText(/cintas corporation/i)).toBeInTheDocument();
  });

  it('allows toggling columns via column selector', async () => {
    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/massey services/i)).toBeInTheDocument(),
    );

    const summary = screen.getByText('Columns');
    fireEvent.click(summary);

    const supplierCheckbox = screen.getByLabelText('Supplier Name') as HTMLInputElement;
    expect(supplierCheckbox.checked).toBe(true);

    fireEvent.click(supplierCheckbox);
    await waitFor(() =>
      expect(screen.queryByText('Supplier Name')).not.toBeInTheDocument(),
    );
  });

  it('can add a filter and reduce visible rows', async () => {
    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/massey services/i)).toBeInTheDocument(),
    );

    const addFilterButton = screen.getByText('+ Add Filter');
    fireEvent.click(addFilterButton);

    const valueInput = screen.getByPlaceholderText('Value');
    fireEvent.change(valueInput, { target: { value: 'massey' } });

    await waitFor(() =>
      expect(screen.queryByText(/cintas corporation/i)).not.toBeInTheDocument(),
    );
  });
});

