import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CANDIDATE_PORTS,
  isPreviewCandidatePort,
  previewHost,
  previewStateSchema,
  projectIdFromPreviewHost,
} from './preview.js';

/**
 * Where a preview lives.
 *
 * The hostname is the security boundary: one per project means one origin per
 * project, so a project cannot script the platform and cannot script another
 * project. Everything here is about reading and writing that name exactly.
 */

const PROJECT = '018f0000-0000-7000-8000-0000000000aa';
const SUFFIX = 'localhost:4100';

describe('the preview hostname', () => {
  it('gives each project its own', () => {
    expect(previewHost(PROJECT, SUFFIX)).toBe(`${PROJECT}.${SUFFIX}`);
    expect(previewHost('other', SUFFIX)).not.toBe(previewHost(PROJECT, SUFFIX));
  });

  it('round-trips a project identifier', () => {
    expect(projectIdFromPreviewHost(previewHost(PROJECT, SUFFIX), SUFFIX)).toBe(PROJECT);
  });

  it('reads a host whatever case it arrives in', () => {
    // A browser may send the Host header capitalised differently from how the
    // link was written.
    expect(projectIdFromPreviewHost(`${PROJECT.toUpperCase()}.LOCALHOST:4100`, SUFFIX)).toBe(
      PROJECT,
    );
  });

  it('refuses a name that is not one label under the suffix', () => {
    // A deeper name is a different host, and treating it as a project would
    // accept addresses the platform does not serve.
    for (const host of [
      'localhost:4100',
      '.localhost:4100',
      `a.${PROJECT}.localhost:4100`,
      `${PROJECT}.localhost`,
      `${PROJECT}.evil.example`,
      `${PROJECT}.localhost:4100.evil.example`,
      '',
    ]) {
      expect(projectIdFromPreviewHost(host, SUFFIX)).toBeUndefined();
    }
  });

  it('refuses a suffix that merely ends the same way', () => {
    // "notlocalhost:4100" ends with "localhost:4100" as text but is a
    // different host, and the dot is what makes the difference.
    expect(projectIdFromPreviewHost('notlocalhost:4100', SUFFIX)).toBeUndefined();
  });
});

describe('the ports the platform watches', () => {
  it('is a fixed list, not a scan', () => {
    // Publishing a bounded set is what lets the platform find an application
    // without opening a container to anything else.
    expect(PREVIEW_CANDIDATE_PORTS.length).toBeGreaterThan(0);
    expect(PREVIEW_CANDIDATE_PORTS.length).toBeLessThan(12);
  });

  it('recognises a port it watches, and one it does not', () => {
    expect(isPreviewCandidatePort(3000)).toBe(true);
    expect(isPreviewCandidatePort(9999)).toBe(false);
  });

  it('lists no port twice', () => {
    expect(new Set(PREVIEW_CANDIDATE_PORTS).size).toBe(PREVIEW_CANDIDATE_PORTS.length);
  });
});

describe('what the client is told', () => {
  it('can say there is nothing to show, and why', () => {
    const parsed = previewStateSchema.parse({
      url: null,
      port: null,
      reason: 'Start the project to see a preview of it.',
      candidatePorts: [3000],
      framable: false,
    });
    expect(parsed.url).toBeNull();
    expect(parsed.reason).not.toBeNull();
  });

  it('carries the ports it looked at, so nothing found can be explained', () => {
    const parsed = previewStateSchema.parse({
      url: null,
      port: null,
      reason: 'Nothing is listening yet.',
      candidatePorts: [...PREVIEW_CANDIDATE_PORTS],
      framable: true,
    });
    expect(parsed.candidatePorts).toEqual([...PREVIEW_CANDIDATE_PORTS]);
  });

  it('refuses a state with neither an address nor a reason', () => {
    expect(
      previewStateSchema.safeParse({ url: null, port: null, candidatePorts: [], framable: true })
        .success,
    ).toBe(false);
  });

  it('says whether the workspace can show it inside itself', () => {
    // A preview is on its own site, so its cookie is a third-party one in a
    // frame. Whether a browser will send it is a fact about the installation,
    // not something a client should guess.
    const parsed = previewStateSchema.parse({
      url: 'https://p.example/',
      port: 3000,
      reason: null,
      candidatePorts: [3000],
      framable: true,
    });
    expect(parsed.framable).toBe(true);
  });
});
