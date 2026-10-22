import { RUNTIME_DEFINITIONS, type RuntimeLanguage } from '@platform/shared';

/**
 * The files a new project starts with.
 *
 * Client side and deliberately small: after the project is created, the
 * dialog writes these through the ordinary files API, so nothing on the
 * server knows about templates. Every runnable starter is a stdlib HTTP
 * server that prints the port it listens on, because the first thing a new
 * person needs to see is the preview appearing.
 */

export type StarterId = 'blank' | 'node' | 'python' | 'go' | 'ruby' | 'static';

export interface StarterFile {
  path: string;
  content: string;
}

export interface StarterTemplate {
  id: StarterId;
  /** "Node.js 22", from the runtime catalogue so the version never drifts. */
  name: string;
  description: string;
  /** Null for Blank, which starts with no files and so no detected runtime. */
  language: RuntimeLanguage | null;
  /** Saved through the run-command endpoint; null when the runtime serves the files itself. */
  runCommand: string | null;
  /** The port the starter listens on, for the preview and the test. Null for Blank. */
  port: number | null;
  /** Opened in the editor once the files are written. */
  entryFile: string | null;
  files: (projectName: string) => StarterFile[];
}

export const README_GUIDE =
  'Press Start (top left) to start the environment, then Run in the console to start the app. The preview appears when the app listens on a port. Change the run command in the console.';

function readme(projectName: string): StarterFile {
  return { path: 'README.md', content: `# ${projectName}\n\n${README_GUIDE}\n` };
}

/** A name safe for package.json, go.mod and a URL: lower case, dashes, never empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'app';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runtimeName(language: RuntimeLanguage): string {
  const definition = RUNTIME_DEFINITIONS[language];
  return `${definition.displayName} ${definition.version}`;
}

const node: StarterTemplate = {
  id: 'node',
  name: runtimeName('node'),
  description: 'A small HTTP server on the standard library.',
  language: 'node',
  runCommand: 'npm start',
  port: 3000,
  entryFile: 'index.js',
  files: (projectName) => [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: slugify(projectName),
          private: true,
          type: 'module',
          scripts: { start: 'node index.js' },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'index.js',
      // JSON.stringify makes a valid JS string literal out of any project name.
      content: `import { createServer } from 'node:http';

const name = ${JSON.stringify(projectName)};
const port = Number(process.env.PORT ?? 3000);

createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(\`Hello from \${name}! You asked for \${request.url}\\n\`);
}).listen(port, () => {
  console.log(\`Listening on http://localhost:\${port}\`);
});
`,
    },
    readme(projectName),
    { path: '.gitignore', content: 'node_modules/\n' },
  ],
};

const python: StarterTemplate = {
  id: 'python',
  name: runtimeName('python'),
  description: 'A small HTTP server on the standard library.',
  language: 'python',
  runCommand: 'python main.py',
  port: 8000,
  entryFile: 'main.py',
  files: (projectName) => [
    {
      path: 'main.py',
      content: `import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"Hello from Python! You asked for {self.path}\\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"Listening on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`,
    },
    {
      path: 'requirements.txt',
      content: '# Add one package per line, then run: pip install -r requirements.txt\n',
    },
    readme(projectName),
  ],
};

const go: StarterTemplate = {
  id: 'go',
  name: runtimeName('go'),
  description: 'A small HTTP server on net/http.',
  language: 'go',
  runCommand: 'go run .',
  port: 8080,
  entryFile: 'main.go',
  files: (projectName) => [
    { path: 'go.mod', content: `module ${slugify(projectName)}\n\ngo 1.23\n` },
    {
      path: 'main.go',
      content: `package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello from Go! You asked for %s\\n", r.URL.Path)
	})
	log.Println("Listening on http://localhost:" + port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
`,
    },
    readme(projectName),
  ],
};

const ruby: StarterTemplate = {
  id: 'ruby',
  name: runtimeName('ruby'),
  description: 'A small HTTP server on the standard library.',
  language: 'ruby',
  runCommand: 'ruby app.rb',
  port: 4567,
  entryFile: 'app.rb',
  files: (projectName) => [
    {
      path: 'app.rb',
      // TCPServer rather than WEBrick: the slim Ruby image does not ship WEBrick,
      // and a starter should run before anyone installs a gem.
      content: `require "socket"

port = (ENV["PORT"] || "4567").to_i
server = TCPServer.new("0.0.0.0", port)
$stdout.sync = true
puts "Listening on http://localhost:#{port}"

loop do
  client = server.accept
  request_line = client.gets || ""
  path = request_line.split(" ")[1] || "/"
  # Drain the headers so the client sees a complete exchange.
  while (line = client.gets) && line != "\\r\\n"
  end
  body = "Hello from Ruby! You asked for #{path}\\n"
  client.print "HTTP/1.1 200 OK\\r\\n"
  client.print "Content-Type: text/plain; charset=utf-8\\r\\n"
  client.print "Content-Length: #{body.bytesize}\\r\\n"
  client.print "Connection: close\\r\\n\\r\\n"
  client.print body
  client.close
end
`,
    },
    { path: 'Gemfile', content: 'source "https://rubygems.org"\n' },
    readme(projectName),
  ],
};

const staticSite: StarterTemplate = {
  id: 'static',
  name: runtimeName('static'),
  description: 'HTML, CSS and a script, served as they are.',
  language: 'static',
  runCommand: null,
  port: 8080,
  entryFile: 'index.html',
  files: (projectName) => [
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(projectName)}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>${escapeHtml(projectName)}</h1>
    <p>This page is served straight from your files. Edit index.html and reload the preview.</p>
    <p id="clock"></p>
    <script src="script.js"></script>
  </body>
</html>
`,
    },
    {
      path: 'style.css',
      content: `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  background: #ffffff;
  color: #1a1a1a;
}
@media (prefers-color-scheme: dark) {
  :root {
    background: #141619;
    color: #e6e9ed;
  }
}
body {
  margin: 0 auto;
  max-width: 40rem;
  padding: 2rem 1rem;
}
`,
    },
    {
      path: 'script.js',
      content: `const clock = document.getElementById('clock');
const tick = () => {
  clock.textContent = \`The time is \${new Date().toLocaleTimeString()}\`;
};
tick();
setInterval(tick, 1000);
`,
    },
    readme(projectName),
  ],
};

const blank: StarterTemplate = {
  id: 'blank',
  name: 'Blank',
  description: 'An empty project. Add files and the runtime is detected from them.',
  language: null,
  runCommand: null,
  port: null,
  entryFile: null,
  files: () => [],
};

/** In the order the picker shows them. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  blank,
  node,
  python,
  go,
  ruby,
  staticSite,
];

export function findStarter(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
