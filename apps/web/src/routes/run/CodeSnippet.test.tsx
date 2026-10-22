import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeSnippet, HowCodeReadsSection, envSnippet } from './CodeSnippet.js';

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('envSnippet', () => {
  it('names the variable in the idiom of each runtime', () => {
    expect(envSnippet('node', 'API_TOKEN')).toContain('process.env.API_TOKEN');
    expect(envSnippet('python', 'API_TOKEN')).toContain('os.environ["API_TOKEN"]');
    expect(envSnippet('go', 'API_TOKEN')).toContain('os.Getenv("API_TOKEN")');
    expect(envSnippet('ruby', 'API_TOKEN')).toContain('ENV["API_TOKEN"]');
    expect(envSnippet('static', 'API_TOKEN')).toBeUndefined();
  });
});

describe('CodeSnippet', () => {
  it('renders a copyable block for a program', () => {
    render(<CodeSnippet language="node" name="PORT" />);
    expect(screen.getByLabelText('Node.js example')).toHaveTextContent('process.env.PORT');
    expect(screen.getByRole('button', { name: 'Copy node.js example' })).toBeInTheDocument();
  });

  it('explains that a static site reads nothing', () => {
    render(<CodeSnippet language="static" name="PORT" />);
    expect(screen.getByText('A static site has no server code.')).toBeInTheDocument();
  });
});

describe('HowCodeReadsSection', () => {
  it('starts on the language the platform detected and can switch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            runtime: null,
            detected: {
              language: 'python',
              version: '3.12',
              image: 'python:3.12-slim',
              evidence: 'main.py',
            },
            provider: { name: 'docker', available: true, reason: null },
          }),
        ),
      ),
    );
    render(<HowCodeReadsSection projectId={PROJECT} exampleName="DATABASE_URL" />);

    expect(await screen.findByLabelText('Python example')).toHaveTextContent(
      'os.environ["DATABASE_URL"]',
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Go' }));
    expect(screen.getByLabelText('Go example')).toHaveTextContent('os.Getenv("DATABASE_URL")');
  });

  it('falls back to Node.js when nothing was detected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            runtime: null,
            detected: null,
            provider: { name: 'none', available: false, reason: 'No execution backend.' },
          }),
        ),
      ),
    );
    render(<HowCodeReadsSection projectId={PROJECT} />);

    expect(await screen.findByLabelText('Node.js example')).toHaveTextContent(
      'process.env.API_TOKEN',
    );
  });
});
