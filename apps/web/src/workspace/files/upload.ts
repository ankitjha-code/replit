import { PATH_PROBLEM_MESSAGES, joinPath, normalizePath } from '@platform/shared';
import { ApiError } from '../../lib/api-client.js';
import { formatBytes, formatCount } from '../../lib/format.js';

/**
 * Uploading files from the person's device into the project (design spec 9.4).
 *
 * The API's default per-file limit (FILE_MAX_BYTES, 1 MB). A file travels as
 * base64 inside a JSON body, and the API sizes that route's body limit from
 * FILE_MAX_BYTES, so a file this big fits on the wire. Refusing a bigger one
 * here, with the reason, beats a request that fails after the upload. An
 * installation that sets a lower limit answers with its own message, which
 * comes back as the failure for that file.
 */
export const UPLOAD_MAX_BYTES = 1024 * 1024;

export interface UploadItem {
  /** Where it goes in the project. */
  path: string;
  file: Blob;
}

export interface UploadRefusal {
  name: string;
  reason: string;
}

export type UploadProgress = (done: number, total: number, current: string | undefined) => void;

export interface UploadOutcome {
  uploaded: string[];
  failed: UploadRefusal[];
}

/** Which of the chosen files can be sent, and why the others cannot. */
export function planUpload(
  files: readonly File[],
  directory: string,
): { items: UploadItem[]; refused: UploadRefusal[] } {
  const items: UploadItem[] = [];
  const refused: UploadRefusal[] = [];

  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      refused.push({
        name: file.name,
        reason: `Larger than ${formatBytes(UPLOAD_MAX_BYTES)}, the most one upload can carry.`,
      });
      continue;
    }
    const validated = normalizePath(joinPath(directory, file.name));
    if (!validated.ok) {
      refused.push({
        name: file.name,
        reason: PATH_PROBLEM_MESSAGES[validated.problem ?? 'empty'],
      });
      continue;
    }
    items.push({ path: validated.path!, file });
  }

  return { items, refused };
}

/**
 * Sends the files one at a time.
 *
 * One at a time so the progress says which file is moving, and so one large
 * batch cannot hold every connection the browser has. A failure is recorded
 * and the rest still go: one refused file should not cost the others.
 */
export async function uploadAll(
  items: readonly UploadItem[],
  send: (item: UploadItem) => Promise<unknown>,
  onProgress?: UploadProgress,
): Promise<UploadOutcome> {
  const uploaded: string[] = [];
  const failed: UploadRefusal[] = [];

  for (const [index, item] of items.entries()) {
    onProgress?.(index, items.length, item.path);
    try {
      await send(item);
      uploaded.push(item.path);
    } catch (cause) {
      failed.push({
        name: item.path,
        reason: cause instanceof ApiError ? cause.message : 'It could not be uploaded.',
      });
    }
  }
  onProgress?.(items.length, items.length, undefined);

  return { uploaded, failed };
}

/** The toast that ends an upload: what arrived, and what did not and why. */
export function describeUpload(
  outcome: UploadOutcome,
  refused: readonly UploadRefusal[],
): { tone: 'success' | 'warn' | 'danger'; title: string; description?: string } {
  const problems = [...refused, ...outcome.failed];
  const sent = outcome.uploaded.length;

  const title =
    sent === 1 && problems.length === 0
      ? `Uploaded ${baseNameOf(outcome.uploaded[0]!)}`
      : sent === 0
        ? problems.length === 1
          ? `${problems[0]!.name} was not uploaded`
          : 'Nothing was uploaded'
        : `Uploaded ${formatCount(sent, 'file')}`;

  if (problems.length === 0) return { tone: 'success', title };

  // The title already names a lone refused file; otherwise each reason needs its name.
  const description =
    sent === 0 && problems.length === 1
      ? problems[0]!.reason
      : problems.map((problem) => `${problem.name}: ${problem.reason}`).join(' ');
  return { tone: sent === 0 ? 'danger' : 'warn', title, description };
}

function baseNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}
