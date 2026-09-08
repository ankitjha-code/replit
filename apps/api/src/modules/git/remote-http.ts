import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';

/**
 * The only way this platform makes a request to an address a user typed.
 *
 * A git remote is a URL somebody pasted, and the control plane is what fetches
 * it. Without care that is a server-side request forgery: point a remote at
 * `http://169.254.169.254/` or `http://localhost:5432/` and the platform makes
 * the request from inside the network on the user's behalf, then reports what
 * came back.
 *
 * ## Checked when connecting, not when saving
 *
 * Validating the hostname when the remote is saved does not work: a name can
 * resolve to a public address when saved and a private one a minute later. So
 * the check is in the socket's own address lookup, on every connection,
 * including every redirect — the address that is checked is the address that is
 * dialled.
 *
 * ## Bounded
 *
 * A response is cut off past a byte limit and a request past a time limit. A
 * remote is somebody else's server and may be slow or enormous on purpose.
 */

export interface RemoteHttpOptions {
  /** Allow `http://`. Off unless an operator turned it on. */
  allowInsecure: boolean;
  /** Allow private, loopback and link-local addresses, for a self-hosted forge on the same network. */
  allowPrivateAddresses: boolean;
  /** The most one response may carry. */
  maxResponseBytes: number;
  timeoutMs: number;
}

export class RemoteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteRefusedError';
  }
}

/** Addresses no user-supplied URL may reach unless the operator says otherwise. */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Whether an address is one only the local network should be able to reach. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4 address written as IPv6 is checked as what it is.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** Refuses a URL the platform should never request, before anything is dialled. */
export function checkRemoteUrl(raw: string, options: RemoteHttpOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteRefusedError('That is not a web address.');
  }
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new RemoteRefusedError(
      options.allowInsecure
        ? 'A remote must be an http or https address.'
        : 'A remote must be an https address.',
    );
  }
  if (url.username || url.password) {
    // Credentials in the address would be stored and shown with it. They go in
    // the token field, which is encrypted and never returned.
    throw new RemoteRefusedError(
      'Put the username and token in their own fields, not the address.',
    );
  }
  return url;
}

/**
 * The lookup the socket uses, which refuses private answers.
 *
 * Every address a name resolves to is checked, and the connection is refused
 * if any is private: a name with one public and one private record could
 * otherwise be dialled at the private one.
 */
function guardedLookup(options: RemoteHttpOptions): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      if (!options.allowPrivateAddresses && list.some((entry) => isPrivateAddress(entry.address))) {
        callback(
          new RemoteRefusedError(
            `${hostname} points at a private address, which this installation does not allow remotes to reach.`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      if (lookupOptions.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        return;
      }
      const first = list[0];
      if (!first) {
        callback(new Error(`${hostname} did not resolve`) as NodeJS.ErrnoException, '', 0);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** An isomorphic-git HTTP client that goes only where it is allowed to. */
export function createRemoteHttp(options: RemoteHttpOptions): HttpClient {
  const lookup = guardedLookup(options);

  return {
    async request(input: GitHttpRequest): Promise<GitHttpResponse> {
      const url = checkRemoteUrl(input.url, options);

      /*
       * A literal address never goes through a lookup, so it is checked here.
       * `new URL` keeps the brackets on an IPv6 host.
       */
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !options.allowPrivateAddresses && isPrivateAddress(host)) {
        throw new RemoteRefusedError(
          'That address is private, which this installation does not allow remotes to reach.',
        );
      }

      const body: Buffer[] = [];
      if (input.body) for await (const chunk of input.body) body.push(Buffer.from(chunk));

      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = send(
          url,
          {
            method: input.method ?? 'GET',
            headers: input.headers ?? {},
            lookup,
            timeout: options.timeoutMs,
          },
          resolve,
        );
        req.on('timeout', () =>
          req.destroy(new RemoteRefusedError('The remote took too long to answer.')),
        );
        req.on('error', reject);
        if (body.length > 0) req.write(Buffer.concat(body));
        req.end();
      });

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }

      return {
        url: input.url,
        method: input.method ?? 'GET',
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
        headers,
        body: bounded(response, options.maxResponseBytes),
      };
    },
  };
}

/** The response body, stopped with an error once it passes the limit. */
async function* bounded(
  response: IncomingMessage,
  limit: number,
): AsyncIterableIterator<Uint8Array> {
  let seen = 0;
  for await (const chunk of response) {
    const bytes = chunk as Buffer;
    seen += bytes.byteLength;
    if (seen > limit) {
      response.destroy();
      throw new RemoteRefusedError(
        'The remote sent more than this installation will accept for one repository.',
      );
    }
    yield new Uint8Array(bytes);
  }
}
