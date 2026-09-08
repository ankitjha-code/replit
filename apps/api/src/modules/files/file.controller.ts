import type { Request, Response } from 'express';
import type {
  CreateDirectoryRequest,
  FileContentResponse,
  FileTreeResponse,
  MovePathRequest,
  SearchResponse,
  WriteFileRequest,
} from '@platform/shared';
import { AppError } from '../../errors/app-error.js';
import { requireProjectAccess } from '../../http/middleware/authorize-project.js';
import type { FileService } from './file.service.js';

/**
 * Translates between HTTP and the file service.
 *
 * Paths arrive in a query parameter for reads and deletes, and in the body for
 * writes. They are not route segments: a path contains separators, and
 * encoding one into a segment means every layer between the browser and the
 * router has to agree about escaping. A query parameter has one obvious
 * meaning.
 */
export class FileController {
  constructor(private readonly files: FileService) {}

  tree = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: FileTreeResponse = await this.files.listTree(project.id);
    res.status(200).json(body);
  };

  read = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const body: FileContentResponse = await this.files.read(project.id, requirePath(req));
    res.status(200).json(body);
  };

  write = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const input = req.body as WriteFileRequest;

    const entry = await this.files.write(project.id, {
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });

    res.status(200).json({ entry });
  };

  createDirectory = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const input = req.body as CreateDirectoryRequest;
    const entry = await this.files.createDirectory(project.id, input.path);
    res.status(201).json({ entry });
  };

  move = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const input = req.body as MovePathRequest;
    const entry = await this.files.move(project.id, input.from, input.to);
    res.status(200).json({ entry });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    await this.files.remove(project.id, requirePath(req));
    res.status(204).end();
  };

  search = async (req: Request, res: Response): Promise<void> => {
    const { project } = requireProjectAccess(req);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const body: SearchResponse = await this.files.search(project.id, query);
    res.status(200).json(body);
  };
}

/**
 * The path from the query string.
 *
 * A repeated parameter is refused rather than having one arbitrarily chosen,
 * because which one wins would then depend on the parser rather than on
 * anything the caller decided.
 */
function requirePath(req: Request): string {
  const value = req.query.path;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A path is required', {
      details: { fields: [{ path: 'path', message: 'Provide a file path' }] },
    });
  }
  return value;
}
