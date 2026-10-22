import { detectRuntime, RUNTIME_DEFINITIONS } from '@platform/shared';
import { describe, expect, it } from 'vitest';
import { findStarter, README_GUIDE, slugify, STARTER_TEMPLATES } from './starter-templates.js';

const runnable = STARTER_TEMPLATES.filter((template) => template.language !== null);

describe('starter templates', () => {
  it('offers Blank plus one starter per runtime, named from the catalogue', () => {
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual([
      'blank',
      'node',
      'python',
      'go',
      'ruby',
      'static',
    ]);
    expect(findStarter('node')?.name).toBe('Node.js 22');
    expect(findStarter('static')?.name).toBe(
      `${RUNTIME_DEFINITIONS.static.displayName} ${RUNTIME_DEFINITIONS.static.version}`,
    );
    expect(findStarter('blank')?.files('x')).toEqual([]);
  });

  it.each(runnable.map((template) => [template.id, template] as const))(
    'detectRuntime picks %s from its files on first paint',
    (_id, template) => {
      const paths = template.files('Hello World').map((file) => file.path);
      expect(detectRuntime(paths)?.language).toBe(template.language);
      expect(paths).toContain(template.entryFile);
    },
  );

  it('prints the port every runnable starter listens on', () => {
    for (const template of runnable) {
      if (template.runCommand === null) continue;
      const entry = template.files('Hello World').find((file) => file.path === template.entryFile);
      expect(entry?.content, template.id).toContain('Listening on http://localhost:');
      expect(entry?.content, template.id).toContain(String(template.port));
    }
    expect(findStarter('static')).toMatchObject({ runCommand: null, port: 8080 });
  });

  it('uses Ruby stdlib TCPServer so no gem is needed on the slim image', () => {
    const app = findStarter('ruby')
      ?.files('x')
      .find((file) => file.path === 'app.rb');
    expect(app?.content).toContain('require "socket"');
    expect(app?.content).toContain('TCPServer.new');
    expect(app?.content).not.toContain('webrick');
  });

  it('writes valid JSON manifests and a README with the guide sentence', () => {
    for (const template of STARTER_TEMPLATES) {
      for (const file of template.files('My "Quoted" <App>')) {
        if (file.path.endsWith('.json')) expect(() => JSON.parse(file.content)).not.toThrow();
        if (file.path === 'README.md') expect(file.content).toContain(README_GUIDE);
      }
    }
    expect(JSON.parse(findStarter('node')!.files('My App').at(0)!.content)).toMatchObject({
      name: 'my-app',
      scripts: { start: 'node index.js' },
    });
  });

  it('escapes the project name where it is embedded in code', () => {
    const files = findStarter('static')!.files('A & B <c>');
    expect(files.find((file) => file.path === 'index.html')?.content).toContain(
      '<h1>A &amp; B &lt;c&gt;</h1>',
    );
    const index = findStarter('node')!
      .files('Say "hi"')
      .find((file) => file.path === 'index.js');
    expect(index?.content).toContain('const name = "Say \\"hi\\"";');
  });

  it('slugifies names for package.json and go.mod', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('***')).toBe('app');
    expect(findStarter('go')!.files('Hello World').at(0)?.content).toBe(
      'module hello-world\n\ngo 1.23\n',
    );
  });
});
