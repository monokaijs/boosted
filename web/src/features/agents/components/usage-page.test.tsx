import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '@/lib/api-context';
import { createBoostedApiClient } from '@/lib/api';
import { UsagePage } from './usage-page';
import type { AgentUsage } from '../lib/usage';

const mock = vi.hoisted(() => ({ usage: vi.fn(), featureRequest: vi.fn() }));
vi.mock('../lib/api-client', () => ({ apiClient: { assistant: mock } }));
const today = new Date();
const data: AgentUsage = { trackedSince: today.toISOString(), series: [
  { agentId: 'pock', name: 'Pock', buckets: [{ startDate: today.toISOString(), tokens: 120 }] },
  { agentId: 'sage', name: 'Sage', buckets: [{ startDate: today.toISOString(), tokens: 80 }] },
] };

function renderPage(props: React.ComponentProps<typeof UsagePage> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ApiClientProvider client={{ ...createBoostedApiClient({ profile: { id: "usage-test", baseUrl: "http://localhost" }, getToken: () => undefined }), featureRequest: mock.featureRequest }}><UsagePage {...props} /></ApiClientProvider></QueryClientProvider>);
}
afterEach(cleanup);
beforeEach(() => { mock.featureRequest.mockReset(); mock.usage.mockReset(); mock.usage.mockResolvedValue(data); });

describe('usage page', () => {
  it('shows cached input as a subset and charts the selected metric', async () => {
    mock.usage.mockResolvedValue({ trackedSince: today.toISOString(), series: [{ agentId: 'pock', name: 'Pock', buckets: [{ startDate: today.toISOString(), tokens: 120, inputTokens: 100, cachedTokens: 60, outputTokens: 20, detailedTokens: 120 }] }] });
    renderPage({ embedded: true });
    await screen.findByText('Cached tokens');
    await waitFor(() => expect(screen.getByText('Cached tokens').parentElement).toHaveTextContent('60'));
    expect(screen.getByText('Total tokens').parentElement).toHaveTextContent('120');
    fireEvent.click(screen.getByRole('button', { name: 'Cached' }));
    const chart = await screen.findByRole('img', { name: /Daily token usage by agent · cached/ });
    expect(chart.querySelector('polyline')).not.toBeNull();
    expect(within(screen.getByRole('group', { name: 'Agent series' })).getByRole('button', { name: /Pock/ })).toHaveTextContent('60');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('keeps old cached-token breakdowns unavailable rather than displaying zero', async () => {
    renderPage();
    await screen.findByText('Cached tokens');
    expect(screen.getByText('Cached tokens').parentElement).toHaveTextContent('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Cached' }));
    expect(await screen.findByText('Token breakdown unavailable for these records.')).toBeInTheDocument();
  });

  it('fetches only the selected group and range with the scoped client', async () => {
    mock.featureRequest.mockResolvedValue(data);
    renderPage({ embedded: true, groupId: 'group/a' });
    await screen.findByRole('slider', { name: 'Inspect day' });
    expect(mock.featureRequest).toHaveBeenCalledWith('/groups/group%2Fa/usage?days=30');
    expect(mock.usage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(mock.featureRequest).toHaveBeenCalledWith('/groups/group%2Fa/usage?days=7'));
  });

  it('renders one series per agent, toggles visibility, and exposes daily values to keyboard users', async () => {
    renderPage();
    const chart = await screen.findByRole('img', { name: /Daily token usage by agent/ });
    expect(chart.querySelectorAll('polyline')).toHaveLength(2);
    expect(screen.getByText('200', { selector: 'strong' })).toBeInTheDocument();
    const legend = screen.getByRole('group', { name: 'Agent series' });
    fireEvent.click(within(legend).getByRole('button', { name: /Pock/ }));
    expect(chart.querySelectorAll('polyline')).toHaveLength(1);
    expect(within(legend).getByRole('button', { name: /Pock/ })).toHaveAttribute('aria-pressed', 'false');
    const slider = screen.getByRole('slider', { name: 'Inspect day' });
    fireEvent.change(slider, { target: { value: '28' } });
    expect(slider).toHaveValue('28');
    expect(slider).toHaveAttribute('aria-valuetext');
    expect(screen.getByText('0', { selector: 'b' })).toBeInTheDocument();
    fireEvent.click(within(legend).getByRole('button', { name: /Pock/ }));
    expect(chart.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('fetches the chosen date range and resets day inspection', async () => {
    renderPage();
    await screen.findByRole('slider', { name: 'Inspect day' });
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(mock.usage).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('slider', { name: 'Inspect day' })).toHaveValue('6');
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an honest empty state when no historical tokens were recorded', async () => {
    mock.usage.mockResolvedValue({ trackedSince: null, series: [{ agentId: 'pock', name: 'Pock', buckets: [] }] });
    renderPage();
    expect(await screen.findByText('No recorded usage in this period.')).toBeInTheDocument();
    expect(screen.getByText(/earlier usage is unavailable/)).toBeInTheDocument();
  });

  it('allows retrying a failed request', async () => {
    mock.usage.mockRejectedValueOnce(new Error('Disconnected'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: /Daily token usage by agent/ })).toBeInTheDocument();
  });
});
