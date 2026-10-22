import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatDocumentTitle, useDocumentTitle } from './use-document-title.js';

describe('document title', () => {
  it('joins the parts from specific to general and ends with the brand', () => {
    expect(formatDocumentTitle(['index.js', 'Hello World'])).toBe(
      'index.js · Hello World · Workspace',
    );
    expect(formatDocumentTitle(['Projects'])).toBe('Projects · Workspace');
  });

  it('skips parts that are not loaded yet and marks unsaved work', () => {
    expect(formatDocumentTitle([undefined, '', 'Hello World'])).toBe('Hello World · Workspace');
    expect(formatDocumentTitle(['index.js', 'Hello World'], { dirty: true })).toBe(
      '● index.js · Hello World · Workspace',
    );
  });

  it('writes document.title and follows changes', () => {
    const { rerender } = renderHook(({ parts }) => useDocumentTitle(parts), {
      initialProps: { parts: ['Sign in'] },
    });
    expect(document.title).toBe('Sign in · Workspace');
    rerender({ parts: ['Account'] });
    expect(document.title).toBe('Account · Workspace');
  });
});
